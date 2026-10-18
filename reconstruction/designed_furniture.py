"""Bounded photo-informed furniture forms; measured envelopes remain canonical.

Runs inside trusted Blender. Templates describe plausible observed furniture,
not recovered object meshes, hidden construction, products, or measured BRDFs.
"""
from __future__ import annotations

import json
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

MODELS = frozenset({"box_arm_sofa", "rounded_sofa", "loop_arm_plywood_chair", "box_arm_chair",
                    "pedestal_table", "round_side_table", "rect_table", "cabinet", "waste_station", "unresolved_proxy"})


def _linear_color(value):
    if not isinstance(value, str) or len(value) != 7 or value[0] != "#":
        raise ValueError("Furniture color must be #RRGGBB")
    try:
        rgb = [int(value[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    except ValueError as error:
        raise ValueError("Furniture color must be #RRGGBB") from error
    return [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in rgb] + [1]


def _material(name, color, *, roughness=.65, metallic=0, pattern="plain", accent="#b5a386"):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = _linear_color(color)
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = material.diffuse_color
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    material["appearanceSource"] = "photo_informed_estimate"
    if pattern == "dash":
        base = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        ink = [int(accent[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        image = bpy.data.images.new(name + "_Dash", width=128, height=128, alpha=True)
        image.colorspace_settings.name = "sRGB"
        pixels = []
        for y in range(128):
            for x in range(128):
                dash = ((x + 8 * ((y // 16) % 2)) % 16 < 7) and y % 16 in (6, 7)
                shade = .97 if (x + y) % 3 == 0 else 1.02
                pixels.extend([min(1, v * shade) for v in (ink if dash else base)] + [1])
        image.pixels.foreach_set(pixels)
        image.update()
        image.file_format = "PNG"
        image.filepath_raw = "//textures/" + name + "-dash.png"
        image.pack()
        node = material.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = image
        node.extension = "REPEAT"
        material.node_tree.links.new(node.outputs["Color"], shader.inputs["Base Color"])
    return material


class _Parts:
    def __init__(self, materials):
        self.vertices, self.faces, self.materials, self.slots, self.smooth = [], [], materials, [], []

    def add(self, bm, material, *, matrix=None, smooth=False):
        if matrix is not None:
            bmesh.ops.transform(bm, matrix=matrix, verts=list(bm.verts))
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        if not bm.faces or not all(edge.is_manifold for edge in bm.edges) or bm.calc_volume(signed=True) <= 0:
            bm.free()
            raise ValueError("Designed furniture component must be closed with outward normals")
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        start = len(self.vertices)
        self.vertices.extend(tuple(vertex.co) for vertex in bm.verts)
        self.faces.extend(tuple(start + vertex.index for vertex in face.verts) for face in bm.faces)
        self.slots.extend([material] * len(bm.faces))
        self.smooth.extend([smooth] * len(bm.faces))
        bm.free()

    def box(self, dimensions, center, material=0, bevel=.025):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        bmesh.ops.transform(bm, matrix=Matrix.Diagonal((*dimensions, 1)), verts=list(bm.verts))
        if bevel:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(bevel, min(dimensions) * .42), segments=3,
                            affect="EDGES", clamp_overlap=True)
        self.add(bm, material, matrix=Matrix.Translation(center))

    def rounded_slab(self, dimensions, center, material=0, corner=.08):
        width, depth, height = dimensions
        radius = min(corner, width * .45, depth * .45)
        outline = []
        centers = [(width / 2 - radius, depth / 2 - radius), (-width / 2 + radius, depth / 2 - radius),
                   (-width / 2 + radius, -depth / 2 + radius), (width / 2 - radius, -depth / 2 + radius)]
        for (cx, cy), start in zip(centers, (0, math.pi / 2, math.pi, math.pi * 1.5)):
            for sample in range(7):
                angle = start + sample / 6 * math.pi / 2
                outline.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
        count = len(outline)
        bm = bmesh.new()
        verts = [bm.verts.new((x, y, z)) for z in (-height / 2, height / 2) for x, y in outline]
        bm.faces.new(list(reversed(verts[:count])))
        bm.faces.new(verts[count:])
        for index in range(count):
            following = (index + 1) % count
            bm.faces.new((verts[index], verts[following], verts[following + count], verts[index + count]))
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(height * .16, radius * .12), segments=3,
                        affect="EDGES", clamp_overlap=True)
        self.add(bm, material, matrix=Matrix.Translation(center))

    def cylinder(self, radius, height, center, material=2, *, radius_top=None, segments=24):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments,
                             radius1=radius, radius2=radius if radius_top is None else radius_top, depth=height)
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(height * .08, radius * .06), segments=3,
                        affect="EDGES", clamp_overlap=True)
        self.add(bm, material, matrix=Matrix.Translation(center), smooth=True)

    def rod(self, a, b, radius=.015, material=2):
        a, b = Vector(a), Vector(b)
        direction = b - a
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=12,
                             radius1=radius, radius2=radius, depth=direction.length)
        matrix = Matrix.Translation((a + b) / 2) @ Vector((0, 0, 1)).rotation_difference(direction).to_matrix().to_4x4()
        self.add(bm, material, matrix=matrix, smooth=True)

    def loop_arm(self, x, y_min, y_max, z_min, z_max, radius=.014):
        # A closed rounded rectangular metal arm hoop, in the depth/height plane.
        curve = min((y_max - y_min), (z_max - z_min)) * .24
        centers = [(y_max - curve, z_max - curve), (y_min + curve, z_max - curve),
                   (y_min + curve, z_min + curve), (y_max - curve, z_min + curve)]
        path = []
        for (cy, cz), start in zip(centers, (0, math.pi / 2, math.pi, math.pi * 1.5)):
            for sample in range(7):
                angle = start + sample / 6 * math.pi / 2
                path.append(Vector((x, cy + curve * math.cos(angle), cz + curve * math.sin(angle))))
        vertices, faces = [], []
        for index, point in enumerate(path):
            tangent = (path[(index + 1) % len(path)] - path[index - 1]).normalized()
            side = Vector((1, 0, 0))
            normal = tangent.cross(side).normalized()
            for sample in range(8):
                angle = sample / 8 * math.tau
                vertices.append(point + radius * (math.cos(angle) * side + math.sin(angle) * normal))
        for index in range(len(path)):
            for sample in range(8):
                faces.append((index * 8 + sample, index * 8 + (sample + 1) % 8,
                              ((index + 1) % len(path)) * 8 + (sample + 1) % 8, ((index + 1) % len(path)) * 8 + sample))
        self.custom(vertices, faces, 2, smooth=True)

    def custom(self, vertices, faces, material=0, *, smooth=False):
        bm = bmesh.new()
        verts = [bm.verts.new(v) for v in vertices]
        for face in faces:
            bm.faces.new([verts[i] for i in face])
        self.add(bm, material, smooth=smooth)

    def plywood_shell(self, width, depth, height):
        # A solid bent plywood seat/back: horizontal seat, smooth quarter bend,
        # then tall back. It remains open around the sitter, never a full box.
        bend = min(depth * .17, height * .16)
        seat_z, bend_y = height * .46, depth * .28
        path = [(-depth * .43, seat_z), (bend_y, seat_z)]
        for index in range(1, 10):
            angle = -math.pi / 2 + index / 9 * math.pi / 2
            path.append((bend_y + bend * math.cos(angle), seat_z + bend + bend * math.sin(angle)))
        path.append((bend_y + bend, height * .97))
        thick = min(width, depth, height) * .022
        vertices = []
        for index, (y, z) in enumerate(path):
            previous, following = path[max(0, index - 1)], path[min(len(path) - 1, index + 1)]
            ty, tz = following[0] - previous[0], following[1] - previous[1]
            length = math.hypot(ty, tz)
            ny, nz = -tz / length, ty / length
            for x in (-width * .43, width * .43):
                for sign in (-1, 1):
                    vertices.append((x, y + sign * thick * ny / 2, z + sign * thick * nz / 2))
        faces = [(0, 2, 3, 1)]
        for i in range(len(path) - 1):
            a, b = i * 4, (i + 1) * 4
            faces.extend([(a, b, b + 2, a + 2), (a + 1, a + 3, b + 3, b + 1),
                          (a, a + 1, b + 1, b), (a + 2, b + 2, b + 3, a + 3)])
        end = (len(path) - 1) * 4
        faces.append((end, end + 1, end + 3, end + 2))
        self.custom(vertices, faces, 0, smooth=True)


def build_designed_furniture(item, spec, collection):
    """Create one editable semantic mesh with disconnected, closed design parts."""
    model = spec["model"]
    if model not in MODELS or spec["itemId"] != item["id"]:
        raise ValueError("Unsupported or mismatched designed furniture profile")
    dimensions = item["dimensions"]
    if len(dimensions) != 3 or any(not math.isfinite(v) or v <= 0 for v in dimensions):
        raise ValueError("Designed furniture needs finite positive metric dimensions")
    if spec.get("pattern", "plain") not in {"plain", "dash"}:
        raise ValueError("Unsupported furniture pattern")
    seats = spec.get("seatCount", 1)
    if isinstance(seats, bool) or not isinstance(seats, int) or not 1 <= seats <= 4:
        raise ValueError("Furniture seatCount must be 1–4")
    width, height, depth = dimensions
    materials = [_material("Designed_" + item["id"] + "_Primary", spec["primaryColor"], roughness=.76 if spec.get("pattern") == "dash" else .57,
                           pattern=spec.get("pattern", "plain"), accent=spec["accentColor"]),
                 _material("Designed_" + item["id"] + "_Secondary", spec["secondaryColor"], roughness=.63),
                 _material("Designed_" + item["id"] + "_Frame", spec["frameColor"], roughness=.3, metallic=.7),
                 _material("Designed_" + item["id"] + "_Accent", spec["accentColor"], roughness=.65)]
    parts = _Parts(materials)
    if model in {"box_arm_sofa", "rounded_sofa", "box_arm_chair"}:
        rounded = model == "rounded_sofa"
        arm = min(width * (.09 if model != "box_arm_chair" else .15), depth * .24)
        bevel = min(height, depth) * (.095 if rounded else .025)
        seat_height = height * .48
        parts.box((width * .96, depth * .91, height * .22), (0, 0, height * .23), 1, bevel)
        cushion_count = seats if model != "box_arm_chair" else 1
        inner = width - arm * 2 - width * .025
        for index in range(cushion_count):
            x = -inner / 2 + (index + .5) * inner / cushion_count
            parts.box((inner / cushion_count - width * .008, depth * .76, height * .20), (x, -depth * .07, seat_height), 0, bevel)
            parts.box((inner / cushion_count - width * .008, depth * .23, height * .49), (x, depth * .34, height * .745), 0, bevel)
        for sign in (-1, 1):
            parts.box((arm, depth * .94, height * (.56 if rounded else .55)), (sign * (width - arm) / 2, 0, height * .43), 0, bevel)
        for x in (-width * .39, width * .39):
            for y in (-depth * .34, depth * .34):
                parts.cylinder(min(width, depth) * .026, height * .14, (x, y, height * .07), 2, segments=12)
    elif model == "loop_arm_plywood_chair":
        parts.plywood_shell(width, depth, height)
        for sign in (-1, 1):
            parts.loop_arm(sign * width * .46, -depth * .38, depth * .34, height * .40, height * .73, radius=min(width, depth) * .021)
        for x in (-width * .35, width * .35):
            for y in (-depth * .32, depth * .32):
                parts.rod((x * 1.12, y * 1.12, 0), (x, y, height * .47), min(width, depth) * .022)
        parts.rod((-width * .35, 0, height * .43), (width * .35, 0, height * .43), min(width, depth) * .018)
    elif model in {"pedestal_table", "rect_table"}:
        top = height * .055
        if model == "pedestal_table":
            parts.rounded_slab((width, depth, top), (0, 0, height - top / 2), 0, corner=min(width, depth) * .14)
        else:
            parts.box((width, depth, top), (0, 0, height - top / 2), 0, .025)
        if model == "pedestal_table":
            count = 2 if width > depth * 1.2 else 1
            for index in range(count):
                x = (index - (count - 1) / 2) * width * .50
                parts.cylinder(min(width, depth) * .035, height * .87, (x, 0, height * .48), 2)
                parts.box((min(width * .15, .13), depth * .76, height * .05), (x, 0, height * .035), 2, .02)
                for sign in (-1, 1):
                    parts.cylinder(min(width, depth) * .027, height * .02, (x, sign * depth * .32, height * .01), 3, segments=12)
        else:
            for x in (-width * .42, width * .42):
                for y in (-depth * .4, depth * .4):
                    parts.box((width * .045, depth * .045, height * .95), (x, y, height * .475), 2, .012)
    elif model == "round_side_table":
        radius = min(width, depth) * .5
        parts.cylinder(radius * .94, height * .92, (0, 0, height * .46), 0, segments=40)
        parts.cylinder(radius, height * .08, (0, 0, height * .96), 1, segments=48)
        parts.cylinder(radius * .84, height * .035, (0, 0, height * .018), 3, segments=32)
    elif model in {"cabinet", "waste_station"}:
        parts.box((width * .96, depth * .94, height * .91), (0, depth * .02, height * .49), 1, .025)
        doors = 3 if model == "waste_station" else 2
        for index in range(doors):
            x = -width * .48 + (index + .5) * width * .96 / doors
            parts.box((width * .96 / doors - width * .012, depth * .055, height * .78), (x, -depth * .465, height * .46), 0, .012)
            if model == "waste_station":
                parts.box((width / doors * .4, depth * .03, height * .055), (x, -depth * .505, height * .80), 3, .025)
            else:
                parts.box((width * .016, depth * .035, height * .11), (x + width / doors * .32, -depth * .505, height * .52), 2, .005)
        parts.box((width, depth, height * .055), (0, 0, height * .9725), 0, .018)
        parts.box((width * .85, depth * .82, height * .06), (0, 0, height * .03), 3, .012)
    else:
        parts.box((width, depth, height), (0, 0, height / 2), 1, min(dimensions) * .035)
    # Templates retain proportions but their total envelope exactly equals the
    # sensed dimensions. Apply to vertices, never semantic object scale.
    minimum = [min(v[axis] for v in parts.vertices) for axis in range(3)]
    maximum = [max(v[axis] for v in parts.vertices) for axis in range(3)]
    desired = (width, depth, height)
    vertices = [tuple((v[axis] - minimum[axis]) * desired[axis] / (maximum[axis] - minimum[axis])
                      - (desired[axis] / 2 if axis < 2 else 0) for axis in range(3)) for v in parts.vertices]
    mesh = bpy.data.meshes.new("Designed_" + item["id"] + "_Mesh")
    mesh.from_pydata(vertices, [], parts.faces)
    mesh.update()
    if mesh.validate(verbose=True):
        raise ValueError("Designed furniture generated invalid mesh")
    for material in materials:
        mesh.materials.append(material)
    uv = mesh.uv_layers.new(name="UVMap")
    for polygon, slot, smooth in zip(mesh.polygons, parts.slots, parts.smooth):
        polygon.material_index = slot
        polygon.use_smooth = smooth
        dominant = max(range(3), key=lambda axis: abs(polygon.normal[axis]))
        axes = [axis for axis in range(3) if axis != dominant]
        for loop_index in polygon.loop_indices:
            point = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            uv.data[loop_index].uv = (point[axes[0]] / .16, point[axes[1]] / .16)
    obj = bpy.data.objects.new("Existing_" + item["id"], mesh)
    collection.objects.link(obj)
    x, y, z = item["position"]
    obj.location = (x, -z, y)
    obj.rotation_euler.z = item["rotationY"]
    for key in ("label", "roomId", "locked"):
        obj[key] = item[key]
    obj["entityId"], obj["role"], obj["origin"] = item["id"], "existing_furniture", "existing_owned"
    obj["evidenceIdsJson"] = json.dumps(item.get("evidenceIds", []), separators=(",", ":"))
    obj["dimensionsJson"] = json.dumps(item["dimensions"], separators=(",", ":"))
    obj["representation"], obj["appearanceStatus"], obj["proxyGeometry"] = "photo_informed_parametric", "photo_inferred", "photo_informed_parts"
    obj["visualLabel"], obj["photoEvidenceIdsJson"] = spec["label"], json.dumps(spec.get("evidenceIds", []), separators=(",", ":"))
    obj["designTemplate"], obj["designConfidence"], obj["designNotes"] = model, spec["confidence"], spec.get("notes", "")
    obj["finish"] = "photo_inferred"
    return obj
