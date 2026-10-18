"""Portable Principled materials and a preview-only Cycles lighting rig.

Imported by Blender's trusted worker, never executed from reconstruction input.
The PBR images are CC0 Poly Haven assets recorded in sources.json. These are
presentation defaults, not inferred finishes or observed lighting of a home.
"""

from pathlib import Path
import math
import tempfile

import bpy
from mathutils import Vector

ASSETS = Path(__file__).resolve().parents[1] / "public/materials/room"
RENDER_PROFILE = "pbr-daylight-v1"


def packed_image(filename, *, color=False):
    path = ASSETS / filename
    if not path.is_file():
        raise RuntimeError(f"Missing room appearance asset: {filename}")
    image = bpy.data.images.load(str(path), check_existing=True)
    image.colorspace_settings.name = "sRGB" if color else "Non-Color"
    if path.suffix.lower() == ".jpg":
        # Blender 4.5's AUTO exporter chooses the source image format; its
        # enum has no forced-PNG option. Convert actual pixels before packing.
        filename = path.stem + ".png"
        # File images decode lazily. Materialize pixels before changing their
        # source path, otherwise Blender tries to read the not-yet-saved PNG.
        if not len(image.pixels):
            raise RuntimeError(f"Room texture could not be decoded: {path.name}")
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
    return image


def pbr_material(name, color, *, albedo=None, roughness=None, normal=None,
                 roughness_value=.9, normal_strength=.1):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = color
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Roughness"].default_value = roughness_value
    shader.inputs["Metallic"].default_value = 0

    def texture(filename, label, *, color_data=False):
        node = nodes.new("ShaderNodeTexImage")
        node.label = label
        node.image = packed_image(filename, color=color_data)
        node.extension = "REPEAT"
        return node

    if albedo:
        node = texture(albedo, "sRGB base color", color_data=True)
        links.new(node.outputs["Color"], shader.inputs["Base Color"])
    if roughness:
        node = texture(roughness, "Linear roughness")
        links.new(node.outputs["Color"], shader.inputs["Roughness"])
    if normal:
        node = texture(normal, "OpenGL tangent-space normal")
        mapping = nodes.new("ShaderNodeNormalMap")
        mapping.inputs["Strength"].default_value = normal_strength
        mapping.uv_map = "UVMap"
        links.new(node.outputs["Color"], mapping.inputs["Color"])
        links.new(mapping.outputs["Normal"], shader.inputs["Normal"])
    return material


def room_materials():
    return (
        pbr_material("Floor_PBR", (1, 1, 1, 1), albedo="oak-basecolor.jpg",
                     roughness="oak-roughness.jpg", normal="oak-normal.jpg",
                     roughness_value=1, normal_strength=.45),
        # Colors are scene-linear, approximately the viewer's warm white.
        pbr_material("Wall_PBR", (.855, .815, .738, 1), normal="plaster-normal.jpg"),
    )


def metric_uvs(obj, tile_meters):
    """Project each face in meters without changing a vertex or room bounds."""
    if obj.type != "MESH":
        return
    uv = obj.data.uv_layers.new(name="UVMap")
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
            uv.data[index].uv = (u / tile_meters, v / tile_meters)


def add_preview_setup(scene, bounds, objects):
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

    light("Daylight_Key", "AREA", (span * .7, -span * .3, span * 1.8),
          900, (1, .92, .82), span * .8)
    light("Daylight_Sun", "SUN", (-span, -span * .4, span * 1.2),
          1.7, (1, .95, .88), math.radians(4))

    scene.world.use_nodes = True
    nodes, links = scene.world.node_tree.nodes, scene.world.node_tree.links
    environment = nodes.new("ShaderNodeTexEnvironment")
    environment.image = packed_image("studio-small-09-1k.hdr")
    # HDR is radiance data. Do not run it through the display sRGB transfer.
    environment.image.colorspace_settings.name = "Linear Rec.709"
    background = nodes.get("Background")
    background.inputs["Strength"].default_value = .4
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
