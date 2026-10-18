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
textured = manifest.get("renderProfile") in ("pbr-daylight-v1", "pbr-window-daylight-v2")
window_profile = manifest.get("renderProfile") == "pbr-window-daylight-v2"
source_surfaces = {surface["entityId"]: surface for surface in source.get("appearance", {}).get("surfaces", [])}
photo_entities = {entry["entityId"]: entry for entry in manifest.get("photoTexturing", {}).get("entities", [])}
if photo_entities:
    assert json.loads((directory / "photo-texturing.json").read_text()) == manifest["photoTexturing"]
    assert json.loads(scene["photoTexturingSummaryJson"]) == manifest["photoTexturing"]
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
if window_profile:
    lighting = manifest["lighting"]
    assert json.loads(scene["lightingSummaryJson"]) == lighting
    assert json.loads(scene["appearanceSummaryJson"]) == manifest["appearance"]
    assert not any(obj.type == "LIGHT" and obj.data.type == "SUN" for obj in scene.objects), "No invented geolocated sun"
    actual_window_lights = {obj["openingId"]: obj for obj in scene.objects if obj.type == "LIGHT" and "openingId" in obj}
    assert set(actual_window_lights) == {item["openingId"] for item in lighting["windows"]}
    assert len(actual_window_lights) <= 12
    for item in lighting["windows"]:
        opening = next(value for value in source["geometry"]["openings"] if value["id"] == item["openingId"])
        wall = next(value for value in source["geometry"]["walls"] if value["id"] == opening["wallId"])
        assert opening["kind"] == "window"
        assert item["width"] == opening["width"] and item["height"] == opening["height"]
        fraction = (opening["offset"] + opening["width"] / 2) / math.dist(wall["start"], wall["end"])
        expected_center = [wall["start"][0] + fraction * (wall["end"][0] - wall["start"][0]),
                           opening["sillHeight"] + opening["height"] / 2,
                           wall["start"][1] + fraction * (wall["end"][1] - wall["start"][1])]
        assert max(abs(a - b) for a, b in zip(expected_center, item["center"])) < 1e-7
        obj = actual_window_lights[item["openingId"]]
        assert obj.data.type == "AREA" and obj.data.shape == "RECTANGLE"
        assert abs(obj.data.size - opening["width"]) < 1e-5 and abs(obj.data.size_y - opening["height"]) < 1e-5
        expected_position = Vector((item["position"][0], -item["position"][2], item["position"][1]))
        assert (obj.location - expected_position).length < 1e-5
        inward = Vector((item["inward"][0], -item["inward"][2], item["inward"][1]))
        emitted = obj.matrix_world.to_quaternion() @ Vector((0, 0, -1))
        assert emitted.dot(inward) > .99999, "Window light must face into the room"
        vertical_axis = obj.matrix_world.to_quaternion() @ Vector((0, 1, 0))
        assert abs(vertical_axis.z) > .99999, "Rectangular window light height must stay vertical"
        center = Vector((item["center"][0], -item["center"][2], item["center"][1]))
        assert (center - obj.location).dot(inward) > wall["thickness"] / 2, "Source must sit outside wall"
    assert bool(actual_window_lights) == (lighting["mode"] == "window_daylight")
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
                photo = photo_entities.get(obj["entityId"])
                if photo is not None:
                    assert shaders and shaders[0].inputs["Base Color"].is_linked
                    assert not shaders[0].inputs["Normal"].is_linked, "Photo atlas must not reuse procedural UV normal maps"
                    assert shaders[0].inputs["Metallic"].default_value == 0
                    images = [node.image for node in material.node_tree.nodes if node.type == "TEX_IMAGE"]
                    assert len(images) == 1 and images[0].packed_file, "Observed pixels must travel in the blend"
                    assert list(images[0].size) == [photo["atlasWidth"], photo["atlasHeight"]]
                    assert images[0].colorspace_settings.name == "sRGB"
                    assert obj["appearanceStatus"] == ("photo_projected" if photo["coverage"] > 0 else "unobserved")
                    assert abs(obj["photoTextureCoverage"] - photo["coverage"]) < 1e-6
                    assert json.loads(obj["photoEvidenceIdsJson"]) == photo["evidenceIds"]
                    continue
                assert shaders and shaders[0].inputs["Normal"].is_linked, "PBR normal must reach the surface shader"
                images = [node.image for node in material.node_tree.nodes if node.type == "TEX_IMAGE"]
                assert images and all(image and image.packed_file for image in images), "Material maps must be packed"
                assert any(node.type == "NORMAL_MAP" and node.inputs["Color"].is_linked for node in material.node_tree.nodes), "Use a tangent-space normal map"
                assert any(image.colorspace_settings.name == "Non-Color" for image in images), "Normal maps are linear data"
                existing = obj["role"] == "existing_furniture"
                spec = None if existing else source_surfaces.get(obj["entityId"])
                expected_finish = spec["finish"] if spec else ("wood" if obj["role"] == "room_floor" else "paint")
                if window_profile:
                    assert obj["finish"] == material["finish"] == expected_finish
                    assert obj["appearanceStatus"] == ("sensor_proxy" if existing else "photo_estimate" if spec else "styling_default")
                    if spec and expected_finish != "wood":
                        encoded = [int(spec["color"][index:index + 2], 16) / 255 for index in (1, 3, 5)]
                        expected_color = [value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4 for value in encoded]
                        actual_color = shaders[0].inputs["Base Color"].default_value
                        assert max(abs(a - b) for a, b in zip(expected_color, actual_color)) < 1e-6
                        assert abs(shaders[0].inputs["Roughness"].default_value - spec["roughness"]) < 1e-6
                if expected_finish == "wood":
                    assert shaders[0].inputs["Base Color"].is_linked, "Wood needs a base-color texture"
                    assert shaders[0].inputs["Roughness"].is_linked, "Wood needs a roughness texture"
                    assert any(image.colorspace_settings.name == "sRGB" for image in images), "Base color uses sRGB"
