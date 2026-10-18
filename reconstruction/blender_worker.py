"""Trusted headless Blender entry point. Invoke through reconstruction.cli.

Application axes [x,y,z] map to Blender [x,-z,y]; the glTF Y-up exporter
reverses that conversion. Walls use centerlines and floors top out at Y=0.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

# Blender does not import the host Python environment or execute input code.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from reconstruction import GENERATOR_VERSION
from reconstruction.geometry import triangulate_polygon, validate_request, wall_cells
from reconstruction.joins import wall_join_slopes
from reconstruction.shading import RENDER_PROFILE, add_preview_setup, metric_uvs, pbr_material, room_materials

FLOOR_THICKNESS = 0.08


def mesh_object(name, vertices, faces, collection, mat):
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    if mesh.validate(verbose=True):
        raise ValueError(f"Generated invalid mesh: {name}")
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    if not all(edge.is_manifold for edge in bm.edges):
        bm.free()
        raise ValueError(f"Generated non-manifold mesh: {name}")
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    result = bpy.data.objects.new(name, mesh)
    collection.objects.link(result)
    result.data.materials.append(mat)
    return result


def identify(obj, entity, role):
    obj["entityId"] = entity["id"]
    obj["role"] = role
    # JSON text is portable across Blender custom-property implementations.
    obj["evidenceIdsJson"] = json.dumps(entity["evidenceIds"], separators=(",", ":"))


def build_floor(room, collection, mat):
    points = room["floorPolygon"]
    triangles = triangulate_polygon(points)
    # Ear clipping omits redundant collinear vertices. Remove the same vertices
    # from side edges, avoiding T-junctions between caps and the floor skirt.
    used = sorted({i for triangle in triangles for i in triangle})
    remap = {old: new for new, old in enumerate(used)}
    points = [points[i] for i in used]
    triangles = [tuple(remap[i] for i in triangle) for triangle in triangles]
    n = len(points)
    cx = sum(p[0] for p in points) / n
    cz = sum(p[1] for p in points) / n
    vertices = [(x - cx, -(z - cz), y) for y in (-FLOOR_THICKNESS, 0) for x, z in points]
    faces = [tuple(t) for t in triangles]
    faces += [tuple(n + i for i in reversed(t)) for t in triangles]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    obj = mesh_object("Floor_" + room["id"], vertices, faces, collection, mat)
    obj.location = (cx, -cz, 0)
    identify(obj, room, "room_floor")
    obj["label"] = room["label"]
    obj["thicknessMeters"] = FLOOR_THICKNESS
    return obj


def build_wall(wall, openings, all_walls, all_openings, collection, mat):
    """Union a rectangular cell grid, removing internal coincident faces.

    No Boolean modifier, hidden plug, or transparent patch fills an opening.
    Each wall remains one independently editable watertight mesh.
    """
    vertices = []
    vertex_indices = {}
    faces_by_key = {}
    half = wall["thickness"] / 2
    length = math.dist(wall["start"], wall["end"])
    start_slope, end_slope = wall_join_slopes(wall, all_walls, all_openings)

    def index(point):
        u, v, height = point
        if abs(u) < 1e-8:
            u = start_slope * v
        elif abs(u - length) < 1e-8:
            u = length + end_slope * v
        point = (u, v, height)
        key = tuple(round(v, 10) for v in point)
        if key not in vertex_indices:
            vertex_indices[key] = len(vertices)
            vertices.append(point)
        return vertex_indices[key]

    for cell in wall_cells(wall, openings):
        u0, u1, y0, y1 = (cell[k] for k in ("u0", "u1", "y0", "y1"))
        ids = [index(p) for p in (
            (u0, -half, y0), (u1, -half, y0), (u1, half, y0), (u0, half, y0),
            (u0, -half, y1), (u1, -half, y1), (u1, half, y1), (u0, half, y1),
        )]
        for corners in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                        (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            face = tuple(ids[i] for i in corners)
            key = tuple(sorted(face))
            if key in faces_by_key:
                del faces_by_key[key]
            else:
                faces_by_key[key] = face
    # Prune internal-only vertices so no loose vertices enter the export.
    used = sorted({i for face in faces_by_key.values() for i in face})
    remap = {old: new for new, old in enumerate(used)}
    faces = [tuple(remap[i] for i in face) for face in faces_by_key.values()]
    if faces:
        obj = mesh_object("Wall_" + wall["id"], [vertices[i] for i in used], faces, collection, mat)
    else:
        # A fully open boundary still has a stable editable semantic identity.
        obj = bpy.data.objects.new("Wall_" + wall["id"], None)
        collection.objects.link(obj)
    dx = wall["end"][0] - wall["start"][0]
    dz = wall["end"][1] - wall["start"][1]
    obj.location = (wall["start"][0], -wall["start"][1], 0)
    obj.rotation_euler.z = -math.atan2(dz, dx)
    identify(obj, wall, "wall")
    obj["heightMeters"] = wall["height"]
    obj["thicknessMeters"] = wall["thickness"]
    obj["alignment"] = "centerline"
    obj["startJoinSlope"] = start_slope
    obj["endJoinSlope"] = end_slope
    return obj


def build_opening(opening, wall_obj, thickness, collection):
    obj = bpy.data.objects.new("Opening_" + opening["id"], None)
    collection.objects.link(obj)
    obj.parent = wall_obj
    obj.location = (opening["offset"] + opening["width"] / 2, 0,
                    opening["sillHeight"] + opening["height"] / 2)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 1
    obj.scale = (opening["width"] / 2, thickness / 2, opening["height"] / 2)
    identify(obj, opening, "opening")
    for key in ("wallId", "kind", "offset", "width", "height", "sillHeight"):
        obj[key] = opening[key]
    return obj


def build_existing_furniture(item, collection, mat):
    """Editable sensor bounding box; deliberately not a recovered product mesh."""
    width, height, depth = item["dimensions"]
    vertices = [(x * width / 2, z * depth / 2, y * height)
                for y in (0, 1) for z in (-1, 1) for x in (-1, 1)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1),
             (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    obj = mesh_object("Existing_" + item["id"], vertices, faces, collection, mat)
    x, y, z = item["position"]
    obj.location = (x, -z, y)
    # A right-handed +Y rotation maps +X to -Z. The canonical axis
    # conversion maps this to Blender +Z, matching Three.js rotation.y.
    obj.rotation_euler.z = item["rotationY"]
    identify(obj, {**item, "evidenceIds": item.get("evidenceIds", [])}, "existing_furniture")
    obj["label"] = item["label"]
    obj["roomId"] = item["roomId"]
    obj["origin"] = "existing_owned"
    obj["locked"] = item["locked"]
    obj["dimensionsJson"] = json.dumps(item["dimensions"], separators=(",", ":"))
    obj["proxyGeometry"] = "sensor_bounding_box"
    obj["finish"] = "paint"
    obj["appearanceStatus"] = "sensor_proxy"
    metric_uvs(obj, 1)
    return obj


def bounds_of(objects, *, observed=False):
    if observed:
        # Rotated anchor AABB corners overestimate observed geometry. Exporters
        # also omit loose vertices, so measure only actual face vertices.
        points = [obj.matrix_world @ obj.data.vertices[index].co for obj in objects
                  if obj.type == "MESH" for index in {i for face in obj.data.polygons for i in face.vertices}]
    else:
        points = [obj.matrix_world @ Vector(corner) for obj in objects if obj.type == "MESH" for corner in obj.bound_box]
    # Blender (x,y,z) -> canonical application (x,z,-y).
    canonical = [(p.x, p.z, -p.y) for p in points]
    return {"min": [min(p[i] for p in canonical) for i in range(3)],
            "max": [max(p[i] for p in canonical) for i in range(3)]}


def generate(request, output: Path, preview: bool, photo_source: Path | None = None,
             source_request_sha256: str | None = None, design_profile: Path | None = None):
    if bpy.app.version < (4, 5, 0):
        raise RuntimeError("Blender 4.5 LTS or newer is required")
    scene = bpy.context.scene
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = "METERS"
    scene.render.fps = 24
    for key in ("jobId", "projectId", "inputRevision"):
        # Blender integer custom properties are 32-bit; preserve the full JS
        # safe-integer revision as text. The manifest retains a numeric revision.
        scene[key] = str(request[key]) if key == "inputRevision" else request[key]
    scene["generatorVersion"] = GENERATOR_VERSION
    scene["inputSha256"] = hashlib.sha256((json.dumps(request, sort_keys=True, indent=2,
        ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")).hexdigest()
    scene["sourceRequestSha256"] = source_request_sha256 or scene["inputSha256"]
    scene["coordinateSystem"] = "Blender Z-up; glTF export Y-up"
    scene["wallAlignment"] = "centerline"
    geometry = request["geometry"]
    staged_source = json.loads(photo_source.read_text()) if photo_source is not None else None
    design = None
    if design_profile is not None:
        from reconstruction.design_profile import read_design_profile
        if staged_source is None or staged_source["inputSha256"] != scene["inputSha256"]:
            raise ValueError("Visual design requires its exact staged scene/photo identity")
        design = read_design_profile(design_profile, request, staged_source["photos"])
    collections = {}
    for name in ("Floors", "Walls", "Openings"):
        collection = bpy.data.collections.new(name)
        scene.collection.children.link(collection)
        collections[name] = collection
    if design is not None:
        from reconstruction.designed_surfaces import room_design_materials
        materials, appearance_summary = room_design_materials(geometry, design)
    else:
        materials, appearance_summary = room_materials(geometry, request.get("appearance"))
    scene["appearanceSummaryJson"] = json.dumps(appearance_summary, separators=(",", ":"))
    objects = [build_floor(room, collections["Floors"], materials[room["id"]][0]) for room in geometry["rooms"]]
    opening_details = []
    for wall in geometry["walls"]:
        openings = [o for o in geometry["openings"] if o["wallId"] == wall["id"]]
        obj = build_wall(wall, openings, geometry["walls"], geometry["openings"], collections["Walls"], materials[wall["id"]][0])
        objects.append(obj)
        for opening in openings:
            marker = build_opening(opening, obj, wall["thickness"], collections["Openings"])
            objects.append(marker)
            if design is not None:
                from reconstruction.designed_surfaces import dress_opening
                opening_details.extend(dress_opening(opening, marker, wall["thickness"], design))
    bpy.context.view_layer.update()
    for obj in objects:
        if obj.type == "MESH":
            material, tile, rotation = materials[obj["entityId"]]
            obj["finish"] = material["finish"]
            obj["appearanceStatus"] = material["appearanceStatus"]
            metric_uvs(obj, tile, rotation)
    if request.get("items"):
        collection = bpy.data.collections.new("ExistingFurniture")
        scene.collection.children.link(collection)
        if design is not None:
            from reconstruction.designed_furniture import build_designed_furniture
            styles = {item["itemId"]: item for item in design["items"]}
            objects.extend(build_designed_furniture(item, styles[item["id"]], collection) for item in request["items"])
        else:
            # Neutral proxy finish is independent from inferred room finishes.
            material = pbr_material("ExistingFurniture_Proxy", (.31, .38, .40, 1),
                                    normal="plaster-normal.jpg", normal_strength=.035,
                                    roughness_value=.82)
            material["finish"] = "paint"
            material["appearanceStatus"] = "sensor_proxy"
            objects.extend(build_existing_furniture(item, collection, material) for item in request["items"])
        bpy.context.view_layer.update()
    photo_summary = None
    surface_summary = None
    design_summary = None
    if design is not None:
        design_summary = {"schemaVersion": "room-visual-design-result/1.0", "mode": "photo_informed_parametric",
            "producer": design["producer"], **{key: request[key] for key in ("projectId", "jobId", "inputRevision")},
            "inputSha256": scene["inputSha256"], "profileInputSha256": design["inputSha256"],
            "profileSha256": hashlib.sha256(design_profile.read_bytes()).hexdigest(),
            "sourceArchiveSha256": staged_source["sourceArchiveSha256"], "reviewRequired": True,
            **{key: design[key] for key in ("sources", "surfaces", "items", "notes")},
            "warnings": ["Furniture forms, colors, surface patterns and hidden details are photo-informed estimates, not exact recovered meshes or measured material properties.",
                         "Original RoomPlan item dimensions, floor layout and placements are retained; source detection errors can remain.",
                         "The clean architectural model completes surfaces and uses approximate indoor lighting. The original observed mesh remains a separate reference."]}
        scene["captureRepresentation"] = "photo_informed_parametric"
        scene["visualDesignSummaryJson"] = json.dumps(design_summary, separators=(",", ":"))
        (output / "visual-design.json").write_text(json.dumps(design_summary, indent=2, allow_nan=False) + "\n")
    elif photo_source is not None:
        if staged_source.get("mesh") is not None:
            from reconstruction.surface_mesh import build_surface_mesh
            planning_objects = objects
            objects, surface_summary = build_surface_mesh(photo_source, output)
            for obj in planning_objects:
                obj.hide_render = True
                obj.hide_set(True)
                obj["planningProxyOnly"] = True
            scene["captureRepresentation"] = "observed_surface_mesh"
            scene["surfaceReconstructionSummaryJson"] = json.dumps(surface_summary, separators=(",", ":"))
            (output / "surface-reconstruction.json").write_text(json.dumps(surface_summary, indent=2,
                                                                         allow_nan=False) + "\n")
        else:
            from reconstruction.photo_texturing import apply_photo_textures
            photo_summary = apply_photo_textures(objects, photo_source, output)
            scene["photoTexturingSummaryJson"] = json.dumps(photo_summary, separators=(",", ":"))
            (output / "photo-texturing.json").write_text(json.dumps(photo_summary, indent=2,
                                                                  allow_nan=False) + "\n")
    bpy.context.view_layer.update()
    export_objects = objects + opening_details
    bounds = bounds_of(export_objects, observed=surface_summary is not None or design is not None)
    lighting_summary = add_preview_setup(scene, bounds, objects, geometry)
    if design is not None:
        scene["renderProfile"] = "photo-informed-room-v1"
        for lamp in scene.objects:
            if lamp.type == "LIGHT" and "openingId" in lamp:
                lamp.data.energy *= .12
        for room in geometry["rooms"]:
            points = room["floorPolygon"]
            x = sum(point[0] for point in points) / len(points)
            z = sum(point[1] for point in points) / len(points)
            data = bpy.data.lights.new("InferredIndoorFill_" + room["id"], "AREA")
            data.energy, data.shape, data.size = 350, "DISK", 4
            data.color = (1, .93, .82)
            lamp = bpy.data.objects.new(data.name, data)
            scene.collection.objects.link(lamp)
            lamp.location = (x, -z, max(wall["height"] for wall in geometry["walls"]) - .05)
        lighting_summary = {**lighting_summary, "mode": "photo_informed_indoor", "assumption": "Soft indoor fixtures inferred from room photos; intensity and exact placement are not measured."}
        scene["lightingSummaryJson"] = json.dumps(lighting_summary, separators=(",", ":"))
    if surface_summary is not None:
        # Prefer a well-covered, reasonably level real capture view; the first
        # photo can be a steep downward view taken while changing scan modes.
        photos = staged_source["photos"]
        usage = [0] * len(photos)
        for index in surface_summary["triangleSourceIndices"]:
            if index >= 0:
                usage[index] += 1
        candidates = [i for i, photo in enumerate(photos) if abs(photo["cameraToWorld"][9]) <= .55]
        index = max(candidates or range(len(photos)), key=lambda i: usage[i])
        first = photos[index]
        scene["captureCameraPhotoId"] = first["id"]
        values = first["cameraToWorld"]
        native = Matrix([[values[column * 4 + row] for column in range(4)] for row in range(4)])
        translation = staged_source["sourceToCanonicalTranslation"]
        for axis in range(3):
            native[axis][3] += translation[axis]
        axes = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
        scene.camera.matrix_world = axes @ native
        scene.camera.data.type = "PERSP"
        scene.camera.data.clip_start = .03
        position = [native[axis][3] for axis in range(3)]
        scene["captureCameraPosition"] = position
        scene["captureCameraTarget"] = [position[axis] - native[axis][2] for axis in range(3)]
        # Present an upright view, matching the browser's world-up camera.
        # Raw sensor roll and calibration remain untouched for texture UVs.
        direction = Vector((-native[0][2], native[2][2], -native[1][2]))
        scene.camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        scene.camera.data.sensor_fit = "HORIZONTAL"
        scene.camera.data.sensor_width = 36
        scene.camera.data.lens = first["intrinsics"][0] * 36 / first["width"]
        scene.camera.data.shift_x = (first["width"] / 2 - first["intrinsics"][6]) / first["width"]
        scene.camera.data.shift_y = (first["intrinsics"][7] - first["height"] / 2) / first["width"]
        scene.render.resolution_x = min(960, first["width"])
        scene.render.resolution_y = round(scene.render.resolution_x * first["height"] / first["width"])
        scene["renderProfile"] = "captured-surface-rgb-v1"
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
        ground = bpy.data.objects.get("PreviewGround")
        if ground is not None:
            ground.hide_render = True
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in export_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next(o for o in objects if o.type == "MESH")
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "scene.blend"), check_existing=False)
    if surface_summary is not None:
        # Keep full per-face provenance in the saved .blend and JSON report.
        # Avoid duplicating hundreds of thousands of indices in GLB metadata.
        scene["surfaceReconstructionSummaryJson"] = json.dumps(
            {key: value for key, value in surface_summary.items() if key != "triangleSourceIndices"},
            separators=(",", ":"))
    result = bpy.ops.export_scene.gltf(
        filepath=str(output / "scene.glb"), export_format="GLB", check_existing=False,
        use_selection=True, export_yup=True, export_extras=True, export_materials="EXPORT",
        export_normals=True, export_texcoords=True, export_tangents=surface_summary is None, export_animations=False,
        export_image_format="AUTO",
        use_renderable=False,
        export_cameras=False, export_lights=False, export_draco_mesh_compression_enable=False,
        export_unused_images=False, export_unused_textures=False,
    )
    if "FINISHED" not in result:
        raise RuntimeError("glTF exporter did not finish")
    if surface_summary is not None:
        scene["surfaceReconstructionSummaryJson"] = json.dumps(surface_summary, separators=(",", ":"))
    metadata = {
        "blenderVersion": bpy.app.version_string,
        "renderProfile": "photo-informed-room-v1" if design is not None else "captured-surface-rgb-v1" if surface_summary is not None else RENDER_PROFILE,
        "lighting": lighting_summary,
        "appearance": appearance_summary,
        "bounds": bounds,
        "objects": [{"id": obj["entityId"], "role": obj["role"], "name": obj.name,
                     "evidenceIds": json.loads(obj["evidenceIdsJson"])} for obj in objects],
        "statistics": {"meshCount": sum(obj.type == "MESH" for obj in export_objects),
                       "triangleCount": sum(sum(len(p.vertices) - 2 for p in obj.data.polygons) for obj in export_objects if obj.type == "MESH"),
                       "entityCount": len(objects)},
    }
    if photo_summary is not None:
        metadata["photoTexturing"] = photo_summary
    if surface_summary is not None:
        metadata["surfaceReconstruction"] = surface_summary
        metadata["captureRepresentation"] = "observed_surface_mesh"
    if design_summary is not None:
        metadata["visualDesign"] = design_summary
        metadata["captureRepresentation"] = "photo_informed_parametric"
    (output / "worker-result.json").write_text(json.dumps(metadata, indent=2) + "\n")
    if preview:
        scene.render.filepath = str(output / "preview.png")
        bpy.ops.render.render(write_still=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--photo-source", type=Path)
    parser.add_argument("--source-request-sha256")
    parser.add_argument("--design-profile", type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    request = validate_request(json.loads(args.request.read_text()))
    generate(request, args.output, args.preview, args.photo_source, args.source_request_sha256, args.design_profile)


if __name__ == "__main__":
    main()
