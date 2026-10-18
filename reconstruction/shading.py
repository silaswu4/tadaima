"""Portable Principled materials and a preview-only Cycles lighting rig.

Imported by Blender's trusted worker, never executed from reconstruction input.
The PBR images are CC0 Poly Haven assets recorded in sources.json. These are
presentation defaults unless a validated, evidence-bound appearance is supplied.
"""

from pathlib import Path
import math
import tempfile
import json

import numpy as np

import bpy
from mathutils import Vector

from reconstruction.daylight import daylight_plan

ASSETS = Path(__file__).resolve().parents[1] / "public/materials/room"
RENDER_PROFILE = "pbr-window-daylight-v2"
_IMAGE_CACHE = {}


def packed_image(filename, *, color=False, tint=None, scale=1):
    cache_key = (filename, color, tuple(tint) if tint else None, scale)
    if cache_key in _IMAGE_CACHE:
        return _IMAGE_CACHE[cache_key]
    path = ASSETS / filename
    if not path.is_file():
        raise RuntimeError(f"Missing room appearance asset: {filename}")
    image = bpy.data.images.load(str(path), check_existing=False)
    image.colorspace_settings.name = "sRGB" if color else "Non-Color"
    if path.suffix.lower() == ".jpg":
        # Blender 4.5's AUTO exporter chooses the source image format; its
        # enum has no forced-PNG option. Convert actual pixels before packing.
        filename = path.stem + ".png"
        # File images decode lazily. Materialize pixels before changing their
        # source path, otherwise Blender tries to read the not-yet-saved PNG.
        if not len(image.pixels):
            raise RuntimeError(f"Room texture could not be decoded: {path.name}")
        if tint is not None or scale != 1:
            # File-image pixel storage is encoded RGB. Bake the linear-space
            # multiplier into a new packed image; this avoids unsupported
            # Blender-only multiply nodes and matches the web PBR tint.
            pixels = np.empty(len(image.pixels), dtype=np.float32)
            image.pixels.foreach_get(pixels)
            rgba = pixels.reshape((-1, 4))
            rgb = rgba[:, :3]
            if tint is not None:
                linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
                linear *= np.array(tint, dtype=np.float32)
                rgb[:] = np.where(linear <= .0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - .055)
            else:
                rgb *= scale
            np.clip(rgb, 0, 1, out=rgb)
            image.pixels.foreach_set(pixels)
            image.update()
        image.file_format = "PNG"
        with tempfile.TemporaryDirectory(prefix="tadaima-pbr-") as temporary:
            image.filepath_raw = str(Path(temporary) / filename)
            image.save()
            packed = Path(image.filepath_raw).read_bytes()
    else:
        packed = path.read_bytes()
    # The .blend remains self-contained after transfer to another machine.
    image.filepath_raw = "//materials/" + filename
    image.pack(data=packed, data_len=len(packed))
    _IMAGE_CACHE[cache_key] = image
    return image


def pbr_material(name, color, *, albedo=None, roughness=None, normal=None,
                 roughness_value=.9, normal_strength=.1, albedo_tint=None, roughness_scale=1):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = color
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Roughness"].default_value = roughness_value
    shader.inputs["Metallic"].default_value = 0

    def texture(filename, label, *, color_data=False, tint=None, scale=1):
        node = nodes.new("ShaderNodeTexImage")
        node.label = label
        node.image = packed_image(filename, color=color_data, tint=tint, scale=scale)
        node.extension = "REPEAT"
        return node

    if albedo:
        node = texture(albedo, "sRGB base color", color_data=True, tint=albedo_tint)
        links.new(node.outputs["Color"], shader.inputs["Base Color"])
    if roughness:
        node = texture(roughness, "Linear roughness", scale=roughness_scale)
        links.new(node.outputs["Color"], shader.inputs["Roughness"])
    if normal:
        node = texture(normal, "OpenGL tangent-space normal")
        mapping = nodes.new("ShaderNodeNormalMap")
        mapping.inputs["Strength"].default_value = normal_strength
        mapping.uv_map = "UVMap"
        links.new(node.outputs["Color"], mapping.inputs["Color"])
        links.new(mapping.outputs["Normal"], shader.inputs["Normal"])
    return material


