"""Bake portable Cycles diffuse lighting without modifying source geometry.

Run with Blender 4.5 LTS (never with a system bpy package)::

  blender --background --factory-startup --disable-autoexec --python-exit-code 1 \
    --python reconstruction/bake_indirect.py -- --input-blend /private/scene.blend \
    --output /private/new-bake --size 2048 --samples 32 --with-ao

The original JSON is copied byte for byte. A single secondary UV atlas carries
irradiance, exported as an explicitly tagged emissiveTexture transport. The web
viewer must move this texture to lightMap, keep its UV channel, zero emission,
and multiply the decoded map by pi (Cycles' white diffuse bake includes 1/pi).
By default direct light and surface color are excluded to avoid doubling PBR
albedo or locking editable furniture shadows into the architectural shell.
Optional AO occupies the same atlas's alpha channel; it must only attenuate
indirect illumination. The PNG writer performs the sRGB transfer explicitly.

For the fully baked diffuse mode use --full-diffuse --closed-ceiling
--smooth-radius 2 --samples 64. Runtime lighting must suppress its duplicate
diffuse terms on marked materials while retaining specular lighting. A temporary
ceiling is inferred from the source floor and height, then removed before export.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import struct
import sys
import time
import zlib


PROFILE = "cycles-diffuse-indirect-v1"
FULL_PROFILE = "cycles-diffuse-full-v1"
UV_NAME = "TadaimaLightmap"


def masked_gaussian_rgb(pixels, width, height, radius):
    """Smooth sample noise inside valid atlas texels, leaving padding/alpha intact."""
    import numpy as np
    if radius == 0:
        return
    rgba = pixels.reshape((height, width, 4))
    original = rgba[:, :, :3]
    valid = (np.max(original, axis=2) > 1e-8).astype(np.float32)
    numerator = original.copy() * valid[:, :, None]
    denominator = valid.copy()
    kernel = np.array([math.comb(radius * 2, i) for i in range(radius * 2 + 1)], dtype=np.float32)
    kernel /= kernel.sum()
    for axis in (0, 1):
        padding = [(0, 0), (0, 0)]
        padding[axis] = (radius, radius)
        padded_n = np.pad(numerator, padding + [(0, 0)], mode="constant")
        padded_d = np.pad(denominator, padding, mode="constant")
        result_n, result_d = np.zeros_like(numerator), np.zeros_like(denominator)
        for offset, weight in enumerate(kernel):
            selection = [slice(None), slice(None)]
            selection[axis] = slice(offset, offset + (height if axis == 0 else width))
            result_n += padded_n[tuple(selection)] * weight
            result_d += padded_d[tuple(selection)] * weight
        numerator, denominator = result_n, result_d
    smoothed = numerator / np.maximum(denominator[:, :, None], 1e-8)
    original[:] = np.where(valid[:, :, None] > 0, smoothed, original)


def rgba_png(width, height, pixels):
    """Encode exact 8-bit sRGB/AO bytes; never apply Blender display transforms."""
    if width <= 0 or height <= 0 or len(pixels) != width * height * 4:
        raise ValueError("RGBA image dimensions do not match pixel data")

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data +
                struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    stride = width * 4
    rows = b"".join(b"\0" + pixels[y * stride:(y + 1) * stride] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) +
            chunk(b"sRGB", b"\0") + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b""))


def decode_own_rgba_png(payload):
    """Independently validate this writer's bounded, unfiltered RGBA image."""
    if payload[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Invalid PNG signature")
    offset, compressed, dimensions = 8, bytearray(), None
    while offset < len(payload):
        length = struct.unpack_from(">I", payload, offset)[0]
        kind, data = payload[offset + 4:offset + 8], payload[offset + 8:offset + 8 + length]
        checksum = struct.unpack_from(">I", payload, offset + 8 + length)[0]
        if zlib.crc32(kind + data) & 0xFFFFFFFF != checksum:
            raise ValueError("PNG checksum mismatch")
        if kind == b"IHDR":
            width, height, depth, color, compression, filter_method, interlace = struct.unpack(">IIBBBBB", data)
            if (depth, color, compression, filter_method, interlace) != (8, 6, 0, 0, 0):
                raise ValueError("Unsupported generated PNG format")
            dimensions = width, height
        elif kind == b"IDAT":
            compressed.extend(data)
        offset += length + 12
    if dimensions is None:
        raise ValueError("PNG dimensions missing")
    width, height = dimensions
    rows = zlib.decompress(compressed)
    stride = width * 4 + 1
    if len(rows) != height * stride or any(rows[y * stride] != 0 for y in range(height)):
        raise ValueError("Unexpected generated PNG row data")
    return width, height, b"".join(rows[y * stride + 1:(y + 1) * stride] for y in range(height))


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def glb_document(path):
    payload = path.read_bytes()
    if payload[:4] != b"glTF":
        raise RuntimeError("Output is not a GLB")
    length, kind = struct.unpack_from("<II", payload, 12)
    if kind != 0x4E4F534A:
        raise RuntimeError("GLB has no JSON chunk")
    return json.loads(payload[20:20 + length])


def preserve_lightmap_rgba(path, png_path):
    """Keep AO alpha: glTF's emissive exporter may optimize its image to RGB.

    Repack buffer views with the exact saved RGBA PNG while preserving every
    accessor and material/image index. No new texture or sampler is introduced.
    """
    payload = path.read_bytes()
    json_length = struct.unpack_from("<I", payload, 12)[0]
    document = glb_document(path)
    binary_start = 20 + json_length
    binary_length, kind = struct.unpack_from("<II", payload, binary_start)
    if kind != 0x004E4942 or len(document.get("buffers", [])) != 1:
        raise RuntimeError("Expected exactly one embedded GLB buffer")
    binary = payload[binary_start + 8:binary_start + 8 + binary_length]
    views = set()
    for material in document["materials"]:
        texture = document["textures"][material["emissiveTexture"]["index"]]
        image = document["images"][texture["source"]]
        if image.get("mimeType") != "image/png":
            raise RuntimeError("Indirect atlas transport must use PNG")
        views.add(image["bufferView"])
    if len(views) != 1:
        raise RuntimeError("Indirect atlas was duplicated unexpectedly")
    rgba_png = png_path.read_bytes()
    if rgba_png[:8] != b"\x89PNG\r\n\x1a\n" or rgba_png[25] != 6:
        raise RuntimeError("Indirect/AO atlas must be an actual RGBA PNG")
    repacked = bytearray()
    for index, view in enumerate(document["bufferViews"]):
        if view.get("buffer", 0) != 0:
            raise RuntimeError("Unexpected external GLB buffer")
        start, length = view.get("byteOffset", 0), view["byteLength"]
        data = rgba_png if index in views else binary[start:start + length]
        repacked.extend(b"\0" * (-len(repacked) % 4))
        view["byteOffset"], view["byteLength"] = len(repacked), len(data)
        repacked.extend(data)
    document["buffers"][0]["byteLength"] = len(repacked)
    json_chunk = json.dumps(document, separators=(",", ":")).encode()
    json_chunk += b" " * (-len(json_chunk) % 4)
    repacked.extend(b"\0" * (-len(repacked) % 4))
    size = 12 + 8 + len(json_chunk) + 8 + len(repacked)
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, size) +
                     struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk +
                     struct.pack("<II", len(repacked), 0x004E4942) + repacked)


