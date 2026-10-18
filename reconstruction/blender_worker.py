"""Trusted headless Blender entry point. Invoke through reconstruction.cli.

Application axes [x,y,z] map to Blender [x,-z,y]; the glTF Y-up exporter
reverses that conversion. Walls use centerlines and floors top out at Y=0.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Vector

# Blender does not import the host Python environment or execute input code.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from reconstruction import GENERATOR_VERSION
from reconstruction.geometry import triangulate_polygon, validate_request, wall_cells
from reconstruction.joins import wall_join_slopes
from reconstruction.shading import RENDER_PROFILE, add_preview_setup, metric_uvs, room_materials

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


def bounds_of(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects if obj.type == "MESH" for corner in obj.bound_box]
    # Blender (x,y,z) -> canonical application (x,z,-y).
    canonical = [(p.x, p.z, -p.y) for p in points]
    return {"min": [min(p[i] for p in canonical) for i in range(3)],
            "max": [max(p[i] for p in canonical) for i in range(3)]}


def generate(request, output: Path, preview: bool):
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
    scene["coordinateSystem"] = "Blender Z-up; glTF export Y-up"
    scene["wallAlignment"] = "centerline"
    geometry = request["geometry"]
    collections = {}
    for name in ("Floors", "Walls", "Openings"):
        collection = bpy.data.collections.new(name)
        scene.collection.children.link(collection)
        collections[name] = collection
    floor_mat, wall_mat = room_materials()
    objects = [build_floor(room, collections["Floors"], floor_mat) for room in geometry["rooms"]]
    for wall in geometry["walls"]:
        openings = [o for o in geometry["openings"] if o["wallId"] == wall["id"]]
        obj = build_wall(wall, openings, geometry["walls"], geometry["openings"], collections["Walls"], wall_mat)
        objects.append(obj)
        objects.extend(build_opening(o, obj, wall["thickness"], collections["Openings"]) for o in openings)
    bpy.context.view_layer.update()
    for obj in objects:
        metric_uvs(obj, 1.2 if obj["role"] == "room_floor" else 1)
    bounds = bounds_of(objects)
    add_preview_setup(scene, bounds, objects)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next(o for o in objects if o.type == "MESH")
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "scene.blend"), check_existing=False)
    result = bpy.ops.export_scene.gltf(
        filepath=str(output / "scene.glb"), export_format="GLB", check_existing=False,
        use_selection=True, export_yup=True, export_extras=True, export_materials="EXPORT",
        export_normals=True, export_texcoords=True, export_tangents=True, export_animations=False,
        export_image_format="AUTO",
        use_renderable=False,
        export_cameras=False, export_lights=False, export_draco_mesh_compression_enable=False,
        export_unused_images=False, export_unused_textures=False,
    )
    if "FINISHED" not in result:
        raise RuntimeError("glTF exporter did not finish")
    metadata = {
        "blenderVersion": bpy.app.version_string,
        "renderProfile": RENDER_PROFILE,
        "bounds": bounds,
        "objects": [{"id": obj["entityId"], "role": obj["role"], "name": obj.name,
                     "evidenceIds": json.loads(obj["evidenceIdsJson"])} for obj in objects],
        "statistics": {"meshCount": sum(obj.type == "MESH" for obj in objects),
                       "triangleCount": sum(sum(len(p.vertices) - 2 for p in obj.data.polygons) for obj in objects if obj.type == "MESH"),
                       "entityCount": len(objects)},
    }
    (output / "worker-result.json").write_text(json.dumps(metadata, indent=2) + "\n")
    if preview:
        scene.render.filepath = str(output / "preview.png")
        bpy.ops.render.render(write_still=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    request = validate_request(json.loads(args.request.read_text()))
    generate(request, args.output, args.preview)


if __name__ == "__main__":
    main()