def linear_color(hex_color):
    encoded = [int(hex_color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    return tuple(value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4 for value in encoded)


def room_materials(geometry, appearance=None):
    """Bind estimated finishes by semantic ID; retain defaults for omissions."""
    specs = {surface["entityId"]: surface for surface in (appearance or {}).get("surfaces", [])}
    bindings, summary = {}, []
    for entity, is_floor in [(room, True) for room in geometry["rooms"]] + [(wall, False) for wall in geometry["walls"]]:
        entity_id = entity["id"]
        spec = specs.get(entity_id)
        finish = spec["finish"] if spec else ("wood" if is_floor else "paint")
        color = linear_color(spec["color"]) if spec else ((1, 1, 1) if is_floor else (.855, .815, .738))
        roughness = spec["roughness"] if spec else (1 if is_floor else .9)
        tile = spec["tileMeters"] if spec else (1.2 if is_floor else 1)
        rotation = spec["rotationDegrees"] if spec else 0
        if finish == "wood":
            material = pbr_material("Wood_" + entity_id, (1, 1, 1, 1), albedo="oak-basecolor.jpg",
                                    roughness="oak-roughness.jpg", normal="oak-normal.jpg",
                                    normal_strength=.45, albedo_tint=color if spec else None,
                                    roughness_scale=roughness)
        else:
            # A proxy micro-normal, not a fabricated photograph texture or a
            # claim that the real tile/grout/carpet fibers were recovered.
            strength = {"paint": .08, "tile": .035, "carpet": .16}[finish]
            material = pbr_material(finish.title() + "_" + entity_id, (*color, 1),
                                    normal="plaster-normal.jpg", roughness_value=roughness,
                                    normal_strength=strength)
        material["finish"] = finish
        material["appearanceStatus"] = "photo_estimate" if spec else "styling_default"
        bindings[entity_id] = (material, tile, rotation)
        summary.append({"entityId": entity_id, "finish": finish,
                        "status": material["appearanceStatus"], "roughness": roughness,
                        "tileMeters": tile, "rotationDegrees": rotation,
                        "evidenceIds": spec["evidenceIds"] if spec else []})
    return bindings, {"reviewRequired": True, "scope": (appearance or {}).get("scope", "unknown"),
                      "surfaces": summary,
                      "assumption": "Photo-derived colors and proxy PBR finishes are estimates under unknown camera exposure; unlisted surfaces use styling defaults."}


def metric_uvs(obj, tile_meters, rotation_degrees=0):
    """Project each face in meters without changing a vertex or room bounds."""
    if obj.type != "MESH":
        return
    uv = obj.data.uv_layers.new(name="UVMap")
    angle = math.radians(rotation_degrees)
    cosine, sine = math.cos(angle), math.sin(angle)
    for polygon in obj.data.polygons:
        axis = max(range(3), key=lambda i: abs(polygon.normal[i]))
        for index in polygon.loop_indices:
            point = obj.data.vertices[obj.data.loops[index].vertex_index].co
            if axis == 2:
                # Floors share a world-aligned pattern across separate rooms.
                u, v = point.x + obj.location.x, -(point.y + obj.location.y)
            elif axis == 0:
                u, v = point.y, point.z
            else:
                u, v = point.x, point.z
            uv.data[index].uv = ((u * cosine - v * sine) / tile_meters,
                                 (u * sine + v * cosine) / tile_meters)


def add_preview_setup(scene, bounds, objects, geometry):
    """Save an editable, portable studio/daylight rig; export no rig objects."""
    low, high = bounds["min"], bounds["max"]
    target = Vector(((low[0] + high[0]) / 2, -(low[2] + high[2]) / 2, (low[1] + high[1]) / 3))
    span = max(high[0] - low[0], high[2] - low[2], high[1] - low[1])
    data = bpy.data.cameras.new("PreviewCamera")
    camera = bpy.data.objects.new("PreviewCamera", data)
    scene.collection.objects.link(camera)
    camera.location = target + Vector((span * 1.3, -span * 1.5, span * 1.6))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    data.type = "ORTHO"
    data.sensor_fit = "HORIZONTAL"
    aspect = 960 / 720
    rotation = camera.rotation_euler.to_matrix()
    projected = [rotation.transposed() @ (Vector((x, -z, y)) - target)
                 for x in (low[0], high[0]) for y in (low[1], high[1]) for z in (low[2], high[2])]
    left, right = min(p.x for p in projected), max(p.x for p in projected)
    bottom, top = min(p.y for p in projected), max(p.y for p in projected)
    data.ortho_scale = max((top - bottom) * aspect, right - left) * 1.16
    # Center the complete projected room, including the back-wall top corner.
    camera.location += rotation @ Vector(((left + right) / 2, (bottom + top) / 2, 0))
    data.clip_end = max(1000, span * 10)
    scene.camera = camera

    def light(name, kind, offset, energy, color, size):
        data = bpy.data.lights.new(name, kind)
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        obj.location = target + Vector(offset)
        obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()
        data.energy = energy
        data.color = color
        if kind == "AREA":
            data.shape = "DISK"
            data.size = size
        else:
            data.angle = size
        return obj

    lighting = daylight_plan(geometry)
    if lighting["mode"] == "window_daylight":
        for window in lighting["windows"]:
            data = bpy.data.lights.new("WindowDaylight_" + window["openingId"], "AREA")
            obj = bpy.data.objects.new(data.name, data)
            scene.collection.objects.link(obj)
            x, y, z = window["position"]
            ix, iy, iz = window["inward"]
            obj.location = (x, -z, y)
            obj.rotation_euler = Vector((ix, -iz, iy)).to_track_quat("-Z", "Y").to_euler()
            data.shape = "RECTANGLE"
            data.size, data.size_y = window["width"], window["height"]
            # Constant radiance policy: energy scales with opening area, not
            # a synthetic sun direction. Saved dimensions remain editable.
            data.energy = 350 * window["width"] * window["height"]
            data.color = (.88, .94, 1)
            obj["openingId"] = window["openingId"]
            obj["lightingMode"] = "cloudy_window_daylight"
    else:
        light("Fallback_Studio_Key", "AREA", (span * .7, -span * .3, span * 1.8),
              900, (1, .95, .9), span * .8)
    scene["lightingSummaryJson"] = json.dumps(lighting, separators=(",", ":"))

    scene.world.use_nodes = True
    nodes, links = scene.world.node_tree.nodes, scene.world.node_tree.links
    environment = nodes.new("ShaderNodeTexEnvironment")
    environment.image = packed_image("studio-small-09-1k.hdr")
    # HDR is radiance data. Do not run it through the display sRGB transfer.
    environment.image.colorspace_settings.name = "Linear Rec.709"
    background = nodes.get("Background")
    background.inputs["Strength"].default_value = .12 if lighting["mode"] == "window_daylight" else .4
    links.new(environment.outputs["Color"], background.inputs["Color"])
    scene.render.film_transparent = True

    # Presentation cutaway: remove near walls from all preview rays, avoiding
    # phantom shadows and black cut faces. Their mesh data stays editable and
    # the export deliberately includes non-renderable selected objects.
    for obj in objects:
        if obj.type != "MESH" or obj.get("role") != "wall":
            continue
        midpoint = obj.matrix_world @ (sum((Vector(c) for c in obj.bound_box), Vector()) / 8)
        to_camera = camera.location - midpoint
        from_center = midpoint - target
        if to_camera.x * from_center.x + to_camera.y * from_center.y > 0:
            obj.hide_render = True
            obj["previewCutaway"] = True

    # Presentation ground is intentionally outside semantic room geometry.
    ground_mesh = bpy.data.meshes.new("PreviewGround_Mesh")
    extent = span * 5
    ground_mesh.from_pydata([(-extent, -extent, 0), (extent, -extent, 0),
                            (extent, extent, 0), (-extent, extent, 0)], [], [(0, 1, 2, 3)])
    ground = bpy.data.objects.new("PreviewGround", ground_mesh)
    scene.collection.objects.link(ground)
    ground.location = (target.x, target.y, low[1] - .005)
    ground.data.materials.append(pbr_material("PreviewGround_PBR", (.88, .86, .82, 1), roughness_value=1))

    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 64
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = .035
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 8
    scene.cycles.diffuse_bounces = 4
    scene.cycles.glossy_bounces = 4
    scene.cycles.transmission_bounces = 4
    scene.cycles.sample_clamp_indirect = 3
    scene.cycles.seed = 0
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0
    scene.render.resolution_x = 960
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene["renderProfile"] = RENDER_PROFILE
    return lighting
