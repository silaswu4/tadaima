"""Bounded, deterministic validation and geometry for the room-shell worker.

Public API (Python 3.11+, no Blender/dependencies):
    validate_request(raw) -> a normalized ReconstructionRequest dictionary.
    signed_area(points) -> signed area in the input X/Z plane.
    triangulate_polygon(points) -> CCW triangles of original vertex indices.
    wall_cells(wall, openings) -> solid rectangles {u0, u1, y0, y1}.

Coordinates follow backend/contracts.ts: meters, right-handed, Y up. Opening
offset is distance along the wall from start; sillHeight is above floor Y=0.
Floor loops are implicitly closed; an explicit repeated last point is removed.
Evidence preserves provenance; validation does not certify measurement accuracy.
Wall cells form real cutouts without Boolean modifiers. Openings may share an
edge; corner-only contact and positive-area overlap are rejected because the
former creates a non-manifold extruded edge. Helpers raise GeometryError.
"""

from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Any, Sequence

EPS = 1e-8
MAX_COORDINATE = 10_000
MAX_DIMENSION = 1_000
MAX_ROOMS = 32
MAX_WALLS = 512
MAX_OPENINGS = 256
MAX_OPENINGS_PER_WALL = 32
MAX_VERTICES = 256
MAX_TOTAL_VERTICES = 2_048
MAX_EVIDENCE = 2_048
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


class GeometryError(ValueError):
    """Input cannot safely produce the supported metric room shell."""


def _fail(path: str, message: str) -> None:
    raise GeometryError(f"{path}: {message}")


def _object(value: Any, path: str, fields: set[str]) -> dict:
    if not isinstance(value, dict):
        _fail(path, "expected an object")
    missing = fields - value.keys()
    extra = value.keys() - fields
    if missing:
        _fail(path, f"missing fields: {', '.join(sorted(missing))}")
    if extra:
        _fail(path, f"unsupported fields: {', '.join(sorted(map(str, extra)))}")
    return value


def _list(value: Any, path: str, maximum: int, minimum: int = 0) -> list:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        _fail(path, f"expected an array with {minimum}–{maximum} entries")
    return value


def _text(value: Any, path: str, maximum: int = 512) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        _fail(path, f"expected nonempty text, at most {maximum} characters")
    return value


