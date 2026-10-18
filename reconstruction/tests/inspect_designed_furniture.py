"""Real Blender template and portable GLB integration; synthetic style evidence."""
import json
import math
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from reconstruction.designed_furniture import MODELS, build_designed_furniture

output = Path(sys.argv[sys.argv.index("--") + 1])
output.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
collection = bpy.data.collections.new("DesignedFurnitureTests")
bpy.context.scene.collection.children.link(collection)
results = []
for index, model in enumerate(sorted(MODELS)):
    item = {"id": "synthetic-" + model, "label": "Detected " + model, "roomId": "synthetic-room",
            "origin": "existing_owned", "locked": True, "evidenceIds": ["synthetic-sensor"],
            "position": [index * 3., .27 if model.endswith("table") else 0., -1.2],
            "rotationY": .63 if index % 2 else -.31,
            "dimensions": [1.8, .9, .82] if model.endswith("sofa") else [1.3, .76, .84] if model.endswith("table") else [.66, .93, .64]}
    spec = {"itemId": item["id"], "label": "Synthetic photo-informed " + model, "model": model,
            "primaryColor": "#a8885b", "secondaryColor": "#ded7cb", "frameColor": "#aab1b4", "accentColor": "#d0c59b",
            "pattern": "dash" if model == "box_arm_chair" else "plain", "seatCount": 3 if model.endswith("sofa") else 1,
            "confidence": "medium", "evidenceIds": ["synthetic-photo"], "notes": "Synthetic test style only"}
    obj = build_designed_furniture(item, spec, collection)
    bpy.context.view_layer.update()
    bm = bmesh.new(); bm.from_mesh(obj.data)
    assert all(edge.is_manifold for edge in bm.edges), model + " is not closed"
    volume = bm.calc_volume(signed=True)
    assert volume > 0, model + " has inverted normals"
    bm.free()
    width, height, depth = item["dimensions"]
    for axis, lower, upper in ((0, -width / 2, width / 2), (1, -depth / 2, depth / 2), (2, 0, height)):
        values = [v.co[axis] for v in obj.data.vertices]
        assert abs(min(values) - lower) < 1e-6 and abs(max(values) - upper) < 1e-6, (model, axis, min(values), max(values))
    assert tuple(obj.scale) == (1, 1, 1) and not obj.modifiers
    expected = Vector((item["position"][0], -item["position"][2], item["position"][1]))
    assert (obj.location - expected).length < 1e-6
    assert abs(obj.rotation_euler.z - item["rotationY"]) < 1e-6
    assert obj["representation"] == "photo_informed_parametric" and obj["appearanceStatus"] == "photo_inferred"
    assert obj["entityId"] == item["id"] and json.loads(obj["evidenceIdsJson"]) == item["evidenceIds"]
    assert json.loads(obj["photoEvidenceIdsJson"]) == spec["evidenceIds"]
    triangle_count = sum(len(face.vertices) - 2 for face in obj.data.polygons)
    assert triangle_count > 12, model + " must not be a plain twelve-triangle box"
    if model != "unresolved_proxy":
        assert volume < width * height * depth * .94, model + " should retain open space around its parts"
    if spec["pattern"] == "dash":
        images = [node.image for material in obj.data.materials for node in material.node_tree.nodes if node.type == "TEX_IMAGE"]
        assert len(images) == 1 and images[0].packed_file and list(images[0].size) == [128, 128]
    assert all(math.isfinite(value) for loop in obj.data.uv_layers.active.data for value in loop.uv)
    results.append({"model": model, "triangles": triangle_count, "volume": volume, "item": item})
bpy.context.scene["syntheticTestOnly"] = True
bpy.ops.wm.save_as_mainfile(filepath=str(output / "designed-furniture.blend"))
bpy.ops.export_scene.gltf(filepath=str(output / "designed-furniture.glb"), export_format="GLB", export_yup=True,
                          export_extras=True, export_materials="EXPORT", export_animations=False, export_cameras=False, export_lights=False)
(output / "designed-furniture-check.json").write_text(json.dumps(results, indent=2) + "\n")
print("TADAIMA_DESIGNED_FURNITURE_VERIFIED", len(results))
