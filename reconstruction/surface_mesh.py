"""Observed ARKit surfaces with calibrated, visibility-checked photograph UVs.

Runs inside Blender. No room/furniture boxes are used to invent scan topology.
Each original anchor remains separately editable; its faces are never filled,
smoothed, remeshed or separated into guessed furniture instances.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
import numpy as np

from reconstruction.photo_texturing import AXES, MIN_COSINE, NEAR, _projection
from reconstruction.roomplan.mesh import MAX_MESH_BYTES, validate_mesh
from reconstruction.roomplan.photo_bundle import _json, _validate_manifest

MAX_PACKED_PHOTO_BYTES = 1024 * 1024
CHUNK = 20_000


def _bytes(path, maximum, expected):
    with Path(path).open("rb") as stream:
        data = stream.read(maximum + 1)
    if (not 0 < len(data) <= maximum or len(data) != expected["byteLength"]
            or hashlib.sha256(data).hexdigest() != expected["sha256"]):
        raise ValueError("Observed surface source bytes changed after validation")
    return data


def _photo_material(path, metadata, output, index):
    """Pack actual captured RGB with bounded PNG bytes, preserving sensor axes."""
    _bytes(path, 2 * 1024 * 1024, metadata)
    image = bpy.data.images.load(str(path), check_existing=False)
    if list(image.size) != [metadata["width"], metadata["height"]]:
        bpy.data.images.remove(image)
        raise ValueError("Decoded photograph dimensions differ from saved calibration")
    original_size = tuple(image.size)
    destination = output / f"surface-photo-{index:02d}.png"
    for side in (1024, 768, 512, 256):
        ratio = min(1., side / max(original_size))
        image.scale(max(1, round(original_size[0] * ratio)), max(1, round(original_size[1] * ratio)))
        image.file_format = "PNG"
        image.filepath_raw = str(destination)
        image.save()
        destination.chmod(0o600)
        if destination.stat().st_size <= MAX_PACKED_PHOTO_BYTES:
            break
    else:
        bpy.data.images.remove(image)
        raise ValueError("Captured photograph PNG exceeds bounded output bytes")
    data = destination.read_bytes()
    image.filepath_raw = "//surface-textures/" + destination.name
    image.pack(data=data, data_len=len(data))
    material = bpy.data.materials.new("ObservedRGB_" + metadata["id"])
    material.use_nodes = True
    material.diffuse_color = (.7, .7, .7, 1)
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    node = nodes.new("ShaderNodeTexImage")
    node.image, node.interpolation, node.extension = image, "Linear", "EXTEND"
    node.label = "Captured camera RGB with original illumination"
    uv = nodes.new("ShaderNodeUVMap")
    uv.uv_map = "UVMap"
    target = nodes.new("ShaderNodeOutputMaterial")
    links.new(uv.outputs["UV"], node.inputs["Vector"])
    # Blender's glTF exporter explicitly recognizes color-to-Surface as unlit.
    # An Emission shader alone instead exports a PBR emissive texture.
    links.new(node.outputs["Color"], target.inputs["Surface"])
    material["photoId"], material["evidenceId"] = metadata["id"], metadata["evidenceId"]
    material["appearanceSource"] = "observed_camera_rgb"
    return material


def _fallback_material():
    material = bpy.data.materials.new("UnobservedSurface")
    material.use_nodes = True
    material.diffuse_color = (.45, .45, .45, 1)
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (.45, .45, .45, 1)
    shader.inputs["Roughness"].default_value = .9
    material["appearanceSource"] = "unobserved_plain_fallback"
    return material


def _best_candidates(triangles, photos, translation):
    """Keep at most three cameras per triangle; bound temporary NumPy arrays."""
    candidates = np.full((len(triangles), 3), -1, dtype=np.int16)
    best = np.zeros((len(triangles), 3), dtype=np.float32)
    cameras = []
    for index, photo in enumerate(photos):
        native = np.array(photo["cameraToWorld"]).reshape((4, 4), order="F")
        rotation = AXES @ native[:3, :3]
        center = AXES @ (native[:3, 3] + translation)
        calibration = np.array(photo["intrinsics"]).reshape((3, 3), order="F")
        cameras.append((rotation, center, calibration))
        for start in range(0, len(triangles), CHUNK):
            stop = min(start + CHUNK, len(triangles))
            chunk = triangles[start:stop]
            centroid = chunk.mean(axis=1)
            normal = np.cross(chunk[:, 1] - chunk[:, 0], chunk[:, 2] - chunk[:, 0])
            normal /= np.maximum(np.linalg.norm(normal, axis=1), 1e-20)[:, None]
            toward_camera = center - centroid
            cosine = np.sum(normal * toward_camera, axis=1) / np.maximum(np.linalg.norm(toward_camera, axis=1), 1e-12)
            screen, depth = _projection(chunk.reshape((-1, 3)), rotation, center, calibration)
            screen, depth = screen.reshape((-1, 3, 2)), depth.reshape((-1, 3))
            valid = ((cosine > MIN_COSINE) & np.all(depth > NEAR, axis=1)
                     & np.all(screen[:, :, 0] >= 1, axis=1) & np.all(screen[:, :, 0] < photo["width"] - 2, axis=1)
                     & np.all(screen[:, :, 1] >= 1, axis=1) & np.all(screen[:, :, 1] < photo["height"] - 2, axis=1))
            score = np.where(valid, cosine ** 2 * calibration[0, 0] * calibration[1, 1]
                             / np.maximum(depth.mean(axis=1) ** 2, .01), 0)
            local_scores, local_candidates = best[start:stop], candidates[start:stop]
            slot = np.argmin(local_scores, axis=1)
            row = np.arange(stop - start)
            improved = score > local_scores[row, slot]
            local_scores[row[improved], slot[improved]] = score[improved]
            local_candidates[row[improved], slot[improved]] = index
    order = np.argsort(-best, axis=1, kind="stable")
    return np.take_along_axis(candidates, order, axis=1), cameras


def _visible(bvh, triangle, center):
    centroid = triangle.mean(axis=0)
    # Inner corner samples avoid unstable hits exactly on shared triangle edges.
    samples = [centroid, *(triangle * .85 + centroid * .15)]
    for point in samples:
        direction = point - center
        distance = float(np.linalg.norm(direction))
        tolerance = .004 + distance * .001
        _, _, _, hit_distance = bvh.ray_cast(Vector(center), Vector(direction / distance), distance + tolerance)
        if hit_distance is None or abs(hit_distance - distance) > tolerance:
            return False
    return True


def build_surface_mesh(source_path: Path, output: Path):
    """Build observed anchors, bind actual photos and return (objects, summary)."""
    source_path, output = Path(source_path).resolve(), Path(output).resolve()
    source = _json(source_path.read_bytes())
    if source.get("schemaVersion") != "roomplan-texture-source/1.0" or "mesh" not in source:
        raise ValueError("Observed surface generation requires a staged mesh source")
    scene_bytes = (output / "scene.json").read_bytes()
    if hashlib.sha256(scene_bytes).hexdigest() != source["inputSha256"]:
        raise ValueError("Observed surface source does not match scene input bytes")
    request = _json(scene_bytes)
    if any(source[key] != request[key] for key in ("projectId", "jobId", "inputRevision")):
        raise ValueError("Observed surface source identity differs from scene")
    mesh_ref = source["mesh"]
    if mesh_ref.get("path") != "mesh.json":
        raise ValueError("Observed surface mesh must use its private canonical path")
    mesh_path = source_path.parent / "mesh.json"
    if mesh_path.is_symlink() or not mesh_path.resolve().is_relative_to(source_path.parent):
        raise ValueError("Observed surface mesh escapes private source directory")
    packet = validate_mesh(_json(_bytes(mesh_path, MAX_MESH_BYTES, mesh_ref)), request)
    translation = np.array(source["sourceToCanonicalTranslation"], dtype=np.float64)
    if translation.shape != (3,) or not np.isfinite(translation).all() or np.max(np.abs(translation)) > 10_000:
        raise ValueError("Invalid source-to-canonical translation")
    # Revalidate source photos using the same strict metadata boundary as ZIPs.
    photos = source["photos"]
    metadata = [{key: value for key, value in photo.items() if key != "evidenceId"} for photo in photos]
    _validate_manifest({"schemaVersion": "roomplan-photo-bundle/1.1",
        **{key: source[key] for key in ("projectId", "jobId", "inputRevision")},
        "coordinateSystem": "arkit-gravity-y-up-metres", "imageConvention": "raw-sensor-top-left",
        "scan": {"path": "roomplan.json", "sha256": "0" * 64}, "mesh": mesh_ref, "photos": metadata}, request)
    evidence = {entry["id"] for entry in request["evidence"]}
    for photo in photos:
        if photo.get("evidenceId") not in evidence:
            raise ValueError("Observed surface photograph lacks scene evidence")
        path = source_path.parent / photo["path"]
        if path.is_symlink() or not path.resolve().is_relative_to(source_path.parent):
            raise ValueError("Observed surface photograph escapes private source directory")
        _bytes(path, 2 * 1024 * 1024, photo)
    if sum(photo["byteLength"] for photo in photos) > 32 * 1024 * 1024:
        raise ValueError("Observed surface photos exceed byte budget")
    collection = bpy.data.collections.new("CapturedSurfaceReference")
    bpy.context.scene.collection.children.link(collection)
    objects, vertices, faces = [], [], []
    for anchor in packet["anchors"]:
        native = np.array(anchor["transform"]).reshape((4, 4), order="F")
        local_vertices = np.array(anchor["vertices"]) @ AXES.T
        transform = np.eye(4)
        transform[:3, :3] = AXES @ native[:3, :3] @ AXES.T
        transform[:3, 3] = AXES @ (native[:3, 3] + translation)
        mesh = bpy.data.meshes.new(anchor["id"])
        mesh.from_pydata(local_vertices.tolist(), [], anchor["faces"])
        mesh.update()
        classes = mesh.attributes.new("ARMeshClassification", "INT", "FACE")
        classes.data.foreach_set("value", anchor["classifications"])
        obj = bpy.data.objects.new(anchor["id"], mesh)
        collection.objects.link(obj)
        obj.matrix_world = Matrix(transform.tolist())
        obj["entityId"], obj["role"] = anchor["id"], "captured_surface"
        obj["captureMethod"], obj["meshSha256"] = packet["captureMethod"], mesh_ref["sha256"]
        obj["sourceVertexCount"], obj["sourceTriangleCount"] = len(local_vertices), len(anchor["faces"])
        obj["sourceAnchorTransformJson"] = json.dumps(anchor["transform"], separators=(",", ":"))
        obj["representation"] = "observed_surface_mesh"
        offset = len(vertices)
        vertices.extend((local_vertices @ transform[:3, :3].T + transform[:3, 3]).tolist())
        faces.extend(tuple(index + offset for index in face) for face in anchor["faces"])
        objects.append(obj)
    triangles = np.asarray(vertices, dtype=np.float64)[np.asarray(faces, dtype=np.int32)]
    bvh = BVHTree.FromPolygons(vertices, faces, all_triangles=True)
    candidates, cameras = _best_candidates(triangles, photos, translation)
    winners = np.full(len(triangles), -1, dtype=np.int16)
    for index, triangle in enumerate(triangles):
        for candidate in candidates[index]:
            if candidate >= 0 and _visible(bvh, triangle, cameras[int(candidate)][1]):
                winners[index] = candidate
                break
    texture_output = output / "surface-textures"
    texture_output.mkdir(mode=0o700, exist_ok=False)
    used = sorted(int(index) for index in np.unique(winners) if index >= 0)
    materials = {index: _photo_material(source_path.parent / photos[index]["path"], photos[index], texture_output, index)
                 for index in used}
    fallback = _fallback_material()
    offset = 0
    for obj in objects:
        obj.data.materials.append(fallback)
        slots = {}
        local_winners = winners[offset:offset + len(obj.data.polygons)]
        for index in sorted(int(i) for i in np.unique(local_winners) if i >= 0):
            slots[index] = len(obj.data.materials)
            obj.data.materials.append(materials[index])
        uv = obj.data.uv_layers.new(name="UVMap")
        for polygon in obj.data.polygons:
            winner = int(local_winners[polygon.index])
            if winner >= 0:
                polygon.material_index = slots[winner]
                rotation, center, calibration = cameras[winner]
                screen, _ = _projection(triangles[offset + polygon.index], rotation, center, calibration)
                coordinates = np.column_stack((screen[:, 0] / photos[winner]["width"],
                                                1 - screen[:, 1] / photos[winner]["height"]))
                for loop, coordinate in zip(polygon.loop_indices, coordinates):
                    uv.data[loop].uv = coordinate
        observed = int(np.count_nonzero(local_winners >= 0))
        obj["appearanceStatus"] = "photo_projected" if observed else "unobserved"
        obj["photoTextureCoverage"] = observed / len(local_winners)
        obj["photoEvidenceIdsJson"] = json.dumps([photos[i]["evidenceId"] for i in sorted(slots)], separators=(",", ":"))
        obj["evidenceIdsJson"] = obj["photoEvidenceIdsJson"]
        offset += len(obj.data.polygons)
    observed = int(np.count_nonzero(winners >= 0))
    areas = np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1) * .5
    summary = {"schemaVersion": "roomplan-surface-mesh/1.0", "mode": "observed_surface_mesh",
        **{key: source[key] for key in ("projectId", "jobId", "inputRevision", "inputSha256", "sourceArchiveSha256")},
        "meshSha256": mesh_ref["sha256"], "vertexCount": len(vertices), "triangleCount": len(faces),
        "photoCount": len(photos), "observedTriangleCount": observed,
        "unobservedTriangleCount": len(faces) - observed,
        "coverage": float(areas[winners >= 0].sum() / areas.sum()),
        "photoSources": [{"photoId": photo["id"], "sha256": photo["sha256"],
                          "evidenceId": photo["evidenceId"]} for photo in photos],
        "triangleSourceIndices": winners.tolist(),
        "triangleOrder": "manifest anchor order, then original face order; -1 means unobserved",
        "warnings": ["Observed mesh is a partial LiDAR surface capture; holes, thin objects, glass, reflections and scan drift are not repaired or invented.",
                     "Camera RGB retains captured lighting and exposure. Unlit textures preserve observed color; they are not measured intrinsic albedo.",
                     "Unobserved, occluded, back-facing and out-of-frame triangles retain a plain neutral material.",
                     "The complete scan is a spatial reference, not segmented editable furniture. Classification labels do not establish individual object identity."]}
    return objects, summary
