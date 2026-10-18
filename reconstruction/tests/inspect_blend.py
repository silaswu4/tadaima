"""Runs inside Blender to independently reopen and inspect a generated scene."""

import json
import math
from pathlib import Path
import sys

import bmesh
import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

directory = Path(sys.argv[sys.argv.index("--") + 1])
source = json.loads((directory / "scene.json").read_text())
manifest = json.loads((directory / "manifest.json").read_text())
bpy.ops.wm.open_mainfile(filepath=str(directory / "scene.blend"))
scene = bpy.context.scene
assert scene.unit_settings.system == "METRIC"
assert scene.unit_settings.scale_length == 1.0
assert int(scene["inputRevision"]) == source["inputRevision"]
textured = manifest.get("renderProfile") == "pbr-daylight-v1"
if textured:
    assert scene.get("renderProfile") == manifest["renderProfile"]
    assert scene.render.engine == "CYCLES", "Photoreal preview requires the path tracer"
    assert scene.view_settings.view_transform == "AgX", "Preview should preserve highlight range with AgX"
    assert scene.cycles.use_denoising, "Path traced preview should enable denoising"
    assert scene.cycles.max_bounces >= 4, "Interior lighting requires indirect bounces"
    assert scene.world and scene.world.use_nodes
    environments = [node for node in scene.world.node_tree.nodes if node.type == "TEX_ENVIRONMENT"]
    assert environments and any(node.image and node.image.packed_file for node in environments), "HDR environment must travel inside the editable blend"
    assert any(obj.type == "LIGHT" and obj.data.type == "AREA" and obj.data.energy > 0 for obj in scene.objects), "Preview needs a soft area light"
    assert scene.camera, "Preview requires a camera"
    # Frame the full room bounds, including preview-hidden cutaway walls. This
    # catches a clipped wall top even when the floor still fits comfortably.
    for x in (manifest["bounds"]["min"][0], manifest["bounds"]["max"][0]):
        for y in (manifest["bounds"]["min"][1], manifest["bounds"]["max"][1]):
            for z in (manifest["bounds"]["min"][2], manifest["bounds"]["max"][2]):
                projected = world_to_camera_view(scene, scene.camera, Vector((x, -z, y)))
                assert projected.z > 0, "Room bounds must be in front of the preview camera"
                assert .01 <= projected.x <= .99 and .01 <= projected.y <= .99, (
                    "Preview clips room bounds: " + str(tuple(projected)))
entities = {obj["entityId"]: obj for obj in scene.objects if "entityId" in obj}
assert len(entities) == len(manifest["objects"])
for item in manifest["objects"]:
    obj = entities[item["id"]]
    assert obj["role"] == item["role"]
    assert json.loads(obj["evidenceIdsJson"]) == item["evidenceIds"]
for obj in entities.values():
    if obj.type == "MESH":
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        assert all(edge.is_manifold for edge in bm.edges), obj.name
        assert bm.calc_volume(signed=True) > 0, obj.name + " has inverted normals"
        bm.free()
        assert not obj.modifiers, "Scene should not depend on live Boolean modifiers"
        if textured:
            uv = obj.data.uv_layers.active
            assert uv and len(uv.data) == len(obj.data.loops), obj.name + " needs complete UVs"
            assert all(math.isfinite(component) for loop in uv.data for component in loop.uv), "Nonfinite UV"
            for face in obj.data.polygons:
                points = [uv.data[index].uv for index in face.loop_indices]
                area = sum(a.x * b.y - b.x * a.y for a, b in zip(points, points[1:] + points[:1])) / 2
                assert abs(area) > 1e-10, obj.name + " has a collapsed UV face"
            assert obj.data.materials, "Textured mesh needs a material"
            for material in obj.data.materials:
                assert material.use_nodes
                shaders = [node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"]
                assert shaders and shaders[0].inputs["Normal"].is_linked, "PBR normal must reach the surface shader"
                images = [node.image for node in material.node_tree.nodes if node.type == "TEX_IMAGE"]
                assert images and all(image and image.packed_file for image in images), "Material maps must be packed"
                assert any(node.type == "NORMAL_MAP" and node.inputs["Color"].is_linked for node in material.node_tree.nodes), "Use a tangent-space normal map"
                assert any(image.colorspace_settings.name == "Non-Color" for image in images), "Normal maps are linear data"
                if obj["role"] == "room_floor":
                    assert shaders[0].inputs["Base Color"].is_linked, "Floor needs a base-color texture"
                    assert shaders[0].inputs["Roughness"].is_linked, "Floor needs a roughness texture"
                    assert any(image.colorspace_settings.name == "sRGB" for image in images), "Base color uses sRGB"
for wall in source["geometry"]["walls"]:
    obj = entities[wall["id"]]
    cuts = [o for o in source["geometry"]["openings"] if o["wallId"] == wall["id"]]
    if obj.type != "MESH":
        assert cuts, "Only fully opened walls can be semantic empties"
        continue
    length = ((wall["end"][0] - wall["start"][0]) ** 2 + (wall["end"][1] - wall["start"][1]) ** 2) ** 0.5
    expected = (length * wall["height"] - sum(o["width"] * o["height"] for o in cuts)) * wall["thickness"]
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    assert abs(bm.calc_volume() - expected) < max(1e-5, expected * 1e-5), wall["id"]
    bm.free()
    for opening in cuts:
        center = Vector((opening["offset"] + opening["width"] / 2, -wall["thickness"] * 2,
                         opening["sillHeight"] + opening["height"] / 2))
        assert not obj.ray_cast(center, Vector((0, 1, 0)), distance=wall["thickness"] * 4)[0], opening["id"]
print("TADAIMA_BLEND_VERIFIED " + json.dumps({"entityCount": len(entities), "editable": True,
                                             "texturedPbr": textured, "renderProfile": manifest.get("renderProfile")}))
