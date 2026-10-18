"""Bake trusted, calibrated scan photographs onto editable room meshes.

This module runs only inside Blender. Photos supply observed RGB, never geometry
or guessed texture pixels. Depth testing includes every input mesh, including
walls later hidden by the preview cutaway. Native ARKit poses are translated to
the canonical room frame exactly once, then mapped [x,y,z] -> [x,-z,y].
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import bpy
import numpy as np

MAX_ATLAS_TEXELS = 8_000_000
MAX_ENTITY_SIDE = 1024
DEPTH_SIDE = 640
PIXELS_PER_METER = 96
MIN_COSINE = .2
NEAR = .04
ROLES = {"room_floor", "wall", "existing_furniture"}
AXES = np.array([[1., 0., 0.], [0., 0., -1.], [0., 1., 0.]])


def _projection(points, rotation, center, intrinsics):
    camera = (points - center) @ rotation
    depth = -camera[:, 2]
    safe = np.maximum(depth, 1e-8)
    pixels = np.column_stack((intrinsics[0, 0] * camera[:, 0] / safe + intrinsics[0, 2],
                              intrinsics[1, 2] - intrinsics[1, 1] * camera[:, 1] / safe))
    return pixels, depth


def _near_clip(triangle):
    """Clip camera-space triangles rather than dropping near-camera floors."""
    polygon = list(triangle)
    result = []
    for index, current in enumerate(polygon):
        previous = polygon[index - 1]
        current_inside, previous_inside = current[2] <= -NEAR, previous[2] <= -NEAR
        if current_inside != previous_inside:
            fraction = (-NEAR - previous[2]) / (current[2] - previous[2])
            result.append(previous + fraction * (current - previous))
        if current_inside:
            result.append(current)
    return [np.array([result[0], result[index], result[index + 1]]) for index in range(1, len(result) - 1)]


def _raster_depth(depth_buffer, triangle, calibration):
    depth = -triangle[:, 2]
    screen = np.column_stack((calibration[0, 0] * triangle[:, 0] / depth + calibration[0, 2],
                              calibration[1, 2] - calibration[1, 1] * triangle[:, 1] / depth))
    height, width = depth_buffer.shape
    minimum = np.maximum(np.floor(screen.min(axis=0)).astype(int), 0)
    maximum = np.minimum(np.ceil(screen.max(axis=0)).astype(int), [width - 1, height - 1])
    if np.any(maximum < minimum):
        return
    x0, y0 = minimum
    x1, y1 = maximum
    xx, yy = np.meshgrid(np.arange(x0, x1 + 1) + .5, np.arange(y0, y1 + 1) + .5)
    a, b, c = screen
    denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if abs(denominator) < 1e-10:
        return
    first = ((b[1] - c[1]) * (xx - c[0]) + (c[0] - b[0]) * (yy - c[1])) / denominator
    second = ((c[1] - a[1]) * (xx - c[0]) + (a[0] - c[0]) * (yy - c[1])) / denominator
    third = 1 - first - second
    inside = (first >= -1e-7) & (second >= -1e-7) & (third >= -1e-7)
    inverse_depth = first / depth[0] + second / depth[1] + third / depth[2]
    interpolated = np.divide(1, inverse_depth, out=np.full_like(inverse_depth, np.inf), where=inverse_depth > 0)
    patch = depth_buffer[y0:y1 + 1, x0:x1 + 1]
    np.minimum(patch, np.where(inside, interpolated, np.inf), out=patch)


def _depth_buffer(triangles, rotation, center, intrinsics, width, height):
    scale = min(1., DEPTH_SIDE / max(width, height))
    depth_width, depth_height = max(1, math.ceil(width * scale)), max(1, math.ceil(height * scale))
    calibration = intrinsics.copy()
    calibration[0] *= depth_width / width
    calibration[1] *= depth_height / height
    buffer = np.full((depth_height, depth_width), np.inf, dtype=np.float32)
    camera_triangles = (triangles - center) @ rotation
    for triangle in camera_triangles:
        for clipped in _near_clip(triangle):
            _raster_depth(buffer, clipped, calibration)
    return buffer


def _inside_polygon(points, polygon):
    inside = np.zeros(len(points), dtype=bool)
    x, y = points[:, 0], points[:, 1]
    previous = polygon[-1]
    for current in polygon:
        crosses = (current[1] > y) != (previous[1] > y)
        denominator = previous[1] - current[1]
        if abs(denominator) > 1e-12:
            boundary = (previous[0] - current[0]) * (y - current[1]) / denominator + current[0]
            inside ^= crosses & (x < boundary)
        previous = current
    return inside


def _fallback_color(obj, polygon):
    if polygon.material_index < len(obj.data.materials):
        material = obj.data.materials[polygon.material_index]
        if material:
            shader = material.node_tree.nodes.get("Principled BSDF") if material.use_nodes else None
            linear = shader.inputs["Base Color"].default_value[:3] if shader else material.diffuse_color[:3]
            rgb = np.array(linear)
            # Image storage is sRGB; fallback shader values are scene linear.
            return np.where(rgb <= .0031308, rgb * 12.92, 1.055 * np.maximum(rgb, 0) ** (1 / 2.4) - .055)
    return np.array([.7, .7, .7])


def _world_mesh(obj):
    matrix = np.array(obj.matrix_world, dtype=np.float64)
    vertices = np.array([vertex.co[:] for vertex in obj.data.vertices])
    return vertices @ matrix[:3, :3].T + matrix[:3, 3]


def _atlas(obj, side):
    mesh = obj.data
    vertices = _world_mesh(obj)
    normals = np.linalg.inv(np.array(obj.matrix_world.to_3x3())).T
    grid = math.ceil(math.sqrt(len(mesh.polygons)))
    cell = side // grid
    if cell < 5:
        raise ValueError("Photo atlas budget cannot represent the mesh's polygon count")
    uv = mesh.uv_layers.get("UVMap") or mesh.uv_layers.new(name="UVMap")
    mesh.uv_layers.active = uv
    rgba = np.ones((side, side, 4), dtype=np.float32)
    rgba[:, :, :3] = .7
    faces = []
    for polygon in mesh.polygons:
        corners = vertices[list(polygon.vertices)]
        normal = normals @ np.array(polygon.normal)
        normal /= max(np.linalg.norm(normal), 1e-12)
        edges = np.roll(corners, -1, axis=0) - corners
        axis_u = edges[np.argmax(np.sum(edges * edges, axis=1))]
        axis_u /= max(np.linalg.norm(axis_u), 1e-12)
        axis_v = np.cross(normal, axis_u)
        projected = np.column_stack(((corners - corners[0]) @ axis_u, (corners - corners[0]) @ axis_v))
        minimum, maximum = projected.min(axis=0), projected.max(axis=0)
        span = maximum - minimum
        maximum_span = max(float(span.max()), 1e-8)
        dimensions = np.maximum(1, np.floor(span / maximum_span * (cell - 4)).astype(int))
        origin = np.array([(polygon.index % grid) * cell + 2, (polygon.index // grid) * cell + 2])
        width, height = dimensions
        xx, yy = np.meshgrid(np.arange(width), np.arange(height))
        local = minimum + np.column_stack(((xx.ravel() + .5) / width, (yy.ravel() + .5) / height)) * span
        inside = _inside_polygon(local, projected)
        x, y = xx.ravel()[inside] + origin[0], yy.ravel()[inside] + origin[1]
        points = corners[0] + local[inside, 0, None] * axis_u + local[inside, 1, None] * axis_v
        fallback = np.clip(_fallback_color(obj, polygon), 0, 1)
        # Fill the whole island and padding with the same honest fallback.
        px, py = origin - 2
        rgba[py:py + cell, px:px + cell, :3] = fallback
        for loop_index, point in zip(polygon.loop_indices, projected):
            relative = np.divide(point - minimum, span, out=np.zeros(2), where=span > 1e-12)
            uv.data[loop_index].uv = (origin + relative * dimensions) / side
        faces.append({"index": polygon.index, "normal": normal, "points": points, "x": x, "y": y,
                      "score": np.zeros(len(points), dtype=np.float32),
                      "winner": np.full(len(points), -1, dtype=np.int16),
                      "area": float(polygon.area)})
    return {"object": obj, "side": side, "rgba": rgba, "faces": faces}


def _load_photo(path, metadata):
    image = bpy.data.images.load(str(path), check_existing=False)
    try:
        if list(image.size) != [metadata["width"], metadata["height"]]:
            raise ValueError("Decoded photo dimensions do not match calibration")
        pixels = np.empty(metadata["width"] * metadata["height"] * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        # Blender buffers start at bottom left; native calibration starts at top left.
        return pixels.reshape((metadata["height"], metadata["width"], 4))[::-1, :, :3].copy()
    finally:
        bpy.data.images.remove(image)


def _bilinear(rgb, screen):
    # Calibration coordinates address pixel centers in the raw saved sensor image.
    x = np.clip(screen[:, 0], 0, rgb.shape[1] - 1)
    y = np.clip(screen[:, 1], 0, rgb.shape[0] - 1)
    left, top = np.floor(x).astype(int), np.floor(y).astype(int)
    right, bottom = np.minimum(left + 1, rgb.shape[1] - 1), np.minimum(top + 1, rgb.shape[0] - 1)
    dx, dy = (x - left)[:, None], (y - top)[:, None]
    return ((1 - dx) * (1 - dy) * rgb[top, left] + dx * (1 - dy) * rgb[top, right]
            + (1 - dx) * dy * rgb[bottom, left] + dx * dy * rgb[bottom, right])


def _observe(atlas, photo_index, rgb, rotation, center, intrinsics, depth_buffer):
    height, width = rgb.shape[:2]
    depth_height, depth_width = depth_buffer.shape
    for face in atlas["faces"]:
        points = face["points"]
        if not len(points):
            continue
        screen, depth = _projection(points, rotation, center, intrinsics)
        toward_camera = center - points
        distance = np.linalg.norm(toward_camera, axis=1)
        cosine = toward_camera @ face["normal"] / np.maximum(distance, 1e-8)
        valid = ((depth > NEAR) & (cosine > MIN_COSINE) & (screen[:, 0] >= 1)
                 & (screen[:, 0] < width - 2) & (screen[:, 1] >= 1) & (screen[:, 1] < height - 2))
        indices = np.flatnonzero(valid)
        if not len(indices):
            continue
        depth_x = screen[indices, 0] * depth_width / width - .5
        depth_y = screen[indices, 1] * depth_height / height - .5
        left = np.clip(np.floor(depth_x).astype(int), 0, depth_width - 1)
        top = np.clip(np.floor(depth_y).astype(int), 0, depth_height - 1)
        right, bottom = np.minimum(left + 1, depth_width - 1), np.minimum(top + 1, depth_height - 1)
        # Taking the nearest of four samples is conservative at object edges:
        # leave an unseen strip rather than paint sofa RGB onto a wall behind it.
        nearest = np.minimum.reduce([depth_buffer[top, left], depth_buffer[top, right],
                                     depth_buffer[bottom, left], depth_buffer[bottom, right]])
        # Allow depth rasterization error on sloped surfaces, bounded below real
        # furniture separation. Calibration/geometry errors are not corrected here.
        tolerance = .008 + depth[indices] * 2 / min(intrinsics[0, 0], intrinsics[1, 1])
        visible = np.isfinite(nearest) & (np.abs(nearest - depth[indices]) <= tolerance)
        indices = indices[visible]
        if not len(indices):
            continue
        scores = cosine[indices] ** 2 * intrinsics[0, 0] * intrinsics[1, 1] / np.maximum(depth[indices] ** 2, .01)
        improved = scores > face["score"][indices]
        indices, scores = indices[improved], scores[improved]
        if not len(indices):
            continue
        atlas["rgba"][face["y"][indices], face["x"][indices], :3] = _bilinear(rgb, screen[indices])
        face["score"][indices] = scores
        face["winner"][indices] = photo_index


def _pack_atlas(atlas, output, index):
    obj, side = atlas["object"], atlas["side"]
    image = bpy.data.images.new("CapturedPhotoAtlas_" + obj["entityId"], width=side, height=side, alpha=True)
    image.colorspace_settings.name = "sRGB"
    image.pixels.foreach_set(atlas["rgba"].ravel())
    image.update()
    image.file_format = "PNG"
    path = output / f"photo-atlas-{index:04d}.png"
    image.filepath_raw = str(path)
    image.save()
    path.chmod(0o600)
    data = path.read_bytes()
    image.filepath_raw = "//photo-textures/" + path.name
    image.pack(data=data, data_len=len(data))
    material = bpy.data.materials.new("CapturedPhoto_" + obj["entityId"])
    material.use_nodes = True
    material.diffuse_color = (.7, .7, .7, 1)
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (1, 1, 1, 1)
    shader.inputs["Roughness"].default_value = .85
    shader.inputs["Metallic"].default_value = 0
    node = material.node_tree.nodes.new("ShaderNodeTexImage")
    node.image, node.extension, node.interpolation = image, "EXTEND", "Linear"
    node.label = "Observed camera RGB; lighting remains baked into captured pixels"
    uv = material.node_tree.nodes.new("ShaderNodeUVMap")
    uv.uv_map = "UVMap"
    material.node_tree.links.new(uv.outputs["UV"], node.inputs["Vector"])
    material.node_tree.links.new(node.outputs["Color"], shader.inputs["Base Color"])
    obj.data.materials.clear()
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.material_index = 0
    return path


def _coverage(atlas, photos):
    faces, photo_counts, evidence_ids = [], {}, set()
    covered_area = total_area = 0.
    total_texels = covered_texels = 0
    for face in atlas["faces"]:
        winners = face["winner"]
        count, visible = len(winners), int(np.count_nonzero(winners >= 0))
        fraction = visible / count if count else 0
        total_area += face["area"]
        covered_area += face["area"] * fraction
        total_texels += count
        covered_texels += visible
        sources = []
        for index in np.unique(winners[winners >= 0]):
            photo = photos[int(index)]
            texels = int(np.count_nonzero(winners == index))
            photo_counts[photo["id"]] = photo_counts.get(photo["id"], 0) + texels
            evidence_ids.add(photo["evidenceId"])
            sources.append({"photoId": photo["id"], "evidenceId": photo["evidenceId"], "texels": texels})
        faces.append({"faceIndex": face["index"], "coverage": round(fraction, 6),
                      "observedTexels": visible, "sampledTexels": count,
                      "status": _status(fraction), "sources": sources})
    fraction = covered_area / total_area if total_area else 0
    return {"entityId": atlas["object"]["entityId"], "role": atlas["object"]["role"],
            "status": _status(fraction), "coverage": fraction,
            "observedTexels": covered_texels, "sampledTexels": total_texels,
            "atlasWidth": atlas["side"], "atlasHeight": atlas["side"],
            "photoIds": sorted(photo_counts), "evidenceIds": sorted(evidence_ids), "faces": faces}


def _status(fraction):
    return "captured_photo_covered" if fraction >= .95 else "captured_photo_partial" if fraction > 0 else "unobserved"


def apply_photo_textures(objects, source_path: Path, output: Path):
    """Project privately staged, revision-bound scan photos and return coverage.

    Caller validates the original scan bundle and geometry before staging this
    source. These boundary checks additionally prevent stale geometry hashes,
    escaping file paths or changed photo bytes from reaching Blender's decoder.
    """
    source_path, output = Path(source_path), Path(output)
    source = json.loads(source_path.read_text())
    if source.get("schemaVersion") != "roomplan-texture-source/1.0":
        raise ValueError("Unsupported calibrated photo texture source")
    scene_path = output / "scene.json"
    if not scene_path.is_file() or hashlib.sha256(scene_path.read_bytes()).hexdigest() != source["inputSha256"]:
        raise ValueError("Photo texture source does not match scene input bytes")
    request = json.loads(scene_path.read_text())
    if any(source[key] != request[key] for key in ("projectId", "jobId", "inputRevision")):
        raise ValueError("Photo texture source identity does not match scene")
    photos = source["photos"]
    if not 1 <= len(photos) <= 32:
        raise ValueError("Photo texturing requires between 1 and 32 calibrated photos")
    translation = np.array(source["sourceToCanonicalTranslation"], dtype=np.float64)
    if translation.shape != (3,) or not np.isfinite(translation).all():
        raise ValueError("Invalid source-to-canonical translation")
    targets = [obj for obj in objects if obj.type == "MESH" and obj.get("role") in ROLES and len(obj.data.polygons)]
    bpy.context.view_layer.update()
    triangles = []
    for obj in objects:
        if obj.type != "MESH":
            continue
        obj.data.calc_loop_triangles()
        vertices = _world_mesh(obj)
        triangles.extend(vertices[list(triangle.vertices)] for triangle in obj.data.loop_triangles)
    if not triangles or not targets:
        raise ValueError("No room or furniture surfaces available for photo texturing")
    triangles = np.array(triangles, dtype=np.float64)
    desired = [max(64, min(MAX_ENTITY_SIDE, math.ceil(math.sqrt(sum(p.area for p in obj.data.polygons)) * PIXELS_PER_METER)))
               for obj in targets]
    scale = min(1., math.sqrt(MAX_ATLAS_TEXELS / sum(side * side for side in desired)))
    sides = [max(1, math.floor(side * scale)) for side in desired]
    if sum(side * side for side in sides) > MAX_ATLAS_TEXELS:
        raise ValueError("Photo atlas work exceeds bounded texel budget")
    atlases = [_atlas(obj, side) for obj, side in zip(targets, sides)]
    total_photo_bytes = 0
    seen_ids = set()
    for photo_index, photo in enumerate(photos):
        name = photo["path"]
        if name != "photos/" + photo["id"] + ".jpg" or Path(name).is_absolute() or ".." in Path(name).parts:
            raise ValueError("Photo texture source path is invalid")
        path = (source_path.parent / name).resolve()
        if not path.is_relative_to(source_path.parent.resolve()) or photo["id"] in seen_ids:
            raise ValueError("Photo texture source escapes its directory or repeats a photo")
        seen_ids.add(photo["id"])
        length = path.stat().st_size
        total_photo_bytes += length
        if not 0 < length <= 2 * 1024 * 1024 or total_photo_bytes > 32 * 1024 * 1024:
            raise ValueError("Photo texture source exceeds bounded image bytes")
        if hashlib.sha256(path.read_bytes()).hexdigest() != photo["sha256"] or length != photo["byteLength"]:
            raise ValueError("Photo texture source bytes changed after validation")
        if not (1 <= photo["width"] <= 1600 and 1 <= photo["height"] <= 1600):
            raise ValueError("Photo texture source image exceeds saved image limits")
        native = np.array(photo["cameraToWorld"], dtype=np.float64).reshape((4, 4), order="F")
        rotation = AXES @ native[:3, :3]
        center = AXES @ (native[:3, 3] + translation)
        calibration = np.array(photo["intrinsics"], dtype=np.float64).reshape((3, 3), order="F")
        if not np.isfinite(native).all() or not np.isfinite(calibration).all():
            raise ValueError("Photo texture camera matrices must be finite")
        rgb = _load_photo(path, photo)
        depth = _depth_buffer(triangles, rotation, center, calibration, photo["width"], photo["height"])
        for atlas in atlases:
            _observe(atlas, photo_index, rgb, rotation, center, calibration, depth)
        del rgb, depth
    texture_output = output / "photo-textures"
    texture_output.mkdir(mode=0o700, exist_ok=False)
    summaries = []
    for index, atlas in enumerate(atlases):
        summary = _coverage(atlas, photos)
        path = _pack_atlas(atlas, texture_output, index)
        summary["atlas"] = "photo-textures/" + path.name
        summary["atlasSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        atlas["object"]["appearanceStatus"] = "photo_projected" if summary["observedTexels"] else "unobserved"
        atlas["object"]["photoTextureCoverage"] = summary["coverage"]
        atlas["object"]["photoEvidenceIdsJson"] = json.dumps(summary["evidenceIds"], separators=(",", ":"))
        summaries.append(summary)
    return {"schemaVersion": "roomplan-photo-textures/1.0", "reviewRequired": True,
            "mode": "calibrated_photo_projection", "sourcePhotoCount": len(photos),
            "projectId": source["projectId"], "jobId": source["jobId"],
            "inputRevision": source["inputRevision"], "inputSha256": source["inputSha256"],
            "sourceArchiveSha256": source.get("sourceArchiveSha256"),
            "atlasTexels": sum(side * side for side in sides), "entities": summaries,
            "warnings": ["Observed photographs include their original lighting, shadows and exposure; these RGB textures are not measured intrinsic albedo.",
                         "Furniture remains an editable sensor bounding-box proxy; projected appearance does not recover the exact furniture shape.",
                         "Unobserved, occluded and grazing-angle surfaces retain a plain fallback color; no photo detail is invented.",
                         "Visibility uses captured proxy geometry; scan and camera alignment errors may still cause projection seams."]}
