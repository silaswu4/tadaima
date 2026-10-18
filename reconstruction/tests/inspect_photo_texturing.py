"""Real Blender projection tests using synthetic rendered camera photographs.

These images prove calibration, source placement and occlusion, not a physical
iPhone scan. Run through test_photo_texturing_blender.py.
"""

import hashlib
import json
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Matrix, Vector
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from reconstruction.photo_texturing import AXES, _load_photo, apply_photo_textures


def material(name, srgb, emission=False):
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    rgb = np.array(srgb)
    linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
    shader = result.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*linear, 1)
    if emission:
        shader.inputs["Emission Color"].default_value = (*linear, 1)
        shader.inputs["Emission Strength"].default_value = 1
        shader.inputs["Base Color"].default_value = (0, 0, 0, 1)
    return result


def board(name, left, right, bottom, top, mat, *, reverse=False):
    mesh = bpy.data.meshes.new(name)
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    vertices = [(left if x < 0 else right, 0, bottom if y < 0 else top) for x, y in corners]
    mesh.from_pydata(vertices, [], [(0, 3, 2, 1) if reverse else (0, 1, 2, 3)])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    mesh.materials.append(mat)
    obj["entityId"], obj["role"] = name, "wall"
    return obj


def floor(name, mat):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(-1, -2, -1.2), (1, -2, -1.2), (1, 0, -1.2), (-1, 0, -1.2)], [], [(0, 1, 2, 3)])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    mesh.materials.append(mat)
    obj["entityId"], obj["role"] = name, "room_floor"
    return obj


def raw_pose(camera):
    matrix = np.array(camera.matrix_world)
    result = np.eye(4)
    result[:3, :3] = AXES.T @ matrix[:3, :3]
    result[:3, 3] = AXES.T @ matrix[:3, 3] + np.array([0, 1.5, 0])
    return result.flatten(order="F").tolist()


def render_photo(directory, camera, index):
    scene = bpy.context.scene
    scene.camera = camera
    name = f"photo-00000000-0000-4000-8000-{index:012d}"
    path = directory / "photos" / (name + ".jpg")
    scene.render.filepath = str(path)
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 100
    bpy.ops.render.render(write_still=True)
    data = path.read_bytes()
    return {"id": name, "path": "photos/" + path.name,
            "sha256": hashlib.sha256(data).hexdigest(), "byteLength": len(data),
            "width": 256, "height": 256, "capturedAt": "2026-10-18T10:05:41Z",
            "arTimestamp": 10 + index, "cameraToWorld": raw_pose(camera),
            "intrinsics": [180, 0, 0, 0, 180, 0, 128, 128, 1],
            "trackingState": "normal", "evidenceId": "synthetic-photo-" + str(index)}


def sample(obj, point, polygon_index=0):
    polygon = obj.data.polygons[polygon_index]
    corners = np.array([(obj.matrix_world @ obj.data.vertices[i].co)[:] for i in polygon.vertices])
    uv = np.array([obj.data.uv_layers.active.data[i].uv[:] for i in polygon.loop_indices])
    axes = np.argsort(np.ptp(corners, axis=0))[-2:]
    coefficients = np.linalg.lstsq(np.column_stack((corners[:, axes], np.ones(len(corners)))), uv, rcond=None)[0]
    coordinate = np.append(np.array(point)[axes], 1) @ coefficients
    image = next(node.image for node in obj.data.materials[0].node_tree.nodes if node.type == "TEX_IMAGE")
    pixels = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(pixels)
    width, height = image.size
    pixel = np.clip(np.floor(coordinate * [width, height]).astype(int), [0, 0], [width - 1, height - 1])
    return pixels.reshape((height, width, 4))[pixel[1], pixel[0], :3]


