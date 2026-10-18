"""Actual Blender/JPEG proof of observed non-box topology and calibrated UVs."""
import hashlib
import json
from pathlib import Path
import struct
import sys

import bpy
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from reconstruction.photo_texturing import _load_photo
from reconstruction.surface_mesh import build_surface_mesh


def main():
    directory = Path(sys.argv[sys.argv.index("--") + 1])
    source_dir, output = directory / "source", directory / "output"
    source_dir.mkdir()
    (source_dir / "photos").mkdir()
    output.mkdir()
    identity = {"projectId": "synthetic", "jobId": "observed-mesh-test", "inputRevision": 0}
    ident = "photo-00000000-0000-4000-8000-000000000001"
    photo_path = source_dir / "photos" / (ident + ".jpg")
    rgba = np.ones((256,256,4), dtype=np.float32)
    rgba[:128,:128,:3] = [.1,.2,.8]  # Blender bottom-left pixel storage.
    rgba[:128,128:,:3] = [.8,.7,.1]
    rgba[128:,:128,:3] = [.25,.5,.75]
    rgba[128:,128:,:3] = [.1,.8,.2]
    image = bpy.data.images.new("Synthetic camera RGB", width=256, height=256)
    image.pixels.foreach_set(rgba.ravel())
    image.file_format = "JPEG"
    image.filepath_raw = str(photo_path)
    image.save()
    bpy.data.images.remove(image)
    photo_data = photo_path.read_bytes()
    # Keep one explicitly synthetic decoded JPEG for the outer worker regression.
    (directory / "synthetic-camera.jpg").write_bytes(photo_data)
    photo = {"id": ident, "path": "photos/" + photo_path.name,
        "sha256": hashlib.sha256(photo_data).hexdigest(), "byteLength": len(photo_data),
        "width": 256, "height": 256, "capturedAt": "2026-10-18T10:05:41Z", "arTimestamp": 100,
        "cameraToWorld": [1,0,0,0,0,1,0,0,0,0,1,0,0,1.25,3,1],
        "intrinsics": [180,0,0,0,180,0,128,128,1], "trackingState": "normal", "evidenceId": "photo-evidence"}
    # The first four faces form an irregular pyramid patch, not a bounding box.
    # A front triangle occludes a small triangle behind it. Separate back-facing,
    # behind-camera and out-of-frame triangles must retain plain fallback.
    vertices = [[-1,-1,0],[1,-1,0],[.8,.8,0],[-.8,1,0],[0,0,.25],
                [-.4,-.4,.6],[.4,-.4,.6],[0,.4,.6],
                [-.05,-.05,0],[.05,-.05,0],[0,.05,0],
                [1.1,.2,0],[1.3,.2,0],[1.2,.4,0],
                [-.1,-.1,4],[.1,-.1,4],[0,.1,4],
                [5,0,0],[5.2,0,0],[5.1,.2,0]]
    faces = [[0,1,4],[1,2,4],[2,3,4],[3,0,4], [5,6,7], [8,9,10],
             [11,13,12], [14,15,16], [17,18,19]]
    mesh_packet = {"schemaVersion": "roomplan-mesh/1.0", **identity,
        "coordinateSystem": "arkit-gravity-y-up-metres", "captureMethod": "arkit-scene-reconstruction",
        "anchors": [{"id": "mesh-00000000-0000-4000-8000-000000000001",
            "transform": [1,0,0,0,0,1,0,0,0,0,1,0,0,1.25,0,1],
            "vertices": vertices, "faces": faces, "classifications": [1,1,1,1,0,1,1,0,0]}]}
    mesh_data = json.dumps(mesh_packet).encode()
    (source_dir / "mesh.json").write_bytes(mesh_data)
    scene_data = json.dumps({**identity, "evidence": [{"id": "photo-evidence"}]}).encode()
    (output / "scene.json").write_bytes(scene_data)
    source = {"schemaVersion": "roomplan-texture-source/1.0", **identity,
        "inputSha256": hashlib.sha256(scene_data).hexdigest(), "sourceArchiveSha256": "a" * 64,
        "sourceToCanonicalTranslation": [0,-1.25,0], "photos": [photo],
        "mesh": {"path": "mesh.json", "sha256": hashlib.sha256(mesh_data).hexdigest(), "byteLength": len(mesh_data)}}
    source_path = source_dir / "photo-input.json"
    source_path.write_text(json.dumps(source))
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    objects, summary = build_surface_mesh(source_path, output)
    assert len(objects) == 1
    obj = objects[0]
    bpy.context.view_layer.update()
    assert obj["role"] == "captured_surface"
    assert len(obj.data.vertices) == len(vertices)
    assert [list(p.vertices) for p in obj.data.polygons] == faces
    assert summary["vertexCount"] == len(vertices) and summary["triangleCount"] == len(faces)
    assert summary["triangleSourceIndices"][4] == 0, summary
    assert summary["triangleSourceIndices"][5:] == [-1,-1,-1,-1], summary
    assert summary["observedTriangleCount"] >= 1 and summary["unobservedTriangleCount"] >= 4
    for index, point in enumerate(vertices):
        world = obj.matrix_world @ obj.data.vertices[index].co
        assert np.max(np.abs(np.array(world) - [point[0],-point[2],point[1]])) < 1e-6, world
    # Exact coordinate proof: native identity camera at z=3, so u=180*x/(3-z)+128.
    # V must invert raw sensor top-left coordinates to Blender texture bottom-left.
    for polygon in obj.data.polygons:
        if summary["triangleSourceIndices"][polygon.index] < 0:
            assert polygon.material_index == 0
            continue
        for loop_index, vertex_index in zip(polygon.loop_indices, polygon.vertices):
            x,y,z = vertices[vertex_index]
            expected = [(180*x/(3-z)+128)/256, 1- (128-180*y/(3-z))/256]
            assert np.max(np.abs(np.array(obj.data.uv_layers.active.data[loop_index].uv)-expected)) < 1e-6
    # Check decoded JPEG and packed PNG agree at non-primary colored samples.
    decoded = _load_photo(photo_path, photo)
    packed = next(n.image for n in obj.data.materials[1].node_tree.nodes if n.type == "TEX_IMAGE")
    assert packed.packed_file
    values = np.empty(len(packed.pixels), dtype=np.float32)
    packed.pixels.foreach_get(values)
    actual = values.reshape((256,256,4))[::-1,:,:3]
    for x,y in [(80,80),(176,80),(80,176),(176,176)]:
        assert np.max(np.abs(actual[y,x]-decoded[y,x])) < .005, (actual[y,x],decoded[y,x])
    # A rotated/translated anchor with inverse-adjusted local vertices describes
    # the exact same observed world surface. Neither pose nor floor normalization
    # may be applied twice, and camera visibility/UVs must remain identical.
    alternate = json.loads(json.dumps(mesh_packet))
    rotation = np.array([[0.,-1.,0.],[1.,0.,0.],[0.,0.,1.]])
    center = np.array([.7,1.6,-.2])
    original_world = np.array(vertices) + [0,1.25,0]
    alternate["anchors"][0]["vertices"] = ((original_world-center) @ rotation).tolist()
    matrix = np.eye(4)
    matrix[:3,:3], matrix[:3,3] = rotation, center
    alternate["anchors"][0]["transform"] = matrix.flatten(order="F").tolist()
    alternate_data = json.dumps(alternate).encode()
    (source_dir / "mesh.json").write_bytes(alternate_data)
    source["mesh"].update(sha256=hashlib.sha256(alternate_data).hexdigest(), byteLength=len(alternate_data))
    source_path.write_text(json.dumps(source))
    output_two = directory / "rotated-output"
    output_two.mkdir()
    (output_two / "scene.json").write_bytes(scene_data)
    other_objects, other_summary = build_surface_mesh(source_path, output_two)
    bpy.context.view_layer.update()
    assert other_summary["triangleSourceIndices"] == summary["triangleSourceIndices"]
    for first, second in zip(obj.data.vertices, other_objects[0].data.vertices):
        assert (obj.matrix_world @ first.co - other_objects[0].matrix_world @ second.co).length < 1e-6
    for first, second in zip(obj.data.uv_layers.active.data, other_objects[0].data.uv_layers.active.data):
        assert (first.uv-second.uv).length < 1e-6
    bpy.data.objects.remove(other_objects[0], do_unlink=True)
    # GLB must contain original triangle counts, embedded PNGs and unlit material.
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.wm.save_as_mainfile(filepath=str(directory / "observed.blend"))
    bpy.ops.export_scene.gltf(filepath=str(directory / "observed.glb"), export_format="GLB",
        use_selection=True, export_yup=True, export_extras=True, export_cameras=False, export_lights=False)
    body = (directory / "observed.glb").read_bytes()
    length = struct.unpack_from("<I", body, 12)[0]
    gltf = json.loads(body[20:20+length])
    assert len(gltf["images"]) == 1 and "bufferView" in gltf["images"][0] and "uri" not in gltf["images"][0]
    assert "KHR_materials_unlit" in gltf.get("extensionsUsed", []), gltf["materials"]
    assert sum(gltf["accessors"][primitive["indices"]]["count"]//3
               for mesh in gltf["meshes"] for primitive in mesh["primitives"]) == len(faces)
    # Remove staged original bytes and reopen the saved .blend: packed pixels stay.
    photo_path.unlink()
    (source_dir / "mesh.json").unlink()
    bpy.ops.wm.open_mainfile(filepath=str(directory / "observed.blend"))
    reopened = bpy.data.objects[mesh_packet["anchors"][0]["id"]]
    assert len(reopened.data.polygons) == len(faces)
    assert all(n.image.packed_file for m in reopened.data.materials for n in m.node_tree.nodes if n.type == "TEX_IMAGE")
    print("TADAIMA_OBSERVED_SURFACE_VERIFIED: original irregular topology, canonical pose once, occlusion, backfaces, offscreen, behind-camera, actual JPEG pixels, calibrated triangle UVs, embedded unlit GLB, packed Blender portability")


main()
