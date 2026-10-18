"""Postprocess a verified baked GLB with Blender's CPU OpenImageDenoise.

No geometry or source scene is regenerated. Run with Blender 4.5 LTS::

  blender --background --factory-startup --disable-autoexec --python-exit-code 1 \
    --python reconstruction/denoise_lightmap.py -- --input /private/full-diffuse \
    --output /private/denoised --smooth-radius 0 --gutter 2

Use unfiltered Cycles input when possible: OIDN recognizes raw Monte Carlo noise
better than noise already blurred into broad patches. Extra masked smoothing is
available for existing prefiltered atlases. Black padding is preserved except
for the requested bounded gutter extension; original AO alpha is preserved.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reconstruction.bake_indirect import (FULL_PROFILE, PROFILE, decode_own_rgba_png,
                                          glb_document, masked_gaussian_rgb,
                                          preserve_lightmap_rgba, rgba_png, sha256)


def verify_source(source):
    report = json.loads((source / "report.json").read_text())
    if report.get("profile") not in (PROFILE, FULL_PROFILE):
        raise ValueError("Unsupported source bake profile")
    for name in ("scene.glb", "scene.json", "indirect-lightmap.png"):
        if sha256(source / name) != report["files"][name]["sha256"]:
            raise ValueError(f"Source artifact hash mismatch: {name}")
    if sha256(source / "scene.json") != report["inputSha256"]:
        raise ValueError("Source JSON is not bound to the bake")
    if not 0 < report["transport"]["radianceScale"] <= 64:
        raise ValueError("Source radiance scale is invalid")
    document = glb_document(source / "scene.glb")
    for material in document["materials"]:
        if (material.get("extras", {}).get("tadaimaIndirectLightmap") != report["profile"] or
                material.get("emissiveTexture", {}).get("texCoord") != 1):
            raise ValueError("Source GLB lightmap transport differs from its bake report")
    return report


def dilate_rgb_padding(pixels, width, height, iterations):
    """Extend RGB edge colors into gutters without modifying any valid texel."""
    import numpy as np
    rgb = pixels.reshape((height, width, 4))[:, :, :3]
    valid = np.max(rgb, axis=2) > 0
    for _ in range(iterations):
        values = np.pad(rgb, [(1, 1), (1, 1), (0, 0)])
        masks = np.pad(valid, [(1, 1), (1, 1)])
        numerator = np.zeros_like(rgb)
        denominator = np.zeros((height, width), dtype=np.float32)
        for row, column in ((0, 1), (2, 1), (1, 0), (1, 2)):
            mask = masks[row:row + height, column:column + width]
            numerator += values[row:row + height, column:column + width] * mask[:, :, None]
            denominator += mask
        new = (~valid) & (denominator > 0)
        rgb[new] = numerator[new] / denominator[new, None]
        valid |= new


def main():
    import bpy
    import numpy as np
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--smooth-radius", type=int, choices=(0, 2, 4, 6, 8), default=0)
    parser.add_argument("--gutter", type=int, choices=(0, 1, 2, 3, 4), default=2)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    source = args.input.resolve(strict=True)
    output = args.output.resolve()
    if output.exists():
        raise ValueError("Output must be a fresh directory")
    report = verify_source(source)
    scale = report["transport"]["radianceScale"]
    started = time.monotonic()
    output.mkdir(parents=True)
    scene = bpy.context.scene
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    camera = bpy.data.objects.new("DenoiseTriggerCamera", bpy.data.cameras.new("DenoiseTriggerCamera"))
    scene.collection.objects.link(camera)
    scene.camera = camera
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.render.resolution_x = scene.render.resolution_y = 1
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.use_nodes = True
    nodes, links = scene.node_tree.nodes, scene.node_tree.links
    nodes.clear()
    image = bpy.data.images.load(str(source / "indirect-lightmap.png"), check_existing=False)
    image.colorspace_settings.name = "sRGB"
    # Atlas alpha is optional AO data, never transparency or RGB coverage.
    image.alpha_mode = "CHANNEL_PACKED"
    width, height = image.size
    if width != height or width not in (512, 1024, 2048):
        raise ValueError("Source atlas must be square and bounded to 2048 pixels")
    original_pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(original_pixels)
    original = original_pixels.reshape((height, width, 4))
    input_node = nodes.new("CompositorNodeImage")
    input_node.image = image
    hdr = nodes.new("CompositorNodeMixRGB")
    hdr.blend_type = "MULTIPLY"
    hdr.inputs[0].default_value = 1
    hdr.inputs[2].default_value = (scale, scale, scale, 1)
    links.new(input_node.outputs["Image"], hdr.inputs[1])
    denoise = nodes.new("CompositorNodeDenoise")
    denoise.use_hdr = True
    denoise.prefilter = "ACCURATE"
    links.new(hdr.outputs["Image"], denoise.inputs["Image"])
    file_node = nodes.new("CompositorNodeOutputFile")
    file_node.base_path = str(output)
    file_node.format.file_format = "OPEN_EXR"
    file_node.format.color_mode = "RGBA"
    file_node.format.color_depth = "32"
    file_node.file_slots[0].path = "oidn-linear-"
    links.new(denoise.outputs["Image"], file_node.inputs[0])
    print("TADAIMA_OIDN_STARTED", flush=True)
    bpy.ops.render.render()
    exr = next(output.glob("oidn-linear-*.exr"))
    result = bpy.data.images.load(str(exr), check_existing=False)
    result.alpha_mode = "CHANNEL_PACKED"
    if list(result.size) != [width, height]:
        raise RuntimeError("Compositor changed atlas dimensions")
    pixels = np.empty(width * height * 4, dtype=np.float32)
    result.pixels.foreach_get(pixels)
    rgba = pixels.reshape((height, width, 4))
    if not np.isfinite(rgba).all():
        raise RuntimeError("Denoiser produced non-finite samples")
    mask = np.max(original[:, :, :3], axis=2) > 0
    rgba[:, :, :3] = np.where(mask[:, :, None], np.maximum(rgba[:, :, :3] / scale, 0), 0)
    rgba[:, :, 3] = original[:, :, 3]
    masked_gaussian_rgb(pixels, width, height, args.smooth_radius)
    dilate_rgb_padding(pixels, width, height, args.gutter)
    linear = np.clip(rgba[:, :, :3], 0, 1)
    rgba[:, :, :3] = np.where(linear <= .0031308, linear * 12.92,
                              1.055 * np.power(linear, 1 / 2.4) - .055)
    encoded = np.rint(np.clip(rgba[::-1], 0, 1) * 255).astype(np.uint8).tobytes()
    png = output / "indirect-lightmap.png"
    png.write_bytes(rgba_png(width, height, encoded))
    if decode_own_rgba_png(png.read_bytes())[2] != encoded:
        raise RuntimeError("PNG encoding lost pixels")
    shutil.copyfile(source / "scene.glb", output / "scene.glb")
    shutil.copyfile(source / "scene.json", output / "scene.json")
    preserve_lightmap_rgba(output / "scene.glb", png)
    report["postprocess"] = {"method": "OpenImageDenoise via Blender CompositorNodeDenoise",
        "hdr": True, "prefilter": "ACCURATE", "auxiliaryPasses": False,
        "radianceScaleRestoredBeforeDenoise": scale, "maskedSmoothRadiusTexels": args.smooth_radius,
        "gutterExtensionTexels": args.gutter, "originalAoAlphaPreserved": True,
        "sourceGlbSha256": sha256(source / "scene.glb"), "seconds": round(time.monotonic() - started, 3)}
    report["files"] = {name: {"bytes": (output / name).stat().st_size, "sha256": sha256(output / name)}
                       for name in ("scene.glb", "scene.json", "indirect-lightmap.png")}
    report["embeddedAtlasSha256"] = sha256(png)
    report["embeddedAtlasMatchesDecodedSavedPng"] = True
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print("TADAIMA_OIDN_COMPLETE", json.dumps(report["postprocess"]), flush=True)


if __name__ == "__main__":
    main()