def _id(value: Any, path: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        _fail(path, "expected a safe ASCII ID (letters, digits, underscore, hyphen; max 64)")
    return value


def _number(value: Any, path: str, lower: float, upper: float,
            *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(path, "expected a finite number")
    # Avoid OverflowError when an unbounded JSON integer is converted to float.
    if not lower <= value <= upper or (positive and value <= EPS):
        _fail(path, f"number outside supported range ({lower} to {upper})")
    result = float(value)
    if not math.isfinite(result):
        _fail(path, "expected a finite number")
    return result


def _point(value: Any, path: str) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        _fail(path, "expected [x, z]")
    return [_number(v, f"{path}[{i}]", -MAX_COORDINATE, MAX_COORDINATE)
            for i, v in enumerate(value)]


def _cross(a: Sequence[float], b: Sequence[float], c: Sequence[float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _distance(a: Sequence[float], b: Sequence[float]) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _on_segment(p: Sequence[float], a: Sequence[float], b: Sequence[float]) -> bool:
    length = _distance(a, b)
    return (abs(_cross(a, b, p)) <= EPS * max(1, length)
            and min(a[0], b[0]) - EPS <= p[0] <= max(a[0], b[0]) + EPS
            and min(a[1], b[1]) - EPS <= p[1] <= max(a[1], b[1]) + EPS)


def _intersects(a, b, c, d, *, proper: bool = False) -> bool:
    ab_c, ab_d, cd_a, cd_b = _cross(a, b, c), _cross(a, b, d), _cross(c, d, a), _cross(c, d, b)
    if ((ab_c > EPS and ab_d < -EPS) or (ab_c < -EPS and ab_d > EPS)) and (
        (cd_a > EPS and cd_b < -EPS) or (cd_a < -EPS and cd_b > EPS)
    ):
        return True
    if proper:
        return False
    return (_on_segment(c, a, b) or _on_segment(d, a, b)
            or _on_segment(a, c, d) or _on_segment(b, c, d))


def signed_area(points: Sequence[Sequence[float]]) -> float:
    """Return polygon signed area in X/Z (positive = CCW in that plane)."""
    return math.fsum(points[i][0] * points[(i + 1) % len(points)][1]
                     - points[(i + 1) % len(points)][0] * points[i][1]
                     for i in range(len(points))) / 2


def _edges(points):
    return [(points[i], points[(i + 1) % len(points)]) for i in range(len(points))]


def _validate_polygon(points: list, path: str) -> list:
    if len(points) > 1 and _distance(points[0], points[-1]) <= EPS:
        points = points[:-1]
    if len(points) < 3:
        _fail(path, "at least three distinct vertices required")
    edges = _edges(points)
    for i, (a, b) in enumerate(edges):
        if _distance(a, b) <= EPS:
            _fail(path, f"zero-length edge at vertex {i}")
        # Adjacent collinear edges may continue forward, but cannot double back.
        c = points[(i + 2) % len(points)]
        if abs(_cross(a, b, c)) <= EPS and _on_segment(c, a, b):
            _fail(path, f"overlapping adjacent edges at vertex {(i + 1) % len(points)}")
        for j in range(i + 1, len(edges)):
            if j == i + 1 or (i == 0 and j == len(edges) - 1):
                continue
            if _intersects(a, b, *edges[j]):
                _fail(path, f"self-intersection between edges {i} and {j}")
    if abs(signed_area(points)) <= EPS:
        _fail(path, "floor polygon has no usable area")
    return points


def triangulate_polygon(points: Sequence[Sequence[float]]) -> list[tuple[int, int, int]]:
    """Ear-clip a simple concave floor; triangles retain original vertex indices.

    Collinear intermediate vertices need not appear in triangles. Both input
    winding orders are supported. An optional duplicate closing point is ignored.
    Triangles are CCW in X/Z; Blender conversion must account for axis mapping.
    """
    vertices = [_point(p, f"polygon[{i}]") for i, p in enumerate(points)]
    if len(vertices) > MAX_VERTICES + 1:
        _fail("polygon", "too many vertices")
    vertices = _validate_polygon(vertices, "polygon")
    remaining = list(range(len(vertices)))
    if signed_area(vertices) < 0:
        remaining.reverse()
    # Remove redundant points to avoid flat ears and degenerate triangles.
    while len(remaining) > 3:
        removed = False
        for k, index in enumerate(remaining):
            a, b, c = vertices[remaining[k - 1]], vertices[index], vertices[remaining[(k + 1) % len(remaining)]]
            if abs(_cross(a, b, c)) <= EPS:
                remaining.pop(k)
                removed = True
                break
        if not removed:
            break
    result = []
    while len(remaining) > 3:
        for k, index in enumerate(remaining):
            left, right = remaining[k - 1], remaining[(k + 1) % len(remaining)]
            a, b, c = vertices[left], vertices[index], vertices[right]
            if _cross(a, b, c) <= EPS:
                continue
            if any(_cross(a, b, vertices[t]) >= -EPS
                   and _cross(b, c, vertices[t]) >= -EPS
                   and _cross(c, a, vertices[t]) >= -EPS
                   for t in remaining if t not in (left, index, right)):
                continue
            result.append((left, index, right))
            remaining.pop(k)
            break
        else:
            _fail("polygon", "could not triangulate without degeneracy")
    if _cross(*(vertices[i] for i in remaining)) <= EPS:
        _fail("polygon", "degenerate final triangle")
    result.append(tuple(remaining))
    return result


def _strict_inside(point, polygon) -> bool:
    if any(_on_segment(point, a, b) for a, b in _edges(polygon)):
        return False
    inside = False
    x, z = point
    for a, b in _edges(polygon):
        if (a[1] > z) != (b[1] > z):
            hit = (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]
            if x < hit:
                inside = not inside
    return inside


def _overlapping_rooms(first: list, second: list) -> bool:
    if any(_intersects(a, b, c, d, proper=True)
           for a, b in _edges(first) for c, d in _edges(second)):
        return True
    if any(_strict_inside(p, second) for p in first) or any(_strict_inside(p, first) for p in second):
        return True
    # Identical/partially coincident boundaries can have no interior vertices.
    for source, other in ((first, second), (second, first)):
        for triangle in triangulate_polygon(source):
            centroid = [sum(source[i][axis] for i in triangle) / 3 for axis in (0, 1)]
            if _strict_inside(centroid, other):
                return True
        for a, b in _edges(source):
            if _strict_inside([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], other):
                return True
    return False


def _covered(a, b, segments) -> bool:
    """Whether collinear segments cover the complete target segment."""
    length = _distance(a, b)
    ux, uz = (b[0] - a[0]) / length, (b[1] - a[1]) / length
    intervals = []
    for c, d in segments:
        if abs(_cross(a, b, c)) > EPS * max(1, length) or abs(_cross(a, b, d)) > EPS * max(1, length):
            continue
        start, end = sorted(((p[0] - a[0]) * ux + (p[1] - a[1]) * uz for p in (c, d)))
        if end >= -EPS and start <= length + EPS:
            intervals.append((max(0, start), min(length, end)))
    end = 0.0
    for low, high in sorted(intervals):
        if low > end + EPS:
            return False
        end = max(end, high)
    return end >= length - EPS


def _refs(value: Any, path: str, known: set[str]) -> list[str]:
    refs = [_id(v, f"{path}[{i}]") for i, v in enumerate(_list(value, path, 64))]
    if len(set(refs)) != len(refs):
        _fail(path, "duplicate evidence references")
    for ref in refs:
        if ref not in known:
            _fail(path, f"unknown evidence ID: {ref}")
    return refs


def _timestamp(value: Any, path: str) -> str:
    value = _text(value, path, 64)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _fail(path, "expected an ISO 8601 timestamp with timezone")
    if parsed.tzinfo is None:
        _fail(path, "timestamp must include timezone")
    return value


def _evidence(raw: Any) -> list[dict]:
    result = []
    ids = set()
    fields = {"id", "sourceUrl", "privateAssetId", "observedAt", "claim", "dimensionStatus", "confirmedByUserAt"}
    for i, item in enumerate(_list(raw, "evidence", MAX_EVIDENCE)):
        path = f"evidence[{i}]"
        obj = _object(item, path, fields)
        item_id = _id(obj["id"], f"{path}.id")
        if item_id in ids:
            _fail(path, "duplicate evidence ID")
        ids.add(item_id)
        status = obj["dimensionStatus"]
        if status is not None and status not in ("measured", "source_dimension", "inferred"):
            _fail(path, "unsupported dimensionStatus")
        result.append({
            "id": item_id,
            "sourceUrl": None if obj["sourceUrl"] is None else _text(obj["sourceUrl"], f"{path}.sourceUrl", 4096),
            "privateAssetId": None if obj["privateAssetId"] is None else _text(obj["privateAssetId"], f"{path}.privateAssetId", 512),
            "observedAt": _timestamp(obj["observedAt"], f"{path}.observedAt"),
            "claim": _text(obj["claim"], f"{path}.claim", 4096),
            "dimensionStatus": status,
            "confirmedByUserAt": None if obj["confirmedByUserAt"] is None else _timestamp(obj["confirmedByUserAt"], f"{path}.confirmedByUserAt"),
        })
    return result


def _validate_openings(wall: dict, openings: list[dict]) -> None:
    if len(openings) > MAX_OPENINGS_PER_WALL:
        _fail(f"wall {wall['id']}", f"at most {MAX_OPENINGS_PER_WALL} openings per wall")
    length = _distance(wall["start"], wall["end"])
    if length <= EPS or wall["height"] <= EPS:
        _fail(f"wall {wall['id']}", "wall must have positive length and height")
    corner_contacts = []
    for i, opening in enumerate(openings):
        if opening["offset"] < 0 or opening["width"] <= EPS or opening["height"] <= EPS or opening["sillHeight"] < 0:
            _fail(f"opening {opening['id']}", "invalid cutout dimensions")
        if opening["offset"] + opening["width"] > length + EPS:
            _fail(f"opening {opening['id']}", "extends beyond wall length")
        if opening["sillHeight"] + opening["height"] > wall["height"] + EPS:
            _fail(f"opening {opening['id']}", "extends above wall height")
        if opening["kind"] == "door" and abs(opening["sillHeight"]) > EPS:
            _fail(f"opening {opening['id']}", "door sillHeight must be zero")
        for other in openings[:i]:
            overlap_u = min(opening["offset"] + opening["width"], other["offset"] + other["width"]) - max(opening["offset"], other["offset"])
            overlap_y = min(opening["sillHeight"] + opening["height"], other["sillHeight"] + other["height"]) - max(opening["sillHeight"], other["sillHeight"])
            if overlap_u > EPS and overlap_y > EPS:
                _fail(f"opening {opening['id']}", f"overlaps opening {other['id']}")
            if abs(overlap_u) <= EPS and abs(overlap_y) <= EPS:
                u = (min(opening["offset"] + opening["width"], other["offset"] + other["width"])
                     + max(opening["offset"], other["offset"])) / 2
                y = (min(opening["sillHeight"] + opening["height"], other["sillHeight"] + other["height"])
                     + max(opening["sillHeight"], other["sillHeight"])) / 2
                corner_contacts.append((u, y, opening["id"], other["id"]))
    for u, y, first_id, second_id in corner_contacts:
        void_quadrants = set()
        for opening in openings:
            u0, u1 = opening["offset"], opening["offset"] + opening["width"]
            y0, y1 = opening["sillHeight"], opening["sillHeight"] + opening["height"]
            # Examine infinitesimal sectors without sampling across a narrow
            # opening. A third opening may bridge an otherwise singular corner.
            left = u0 < u - EPS / 4 and u1 >= u - EPS
            right = u1 > u + EPS / 4 and u0 <= u + EPS
            below = y0 < y - EPS / 4 and y1 >= y - EPS
            above = y1 > y + EPS / 4 and y0 <= y + EPS
            for du, horizontal in ((-1, left), (1, right)):
                for dy, vertical in ((-1, below), (1, above)):
                    if horizontal and vertical:
                        void_quadrants.add((du, dy))
        if void_quadrants in ({(-1, -1), (1, 1)}, {(-1, 1), (1, -1)}):
            _fail(f"opening {first_id}",
                  f"touches opening {second_id} only at a corner; separate or merge the cutouts")


def wall_cells(wall: dict, openings: list[dict]) -> list[dict[str, float]]:
    """Slice validated wall into solid local rectangles, excluding its openings.

    Input may be all scene openings; only this wall's entries are considered.
    Output ordering is deterministic: increasing u, then increasing y. Adjacent
    cells share faces; the worker can join cells into one named editable wall.
    """
    local = [o for o in openings if o["wallId"] == wall["id"]]
    _validate_openings(wall, local)
    length = _distance(wall["start"], wall["end"])
    # Clamp tolerated floating-point overhang to the actual wall.
    us = sorted({0.0, length, *(min(length, o["offset"]) for o in local),
                 *(min(length, o["offset"] + o["width"]) for o in local)})
    ys = sorted({0.0, wall["height"], *(min(wall["height"], o["sillHeight"]) for o in local),
                 *(min(wall["height"], o["sillHeight"] + o["height"]) for o in local)})
    cells = []
    for u0, u1 in zip(us, us[1:]):
        for y0, y1 in zip(ys, ys[1:]):
            if u1 - u0 <= EPS or y1 - y0 <= EPS:
                continue
            u, y = (u0 + u1) / 2, (y0 + y1) / 2
            if any(o["offset"] < u < o["offset"] + o["width"]
                   and o["sillHeight"] < y < o["sillHeight"] + o["height"] for o in local):
                continue
            cells.append({"u0": u0, "u1": u1, "y0": y0, "y1": y1})
    return cells


def validate_request(raw: object) -> dict:
    """Validate the current TypeScript request without external I/O or mutation.

    Supports simple convex/concave floor loops and non-overlapping adjacent
    rooms. Holes, interior partition walls, fixtures, and unsupported fields are
    rejected rather than silently discarded. Every room boundary must be
    covered by wall segments, and every wall must lie on room boundaries.
    """
    fields = {"jobId", "projectId", "inputRevision", "geometry", "evidence"}
    if isinstance(raw, dict) and "appearance" in raw:
        fields.add("appearance")
    request = _object(raw, "request", fields)
    revision = request["inputRevision"]
    if isinstance(revision, bool) or not isinstance(revision, int) or not 0 <= revision <= 9_007_199_254_740_991:
        _fail("inputRevision", "expected nonnegative safe integer")
    evidence = _evidence(request["evidence"])
    known_evidence = {e["id"] for e in evidence}
    raw_geometry = _object(request["geometry"], "geometry", {"units", "coordinateSystem", "rooms", "walls", "openings"})
    if raw_geometry["units"] != "m" or raw_geometry["coordinateSystem"] != "right-handed-y-up":
        _fail("geometry", "expected meters and right-handed-y-up coordinates")
    ids = set()

    def identity(value, path):
        ident = _id(value, path)
        if ident in ids:
            _fail(path, "duplicate room/wall/opening ID")
        ids.add(ident)
        return ident

    geometry = {"units": "m", "coordinateSystem": "right-handed-y-up", "rooms": [], "walls": [], "openings": []}
    vertex_count = 0
    for i, item in enumerate(_list(raw_geometry["rooms"], "geometry.rooms", MAX_ROOMS, 1)):
        path = f"geometry.rooms[{i}]"
        obj = _object(item, path, {"id", "label", "floorPolygon", "height", "evidenceIds"})
        polygon = [_point(p, f"{path}.floorPolygon[{k}]") for k, p in enumerate(_list(obj["floorPolygon"], f"{path}.floorPolygon", MAX_VERTICES + 1, 3))]
        polygon = _validate_polygon(polygon, f"{path}.floorPolygon")
        if len(polygon) > MAX_VERTICES:
            _fail(path, "too many vertices")
        vertex_count += len(polygon)
        if vertex_count > MAX_TOTAL_VERTICES:
            _fail("geometry.rooms", "too many total vertices")
        room = {"id": identity(obj["id"], f"{path}.id"), "label": _text(obj["label"], f"{path}.label"),
                "floorPolygon": polygon, "height": _number(obj["height"], f"{path}.height", 0, MAX_DIMENSION, positive=True),
                "evidenceIds": _refs(obj["evidenceIds"], f"{path}.evidenceIds", known_evidence)}
        for other in geometry["rooms"]:
            if _overlapping_rooms(polygon, other["floorPolygon"]):
                _fail(path, f"interior overlaps room {other['id']}")
        geometry["rooms"].append(room)
    for i, item in enumerate(_list(raw_geometry["walls"], "geometry.walls", MAX_WALLS, 3)):
        path = f"geometry.walls[{i}]"
        obj = _object(item, path, {"id", "start", "end", "height", "thickness", "evidenceIds"})
        wall = {"id": identity(obj["id"], f"{path}.id"), "start": _point(obj["start"], f"{path}.start"),
                "end": _point(obj["end"], f"{path}.end"),
                "height": _number(obj["height"], f"{path}.height", 0, MAX_DIMENSION, positive=True),
                "thickness": _number(obj["thickness"], f"{path}.thickness", 0, 10, positive=True),
                "evidenceIds": _refs(obj["evidenceIds"], f"{path}.evidenceIds", known_evidence)}
        if _distance(wall["start"], wall["end"]) <= EPS:
            _fail(path, "zero-length wall")
        geometry["walls"].append(wall)
    wall_map = {wall["id"]: wall for wall in geometry["walls"]}
    all_edges = [edge for room in geometry["rooms"] for edge in _edges(room["floorPolygon"])]
    for wall in geometry["walls"]:
        if not _covered(wall["start"], wall["end"], all_edges):
            _fail(f"wall {wall['id']}", "must follow a room boundary; interior partitions are unsupported")
    wall_segments = [(wall["start"], wall["end"]) for wall in geometry["walls"]]
    for room in geometry["rooms"]:
        for a, b in _edges(room["floorPolygon"]):
            if not _covered(a, b, wall_segments):
                _fail(f"room {room['id']}", "floor boundary is missing wall coverage")
    # Duplicate partially overlapping wall segments create double-thickness faces.
    for i, wall in enumerate(geometry["walls"]):
        a, b = wall["start"], wall["end"]
        length = _distance(a, b)
        for other in geometry["walls"][:i]:
            c, d = other["start"], other["end"]
            if abs(_cross(a, b, c)) <= EPS * max(1, length) and abs(_cross(a, b, d)) <= EPS * max(1, length):
                positions = sorted(((p[0] - a[0]) * (b[0] - a[0]) / length + (p[1] - a[1]) * (b[1] - a[1]) / length for p in (c, d)))
                if min(length, positions[1]) - max(0, positions[0]) > EPS:
                    _fail(f"wall {wall['id']}", f"overlaps wall {other['id']}; represent shared walls once")
    for i, item in enumerate(_list(raw_geometry["openings"], "geometry.openings", MAX_OPENINGS)):
        path = f"geometry.openings[{i}]"
        obj = _object(item, path, {"id", "wallId", "kind", "offset", "width", "height", "sillHeight", "evidenceIds"})
        wall_id = _id(obj["wallId"], f"{path}.wallId")
        if wall_id not in wall_map:
            _fail(path, "unknown parent wall")
        if obj["kind"] not in ("door", "window"):
            _fail(path, "unsupported opening kind")
        geometry["openings"].append({"id": identity(obj["id"], f"{path}.id"), "wallId": wall_id, "kind": obj["kind"],
            "offset": _number(obj["offset"], f"{path}.offset", 0, MAX_DIMENSION),
            "width": _number(obj["width"], f"{path}.width", 0, MAX_DIMENSION, positive=True),
            "height": _number(obj["height"], f"{path}.height", 0, MAX_DIMENSION, positive=True),
            "sillHeight": _number(obj["sillHeight"], f"{path}.sillHeight", 0, MAX_DIMENSION),
            "evidenceIds": _refs(obj["evidenceIds"], f"{path}.evidenceIds", known_evidence)})
    for wall in geometry["walls"]:
        _validate_openings(wall, [o for o in geometry["openings"] if o["wallId"] == wall["id"]])
    result = {"jobId": _id(request["jobId"], "jobId"), "projectId": _id(request["projectId"], "projectId"),
              "inputRevision": revision, "geometry": geometry, "evidence": evidence}
    if "appearance" in request:
        from reconstruction.appearance_model import validate_appearance
        result["appearance"] = validate_appearance(request["appearance"], geometry, evidence)
    return result
