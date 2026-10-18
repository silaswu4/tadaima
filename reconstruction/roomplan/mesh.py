"""Validate observed ARKit triangle surfaces; never synthesize missing geometry."""
from __future__ import annotations

import re

MAX_MESH_BYTES = 48 * 1024 * 1024
MAX_ANCHORS = 128
MAX_VERTICES = 200_000
MAX_FACES = 300_000
_ANCHOR_ID = re.compile(r"mesh-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def validate_mesh(raw, identity):
    """Return a data-only mesh packet after identity, rigid-pose and index checks.

    Meshes may have holes, boundaries and disconnected components. Those are
    expected in a partial physical scan and are not repaired with invented faces.
    Classification values follow ARMeshClassification's 0–7 raw values.
    """
    from .importer import _object, _array, _number, _transform, RoomPlanError

    def fail(message):
        raise RoomPlanError("RoomPlan mesh: " + message)

    _object(raw, {"schemaVersion", "projectId", "jobId", "inputRevision",
                  "coordinateSystem", "captureMethod", "anchors"}, "mesh")
    if (raw["schemaVersion"] != "roomplan-mesh/1.0"
            or raw["coordinateSystem"] != "arkit-gravity-y-up-metres"
            or raw["captureMethod"] != "arkit-scene-reconstruction"):
        fail("unsupported version, coordinate system or capture method")
    for key in ("projectId", "jobId", "inputRevision"):
        if type(raw[key]) is not type(identity[key]) or raw[key] != identity[key]:
            fail("identity differs from scan")
    anchors = _array(raw["anchors"], MAX_ANCHORS, "mesh.anchors", minimum=1)
    ids, total_vertices, total_faces = set(), 0, 0
    for anchor in anchors:
        _object(anchor, {"id", "transform", "vertices", "faces", "classifications"}, "mesh.anchor")
        ident = anchor["id"]
        if not isinstance(ident, str) or not _ANCHOR_ID.fullmatch(ident) or ident in ids:
            fail("invalid or duplicate anchor identifier")
        ids.add(ident)
        transform = _transform(anchor["transform"], "mesh.anchor.transform", upright=False)
        vertices = _array(anchor["vertices"], MAX_VERTICES, "mesh.vertices", minimum=3)
        faces = _array(anchor["faces"], MAX_FACES, "mesh.faces", minimum=1)
        total_vertices += len(vertices)
        total_faces += len(faces)
        if total_vertices > MAX_VERTICES or total_faces > MAX_FACES:
            fail("total vertex or triangle budget exceeded")
        for vertex in vertices:
            if not isinstance(vertex, list) or len(vertex) != 3:
                fail("vertex must contain three coordinates")
            values = [_number(v, -10_000, 10_000, "mesh.vertex") for v in vertex]
            world = [sum(transform[column * 4 + row] * values[column] for column in range(3))
                     + transform[12 + row] for row in range(3)]
            if any(abs(v) > 10_000 for v in world):
                fail("world vertex exceeds coordinate bounds")
        classes = anchor["classifications"]
        if not isinstance(classes, list) or len(classes) != len(faces):
            fail("classification count must match triangles")
        seen_faces = set()
        for face, classification in zip(faces, classes):
            if (not isinstance(face, list) or len(face) != 3
                    or any(type(v) is not int or not 0 <= v < len(vertices) for v in face)
                    or len(set(face)) != 3):
                fail("triangle indices must address three distinct vertices")
            if type(classification) is not int or not 0 <= classification <= 7:
                fail("triangle classification must be an integer from 0 to 7")
            key = tuple(sorted(face))
            if key in seen_faces:
                fail("duplicate triangle")
            seen_faces.add(key)
            a, b, c = [vertices[i] for i in face]
            u, v = [b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)]
            cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
                     u[0] * v[1] - u[1] * v[0]]
            if sum(x * x for x in cross) <= 1e-20:
                fail("degenerate triangle")
    return raw