def main():
    import bpy
    import numpy as np

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-blend", type=Path, required=True)
    parser.add_argument("--input-json", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--size", type=int, default=2048, choices=(512, 1024, 2048))
    parser.add_argument("--samples", type=int, default=32, choices=(16, 32, 64, 128))
    parser.add_argument("--full-diffuse", action="store_true",
                        help="Bake direct + indirect diffuse; runtime must suppress duplicate diffuse lights")
    parser.add_argument("--closed-ceiling", action="store_true",
                        help="Add a temporary inferred cream ceiling for bake illumination only")
    parser.add_argument("--smooth-radius", type=int, default=0, choices=(0, 1, 2, 3),
                        help="Masked Gaussian atlas noise smoothing in texels")
    parser.add_argument("--with-ao", action="store_true",
                        help="Pack isolated-shell/furniture ambient occlusion into atlas alpha")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    source = args.input_blend.resolve(strict=True)
    source_json = (args.input_json or source.with_suffix(".json")).resolve(strict=True)
    output = args.output.resolve()
    if output.exists():
        raise RuntimeError("Output must be a fresh directory")
    started = time.monotonic()
    source_sha = sha256(source)
    input_sha = sha256(source_json)
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    scene = bpy.context.scene
    profile = FULL_PROFILE if args.full_diffuse else PROFILE
    if scene.get("inputSha256") != input_sha:
        raise RuntimeError("Blender scene is not bound to the exact source JSON")
    meshes = [o for o in scene.objects if o.type == "MESH" and o.name != "PreviewGround"]
    if not meshes:
        raise RuntimeError("Source contains no export meshes")
    furniture = [o for o in meshes if o.get("role") == "existing_furniture"]
    shell = [o for o in meshes if o not in furniture]
    original = {o.name: {"matrix": [v for row in o.matrix_world for v in row],
                         "vertices": len(o.data.vertices), "polygons": len(o.data.polygons),
                         "uv0": [tuple(v.uv) for v in o.data.uv_layers[0].data] if o.data.uv_layers else None,
                         "entityId": o.get("entityId")} for o in meshes}
    cutaways = [o.name for o in meshes if o.get("previewCutaway")]
    for obj in meshes:
        obj.hide_render = False
        obj.hide_set(False)
        # A mesh copy prevents shared source data from sharing its new atlas UVs.
        obj.data = obj.data.copy()
        if not obj.data.uv_layers:
            # Constant-color opening trim in older exports has no original UV.
            # Reserve its UV0 so the shared lightmap is consistently TEXCOORD_1.
            if any(slot.material and slot.material.use_nodes and
                   any(node.type == "TEX_IMAGE" for node in slot.material.node_tree.nodes)
                   for slot in obj.material_slots):
                raise RuntimeError("Textured source mesh has no original PBR UVs")
            obj.data.uv_layers.new(name="UVMap")
        uv0 = obj.data.uv_layers[0]
        if UV_NAME in obj.data.uv_layers:
            raise RuntimeError("Source is already lightmapped; use the original scene")
        obj.data.uv_layers.new(name=UV_NAME)
        obj.data.uv_layers.active = obj.data.uv_layers[UV_NAME]
        uv0.active_render = True
    ground = bpy.data.objects.get("PreviewGround")
    if ground:
        ground.hide_render = True
    temporary_ceilings = []
    if args.closed_ceiling:
        material = bpy.data.materials.new("BakeOnly_InferredCeiling")
        material.use_nodes = True
        principled = material.node_tree.nodes.get("Principled BSDF")
        color = [int("f4f1ea"[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        color = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in color]
        principled.inputs["Base Color"].default_value = (*color, 1)
        principled.inputs["Roughness"].default_value = .95
        for room in json.loads(source_json.read_text())["geometry"]["rooms"]:
            vertices = [(x, -z, room["height"]) for x, z in room["floorPolygon"]]
            area = sum(vertices[i][0] * vertices[(i + 1) % len(vertices)][1] -
                       vertices[(i + 1) % len(vertices)][0] * vertices[i][1] for i in range(len(vertices)))
            if area > 0:
                vertices.reverse()
            mesh = bpy.data.meshes.new("BakeOnly_CeilingMesh")
            mesh.from_pydata(vertices, [], [tuple(range(len(vertices)))])
            mesh.update()
            obj = bpy.data.objects.new("BakeOnly_InferredCeiling", mesh)
            scene.collection.objects.link(obj)
            obj.data.materials.append(material)
            temporary_ceilings.append(obj)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    # Multi-object smart projection packs every island into the same unique
    # image domain. UV0 and the metric transforms are not touched.
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003,
                             area_weight=0.0, correct_aspect=True, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")
    unwrapped = time.monotonic()
    image = bpy.data.images.new("Tadaima_Indirect_2048", width=args.size, height=args.size,
                                alpha=args.with_ao, float_buffer=True)
    image.colorspace_settings.name = "Linear Rec.709"
    image.generated_color = (0, 0, 0, 1)
    materials = set()
    for obj in meshes:
        for slot in obj.material_slots:
            material = slot.material
            if material is None or not material.use_nodes:
                raise RuntimeError("Every baked material must use a PBR node tree")
            materials.add(material)
    targets = {}
    for material in materials:
        nodes, links = material.node_tree.nodes, material.node_tree.links
        # Existing implicit image UVs must remain UV0 while UV2 is active for bake.
        uv0_node = nodes.new("ShaderNodeUVMap")
        uv0_node.uv_map = "UVMap"
        for node in list(nodes):
            if node.type == "TEX_IMAGE" and not node.inputs["Vector"].is_linked:
                links.new(uv0_node.outputs["UV"], node.inputs["Vector"])
        target = nodes.new("ShaderNodeTexImage")
        target.name = "TadaimaIndirectBakeTarget"
        target.image = image
        target.extension = "EXTEND"
        for node in nodes:
            node.select = False
        target.select = True
        nodes.active = target
        targets[material] = target
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args.samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = .035
    scene.cycles.use_denoising = True
    scene.cycles.diffuse_bounces = 4
    scene.cycles.max_bounces = 8
    scene.cycles.seed = 0
    bake = scene.render.bake
    bake.use_pass_direct = args.full_diffuse
    bake.use_pass_indirect = True
    bake.use_pass_color = False
    bake.margin = 4
    bake.use_selected_to_active = False
    bake.target = "IMAGE_TEXTURES"
    timings = {}

    def run_bake(objects, name, clear, bake_type="DIFFUSE"):
        if not objects:
            return
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bake.use_clear = clear
        tick = time.monotonic()
        print("TADAIMA_BAKE", name, "started", len(objects), "meshes", flush=True)
        result = bpy.ops.object.bake(type=bake_type, uv_layer=UV_NAME)
        if "FINISHED" not in result:
            raise RuntimeError(f"{name} bake failed")
        timings[name] = round(time.monotonic() - tick, 3)
        print("TADAIMA_BAKE", name, "finished", timings[name], "seconds", flush=True)

    for obj in furniture:
        obj.hide_render = True
    run_bake(shell, "static_shell_without_furniture", True)
    for obj in furniture:
        obj.hide_render = False
    run_bake(furniture, "furniture_at_original_pose", False)
    pixels = np.empty(args.size * args.size * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    if args.with_ao:
        for obj in furniture:
            obj.hide_render = True
        run_bake(shell, "static_shell_ao_without_furniture", True, "AO")
        for obj in furniture:
            obj.hide_render = False
        run_bake(furniture, "furniture_ao_at_original_pose", False, "AO")
        ao_pixels = np.empty_like(pixels)
        image.pixels.foreach_get(ao_pixels)
        pixels.reshape((-1, 4))[:, 3] = np.clip(ao_pixels.reshape((-1, 4))[:, 0], 0, 1)
        image.pixels.foreach_set(pixels)
        image.update()
    rgb = pixels.reshape((-1, 4))[:, :3]
    if not np.isfinite(rgb).all() or float(rgb.max()) <= 0:
        raise RuntimeError("Bake contains non-finite pixels or no indirect illumination")
    pixel_stats = {"min": float(rgb.min()), "max": float(rgb.max()),
                   "meanIncludingAtlasPadding": float(rgb.mean()),
                   "nonzeroTexels": int(np.count_nonzero(np.max(rgb, axis=1) > 0)),
                   "channelsAboveOne": int(np.count_nonzero(rgb > 1))}
    masked_gaussian_rgb(pixels, args.size, args.size, args.smooth_radius)
    # PNG is a bounded, portable texture. A shared scale preserves HDR samples
    # beyond 1; the runtime multiplies by this scale as well as pi.
    radiance_scale = max(1.0, float(rgb.max()))
    if radiance_scale > 1:
        rgb /= radiance_scale
        image.pixels.foreach_set(pixels)
        image.update()
    output.mkdir(parents=True)
    # Convert linear radiance explicitly. Generated-image color-space mutation
    # can invalidate Blender's pixel buffer; image.save() is deliberately absent.
    rgba = pixels.reshape((args.size, args.size, 4)).copy()
    linear = np.clip(rgba[:, :, :3], 0, 1)
    rgba[:, :, :3] = np.where(linear <= .0031308, linear * 12.92,
                              1.055 * np.power(linear, 1 / 2.4) - .055)
    if not args.with_ao:
        rgba[:, :, 3] = 1
    # Blender's pixel buffer has its first row at the bottom; PNG starts on top.
    encoded = np.rint(np.clip(rgba[::-1], 0, 1) * 255).astype(np.uint8).tobytes()
    png_path = output / "indirect-lightmap.png"
    png_path.write_bytes(rgba_png(args.size, args.size, encoded))
    width, height, decoded = decode_own_rgba_png(png_path.read_bytes())
    if (width, height) != (args.size, args.size) or decoded != encoded:
        raise RuntimeError("Saved PNG does not preserve encoded indirect RGB and AO alpha")
    decoded_pixels = np.frombuffer(decoded, dtype=np.uint8).reshape((-1, 4))
    if int(decoded_pixels[:, :3].max()) <= 0:
        raise RuntimeError("Saved atlas lost baked illumination during image encoding")
    saved_statistics = {"decodedSrgbMaximum": int(decoded_pixels[:, :3].max()),
                        "decodedNonzeroChannels": int(np.count_nonzero(decoded_pixels[:, :3])),
                        "decodedAlphaRange": [int(decoded_pixels[:, 3].min()), int(decoded_pixels[:, 3].max())],
                        "encodedRgbaMatchesDecodedPng": True}
    image = bpy.data.images.load(str(png_path), check_existing=False)
    image.colorspace_settings.name = "sRGB"
    image.pack()
    for material, target in targets.items():
        target.image = image
        nodes, links = material.node_tree.nodes, material.node_tree.links
        uv2 = nodes.new("ShaderNodeUVMap")
        uv2.uv_map = UV_NAME
        links.new(uv2.outputs["UV"], target.inputs["Vector"])
        principled = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
        if principled is None:
            raise RuntimeError("Cannot transport indirect map without a Principled material")
        links.new(target.outputs["Color"], principled.inputs["Emission Color"])
        principled.inputs["Emission Strength"].default_value = 1
        material["tadaimaIndirectLightmap"] = profile
        material["tadaimaIndirectScale"] = radiance_scale
        material["tadaimaIndirectUv"] = 1
        if args.with_ao:
            material["tadaimaIndirectAo"] = True
    for obj in meshes:
        obj.data.uv_layers.active_index = 0
        obj.data.uv_layers[0].active_render = True
        before = original[obj.name]
        if before["matrix"] != [v for row in obj.matrix_world for v in row] or before["vertices"] != len(obj.data.vertices):
            raise RuntimeError("Bake unexpectedly changed metric geometry")
        if before["uv0"] is not None and before["uv0"] != [tuple(v.uv) for v in obj.data.uv_layers[0].data]:
            raise RuntimeError("Bake unexpectedly changed original PBR UVs")
    for obj in temporary_ceilings:
        bpy.data.objects.remove(obj, do_unlink=True)
    scene["indirectLightmapProfile"] = profile
    scene["indirectLightmapSourceSha256"] = source_sha
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    for obj in scene.objects:
        if obj.type == "EMPTY" and obj.get("entityId"):
            obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    result = bpy.ops.export_scene.gltf(
        filepath=str(output / "scene.glb"), export_format="GLB", check_existing=False,
        use_selection=True, export_yup=True, export_extras=True, export_materials="EXPORT",
        export_normals=True, export_texcoords=True, export_tangents=True,
        export_animations=False, export_image_format="AUTO", use_renderable=False,
        export_cameras=False, export_lights=False, export_draco_mesh_compression_enable=False,
        export_unused_images=False, export_unused_textures=False)
    if "FINISHED" not in result:
        raise RuntimeError("GLB export failed")
    preserve_lightmap_rgba(output / "scene.glb", output / "indirect-lightmap.png")
    shutil.copyfile(source_json, output / "scene.json")
    document = glb_document(output / "scene.glb")
    primitives = [p for m in document.get("meshes", []) for p in m["primitives"]]
    exported_materials = document.get("materials", [])
    if not primitives or any("TEXCOORD_1" not in p["attributes"] for p in primitives):
        raise RuntimeError("GLB export lost secondary UV coordinates")
    if any(m.get("emissiveTexture", {}).get("texCoord", 0) != 1 for m in exported_materials):
        raise RuntimeError("Indirect lightmap is not exported on texCoord 1")
    if any(m.get("extras", {}).get("tadaimaIndirectLightmap") != profile for m in exported_materials):
        raise RuntimeError("GLB export lost lightmap material transport marker")
    atlas_sources = {document["textures"][m["emissiveTexture"]["index"]]["source"]
                     for m in exported_materials}
    if len(atlas_sources) != 1:
        raise RuntimeError("GLB export duplicated the atlas image")
    exported_image = document["images"][next(iter(atlas_sources))]
    view = document["bufferViews"][exported_image["bufferView"]]
    glb_bytes = (output / "scene.glb").read_bytes()
    json_length = struct.unpack_from("<I", glb_bytes, 12)[0]
    image_start = 28 + json_length + view.get("byteOffset", 0)
    embedded_png = glb_bytes[image_start:image_start + view["byteLength"]]
    embedded_matches_saved = embedded_png == (output / "indirect-lightmap.png").read_bytes()
    if not embedded_matches_saved:
        raise RuntimeError("Embedded RGBA atlas differs from independently decoded saved PNG")
    if sha256(source) != source_sha or sha256(output / "scene.json") != input_sha:
        raise RuntimeError("Source provenance changed")
    report = {"schemaVersion": "tadaima-indirect-bake/1.0", "profile": profile,
              "sourceBlendSha256": source_sha, "inputSha256": input_sha,
              "projectId": scene.get("projectId"), "jobId": scene.get("jobId"),
              "inputRevision": scene.get("inputRevision"),
              "samples": args.samples, "atlasSize": [args.size, args.size],
              "gpuRgba8Bytes": args.size * args.size * 4,
              "bakePasses": {"direct": args.full_diffuse, "indirect": True, "color": False},
              "temporaryInferredCeiling": args.closed_ceiling,
              "noiseFilter": {"method": "masked-gaussian", "radiusTexels": args.smooth_radius},
              "staticShellFurnitureOcclusion": False,
              "ambientOcclusionInAtlasAlpha": args.with_ao,
              "furnitureLightingValidity": "Original pose only; runtime must disable lightmap when moved or exploded",
              "restoredCutawayWalls": cutaways, "excludedPreviewGround": ground is not None,
              "meshCount": len(meshes), "furnitureMeshCount": len(furniture),
              "materialCount": len(exported_materials), "primitiveCount": len(primitives),
              "transport": {"slot": "emissiveTexture", "texCoord": 1, "imageEncoding": "sRGB PNG",
                            "runtimeSlot": "lightMap", "runtimeIntensity": math.pi * radiance_scale,
                            "radianceScale": radiance_scale, "runtimeEmission": 0},
              "pixelStatistics": pixel_stats, "seconds": {"unwrap": round(unwrapped - started, 3),
                  **timings, "total": round(time.monotonic() - started, 3)},
              "sourceGeometryAndUv0Unchanged": True,
              "savedAtlasStatistics": saved_statistics,
              "embeddedAtlasSha256": hashlib.sha256(embedded_png).hexdigest(),
              "embeddedAtlasMatchesDecodedSavedPng": embedded_matches_saved,
              "files": {name: {"bytes": (output / name).stat().st_size, "sha256": sha256(output / name)}
                        for name in ("scene.glb", "scene.json", "indirect-lightmap.png")}}
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print("TADAIMA_BAKE_COMPLETE", json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
