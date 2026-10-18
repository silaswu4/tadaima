"""Runs inside Blender to independently reopen and inspect a generated scene."""

import json
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Vector

directory = Path(sys.argv[sys.argv.index("--") + 1])
source = json.loads((directory / "scene.json").read_text())
manifest = json.loads((directory / "manifest.json").read_text())
bpy.ops.wm.open_mainfile(filepath=str(directory / "scene.blend"))
scene = bpy.context.scene
assert scene.unit_settings.system == "METRIC"
assert scene.unit_settings.scale_length == 1.0
assert int(scene["inputRevision"]) == source["inputRevision"]
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
print("TADAIMA_BLEND_VERIFIED " + json.dumps({"entityCount": len(entities), "editable": True}))