def prepare_source(directory, photos):
    directory.mkdir()
    scene_data = json.dumps({"projectId": "synthetic", "jobId": "projection-test", "inputRevision": 0}).encode()
    (directory / "scene.json").write_bytes(scene_data)
    source = {"schemaVersion": "roomplan-texture-source/1.0", "projectId": "synthetic", "jobId": "projection-test",
              "inputRevision": 0, "inputSha256": hashlib.sha256(scene_data).hexdigest(),
              "sourceArchiveSha256": "a" * 64, "sourceToCanonicalTranslation": [0, -1.5, 0], "photos": photos}
    path = directory.parent / (directory.name + "-source.json")
    path.write_text(json.dumps(source))
    return path


def main():
    directory = Path(sys.argv[sys.argv.index("--") + 1])
    (directory / "photos").mkdir()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 1
    scene.cycles.use_denoising = False
    scene.world.color = (0, 0, 0)
    scene.render.resolution_x = scene.render.resolution_y = 256
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    colors = [("tl", -.999, 0, 0, .999, (.25, .5, .75)),
              ("tr", 0, .999, 0, .999, (.1, .85, .15)),
              ("bl", -.999, 0, -.999, 0, (.1, .15, .9)),
              ("br", 0, .999, -.999, 0, (.85, .8, .1))]
    reference = [board(name, left, right, bottom, top, material(name, color, True))
                 for name, left, right, bottom, top, color in colors]
    reference.append(floor("reference-floor", material("source-tan-floor", (.55, .4, .25), True)))
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -1, 0))
    furniture = bpy.context.object
    furniture.name = "existing-box"
    furniture.scale = (.5, .5, .5)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    furniture.data.materials.append(material("source-magenta", (.85, .1, .75), True))
    furniture["entityId"], furniture["role"] = "existing-box", "existing_furniture"
    camera_data = bpy.data.cameras.new("CalibrationCamera")
    camera = bpy.data.objects.new("CalibrationCamera", camera_data)
    scene.collection.objects.link(camera)
    camera_data.sensor_width, camera_data.lens, camera_data.sensor_fit = 36, 180 * 36 / 256, "HORIZONTAL"
    camera.matrix_world = Matrix(((1, 0, 0, 0), (0, 0, -1, -3), (0, 1, 0, 0), (0, 0, 0, 1)))
    bpy.context.view_layer.update()
    first_photo = render_photo(directory, camera, 1)
    camera.location = (1.5, -3, 0)
    camera.rotation_euler = (-camera.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.view_layer.update()
    second_photo = render_photo(directory, camera, 2)
    for obj in reference:
        bpy.data.objects.remove(obj, do_unlink=True)
    fallback = material("plain-fallback", (.35, .35, .35))
    wall = board("target-wall", -1, 1, -1, 1, fallback)
    target_floor = floor("target-floor", fallback)
    unobserved = board("outside-photo", 5, 6, 0, 1, fallback)
    backface = board("back-facing", -1, 1, -1, 1, fallback, reverse=True)
    backface.location.y = .1
    behind = board("behind-camera", -1, 1, -1, 1, fallback)
    behind.location.y = -4
    furniture.data.materials.clear()
    furniture.data.materials.append(fallback)
    # Preview-hidden meshes must still occlude captured rays.
    furniture.hide_render, furniture["previewCutaway"] = True, True
    objects = [wall, furniture, unobserved, backface, target_floor, behind]
    bpy.context.view_layer.update()
    topology = {obj.name: (len(obj.data.vertices), len(obj.data.edges), [tuple(p.vertices) for p in obj.data.polygons],
                           tuple(v for row in obj.matrix_world for v in row)) for obj in objects}
    output = directory / "single"
    source = prepare_source(output, [first_photo])
    summary = apply_photo_textures(objects, source, output)
    entities = {item["entityId"]: item for item in summary["entities"]}
    assert summary["atlasTexels"] <= 8_000_000
    assert entities["target-wall"]["status"] == "captured_photo_partial", entities
    assert entities["target-wall"]["coverage"] > .5, entities["target-wall"]
    assert entities["outside-photo"]["status"] == "unobserved"
    assert entities["back-facing"]["status"] == "unobserved"
    assert entities["behind-camera"]["status"] == "unobserved"
    assert entities["existing-box"]["observedTexels"] > 0
    assert entities["target-floor"]["observedTexels"] > 0
    assert np.max(np.abs(sample(target_floor, (.6, -.3, -1.2)) - [.55, .4, .25])) < .045
    assert any(face["status"] == "captured_photo_covered" for face in entities["existing-box"]["faces"])
    assert entities["target-wall"]["photoIds"] == [first_photo["id"]]
    assert entities["target-wall"]["evidenceIds"] == [first_photo["evidenceId"]]
    expected_points = [((-.7, 0, .7), (.25, .5, .75)), ((.7, 0, .7), (.1, .85, .15)),
                       ((-.7, 0, -.7), (.1, .15, .9)), ((.7, 0, -.7), (.85, .8, .1))]
    for point, expected in expected_points:
        actual = sample(wall, point)
        assert np.max(np.abs(actual - expected)) < .045, (point, actual, expected)
    occluded = sample(wall, (.1, 0, .1))
    assert np.max(np.abs(occluded - [.35, .35, .35])) < .02, occluded
    assert np.max(np.abs(sample(unobserved, (5.5, 0, .5)) - [.35] * 3)) < .02
    assert furniture.hide_render, "Texturing must preserve preview visibility state"
    # Saving and reloading the PNG catches encoded/linear RGB mistakes in
    # generated Blender images, including a deliberately non-primary color.
    image = bpy.data.images.load(str(output / entities["target-wall"]["atlas"]), check_existing=False)
    packed = next(n.image for n in wall.data.materials[0].node_tree.nodes if n.type == "TEX_IMAGE")
    assert packed.packed_file
    saved_pixels = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(saved_pixels)
    original_pixels = np.empty(len(packed.pixels), dtype=np.float32)
    packed.pixels.foreach_get(original_pixels)
    assert np.max(np.abs(saved_pixels - original_pixels)) < .005, "PNG save changed captured RGB transfer"
    bpy.data.images.remove(image)
    for obj in objects:
        actual = (len(obj.data.vertices), len(obj.data.edges), [tuple(p.vertices) for p in obj.data.polygons],
                  tuple(v for row in obj.matrix_world for v in row))
        assert topology[obj.name] == actual, "Photo projection changed topology or object transform"
    # The second calibrated camera can see the wall patch hidden in photo one.
    output_two = directory / "multiple"
    source_two = prepare_source(output_two, [first_photo, second_photo])
    summary_two = apply_photo_textures(objects, source_two, output_two)
    target_two = next(item for item in summary_two["entities"] if item["entityId"] == "target-wall")
    assert second_photo["id"] in target_two["photoIds"], target_two
    assert target_two["coverage"] > entities["target-wall"]["coverage"], target_two
    revealed = sample(wall, (.1, 0, .1))
    assert np.max(np.abs(revealed - [.1, .85, .15])) < .06, revealed
    bpy.ops.wm.save_as_mainfile(filepath=str(directory / "projection.blend"))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(directory / "projection.glb"), export_format="GLB",
                              use_selection=True, export_yup=True, export_cameras=False, export_lights=False)
    glb = (directory / "projection.glb").read_bytes()
    length = struct.unpack_from("<I", glb, 12)[0]
    document = json.loads(glb[20:20 + length])
    assert len(document["images"]) == len(objects)
    assert all("bufferView" in image and "uri" not in image for image in document["images"])
    assert all("baseColorTexture" in material["pbrMetallicRoughness"] for material in document["materials"])
    (directory / "projection-summary.json").write_text(json.dumps(summary_two, indent=2))
    print("TADAIMA_PHOTO_TEXTURES_VERIFIED: orientation, midtone RGB, calibrated translation, occlusion, hidden meshes, multiple views, plain fallback, unchanged geometry, packed images, embedded GLB")


main()