for item in source.get("items", []):
    obj = entities[item["id"]]
    assert obj.type == "MESH" and obj["role"] == "existing_furniture"
    assert obj.users_collection and any(collection.name == "ExistingFurniture" for collection in obj.users_collection)
    assert not obj.hide_render and not obj.get("previewCutaway"), "Furniture must stay visible in previews"
    assert obj["roomId"] == item["roomId"] and obj["label"] == item["label"]
    assert obj["origin"] == "existing_owned" and obj["locked"] == item["locked"]
    assert obj["proxyGeometry"] == "sensor_bounding_box"
    assert json.loads(obj["dimensionsJson"]) == item["dimensions"]
    assert json.loads(obj["evidenceIdsJson"]) == item.get("evidenceIds", [])
    assert abs(obj.rotation_euler.z - item["rotationY"]) < 1e-6
    width, height, depth = item["dimensions"]
    assert max(abs(a - b) for a, b in zip(obj.dimensions, [width, depth, height])) < 1e-6
    expected_origin = Vector((item["position"][0], -item["position"][2], item["position"][1]))
    assert (obj.location - expected_origin).length < 1e-6, "Furniture origin is bottom center"
    # Independent canonical corners protect handedness, elevation and width/depth.
    cosine, sine = math.cos(item["rotationY"]), math.sin(item["rotationY"])
    corners = [(item["position"][0] + cosine * x + sine * z,
                item["position"][1] + y,
                item["position"][2] - sine * x + cosine * z)
               for x in (-width / 2, width / 2) for y in (0, height) for z in (-depth / 2, depth / 2)]
    actual = [(p.x, p.z, -p.y) for p in (obj.matrix_world @ Vector(v) for v in obj.bound_box)]
    assert all(min(math.dist(point, expected) for expected in corners) < 1e-5 for point in actual)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    assert abs(bm.calc_volume() - width * height * depth) < 1e-5
    bm.free()
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
