"""Bounded native RoomPlan surfaces -> canonical editable room shell.

The wire packet is roomplan-scan/1.0. Matrices are column-major rigid ARKit
transforms; local X is surface width, Y height, and Z the surface normal.
polygonCorners are LOCAL plane coordinates, not world-space floor points.

Only a single closed, unbranched, flat-floor loop of upright rectangular walls
is supported. Small endpoint gaps may be repaired by line intersections, with
every correction reported. Curves, stairs, nonrectangular cuts, ambiguous
parents, and incomplete/overlapping/disconnected layouts are declined.

RoomPlan does not assign interior/exterior wall faces or physical thickness.
For this modeling adapter only, observed planes are ASSUMED to be inside faces;
they are offset outward by 0.06 m to create the worker's wall centerlines. This
preserves the observed-plane room under that assumption; it does not certify
clearance or survey accuracy. The source packet is retained for later review.
"""

from __future__ import annotations

from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
from statistics import median

from reconstruction.geometry import GeometryError, signed_area, triangulate_polygon, validate_request
from reconstruction.pipeline import generate

SCHEMA_VERSION = "roomplan-scan/1.0"
MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_WALLS = 64
MAX_OPENINGS = 128
WALL_THICKNESS = 0.12
JOIN_TOLERANCE = 0.10
FLOOR_TOLERANCE = 0.08
OPENING_TOLERANCE = 0.05
UPRIGHT_TOLERANCE = 0.01
ROTATION_TOLERANCE = 0.001
EPS = 1e-8
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


class RoomPlanError(ValueError):
    """Malformed or unsupported scan; no fabricated bounding-box room is used."""


def _fail(path, message):
    raise RoomPlanError(f"{path}: {message}")


def _object(raw, fields, path):
    if not isinstance(raw, dict) or set(raw) != fields:
        _fail(path, "expected exact supported object fields")
    return raw


def _number(value, low, high, path):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        _fail(path, f"expected finite number from {low} to {high}")
    return float(value)


def _id(value, path):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        _fail(path, "expected safe ASCII identifier, at most 64 characters")
    return value


def _text(value, path, maximum=512):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        _fail(path, "expected bounded nonempty text")
    return value


def _timestamp(value, path):
    value = _text(value, path, 64)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _fail(path, "expected ISO 8601 timestamp")
    if parsed.tzinfo is None:
        _fail(path, "timestamp must include timezone")
    return value


def _array(value, count, path, minimum=0):
    if not isinstance(value, list) or not minimum <= len(value) <= count:
        _fail(path, f"expected array with {minimum}–{count} entries")
    return value


def _vector(value, path, low=-10_000, high=10_000):
    if not isinstance(value, list) or len(value) != 3:
        _fail(path, "expected three coordinates")
    return [_number(v, low, high, f"{path}[{i}]") for i, v in enumerate(value)]


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _cross(a, b):
    return a[0] * b[1] - a[1] * b[0]


def _distance(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _transform(raw, path, *, upright=True):
    if not isinstance(raw, list) or len(raw) != 16:
        _fail(path, "expected 16 column-major matrix entries")
    values = [_number(v, -10_000, 10_000, f"{path}[{i}]") for i, v in enumerate(raw)]
    if any(abs(values[i]) > 1e-6 for i in (3, 7, 11)) or abs(values[15] - 1) > 1e-6:
        _fail(path, "expected affine homogeneous rigid matrix")
    axes = [values[i:i + 3] for i in (0, 4, 8)]
    if any(abs(_dot(axis, axis) - 1) > ROTATION_TOLERANCE for axis in axes):
        _fail(path, "matrix rotation must be orthonormal (no scale)")
    if any(abs(_dot(axes[i], axes[j])) > ROTATION_TOLERANCE for i, j in ((0, 1), (0, 2), (1, 2))):
        _fail(path, "matrix rotation must be orthonormal (no shear)")
    a, b, c = axes
    determinant = (a[0] * (b[1] * c[2] - b[2] * c[1])
                   - b[0] * (a[1] * c[2] - a[2] * c[1])
                   + c[0] * (a[1] * b[2] - a[2] * b[1]))
    if abs(determinant - 1) > 0.002:
        _fail(path, "rotation must be right-handed; reflections are unsupported")
    if upright and max(abs(axes[1][0]), abs(axes[1][1] - 1), abs(axes[1][2]), abs(axes[0][1]), abs(axes[2][1])) > UPRIGHT_TOLERANCE:
        _fail(path, "sloped or inverted surfaces are unsupported; local Y must be upright")
    return values


def _rectangular(surface):
    points = surface["polygonCorners"]
    if not points:
        return
    if len(points) == 5 and math.dist(points[0], points[-1]) <= 0.001:
        points = points[:-1]
    if len(points) != 4:
        _fail(surface["id"], "nonrectangular polygon surface is unsupported; source polygon is retained")
    width, height = surface["dimensions"][:2]
    matched = set()
    ordered = []
    for x, y, z in points:
        if abs(z) > 0.02 or abs(abs(x) - width / 2) > 0.02 or abs(abs(y) - height / 2) > 0.02:
            _fail(surface["id"], "nonrectangular/nonplanar local polygon is unsupported")
        matched.add((x > 0, y > 0))
        ordered.append((x > 0, y > 0))
    if len(matched) != 4:
        _fail(surface["id"], "polygon corners do not describe the rectangular dimensions")
    if any(sum(first[i] != second[i] for i in (0, 1)) != 1
           for first, second in zip(ordered, ordered[1:] + ordered[:1])):
        _fail(surface["id"], "polygon corner order is self-intersecting/nonrectangular")


def validate_scan(raw: object) -> dict:
    """Validate bounded scan data; reject unsupported surface shapes explicitly."""
    fields = {"schemaVersion", "projectId", "jobId", "inputRevision", "capturedAt", "roomId", "roomLabel", "device", "surfaces"}
    version = raw.get("schemaVersion") if isinstance(raw, dict) else None
    if version == "roomplan-scan/1.1":
        fields.add("objects")
    item = _object(raw, fields, "scan")
    if version not in (SCHEMA_VERSION, "roomplan-scan/1.1"):
        _fail("schemaVersion", "expected roomplan-scan/1.0 or roomplan-scan/1.1")
    revision = item["inputRevision"]
    if isinstance(revision, bool) or not isinstance(revision, int) or not 0 <= revision <= 2**53 - 1:
        _fail("inputRevision", "expected nonnegative safe integer")
    device = _object(item["device"], {"model", "systemVersion"}, "device")
    result = {"schemaVersion": version, "projectId": _id(item["projectId"], "projectId"),
              "jobId": _id(item["jobId"], "jobId"), "inputRevision": revision,
              "capturedAt": _timestamp(item["capturedAt"], "capturedAt"),
              "roomId": _id(item["roomId"], "roomId"), "roomLabel": _text(item["roomLabel"], "roomLabel"),
              "device": {"model": _text(device["model"], "device.model", 128),
                         "systemVersion": _text(device["systemVersion"], "device.systemVersion", 128)}, "surfaces": []}
    seen = {result["roomId"]}
    counts = {"wall": 0, "opening": 0}
    fields = {"id", "category", "dimensions", "transform", "confidence", "parentId", "polygonCorners", "isCurved"}
    for index, surface in enumerate(_array(item["surfaces"], MAX_WALLS + MAX_OPENINGS, "surfaces", 3)):
        path = f"surfaces[{index}]"
        surface = _object(surface, fields, path)
        ident = _id(surface["id"], f"{path}.id")
        if ident in seen:
            _fail(path, "duplicate room/surface identifier")
        seen.add(ident)
        if surface["category"] not in ("wall", "door", "window", "opening"):
            _fail(path, "unsupported surface category")
        category = surface["category"]
        counts["wall" if category == "wall" else "opening"] += 1
        if counts["wall"] > MAX_WALLS or counts["opening"] > MAX_OPENINGS:
            _fail("surfaces", "at most 64 walls and 128 openings are supported")
        dimensions = _vector(surface["dimensions"], f"{path}.dimensions", 0, 100)
        if dimensions[0] < 0.05 or not 0.1 <= dimensions[1] <= 20 or dimensions[2] > 10:
            _fail(path, "surface dimensions are outside supported limits")
        if surface["confidence"] not in ("low", "medium", "high", "unknown"):
            _fail(path, "unsupported confidence")
        if not isinstance(surface["isCurved"], bool):
            _fail(path, "isCurved must be boolean")
        if surface["isCurved"]:
            _fail(path, "curved surfaces are unsupported; rescan a planar room")
        normalized = {"id": ident, "category": category, "dimensions": dimensions,
            "transform": _transform(surface["transform"], f"{path}.transform"),
            "confidence": surface["confidence"],
            "parentId": None if surface["parentId"] is None else _id(surface["parentId"], f"{path}.parentId"),
            "polygonCorners": [_vector(point, f"{path}.polygonCorners[{i}]") for i, point in
                               enumerate(_array(surface["polygonCorners"], 64, f"{path}.polygonCorners"))],
            "isCurved": False}
        if category == "wall" and normalized["parentId"] is not None:
            _fail(path, "wall parentId must be null")
        _rectangular(normalized)
        result["surfaces"].append(normalized)
    if counts["wall"] < 3:
        _fail("surfaces", "at least three walls are needed for a closed room")
    if version == "roomplan-scan/1.1":
        from .objects import validate_objects
        result["objects"] = validate_objects(item["objects"], seen)
    return result


def _wall_line(surface):
    matrix = surface["transform"]
    length = math.hypot(matrix[0], matrix[2])
    direction = (matrix[0] / length, matrix[2] / length)
    half = surface["dimensions"][0] * length / 2
    center = (matrix[12], matrix[14])
    return ([center[0] - half * direction[0], center[1] - half * direction[1]],
            [center[0] + half * direction[0], center[1] + half * direction[1]])


def _intersection(a, b, c, d):
    first, second = (b[0] - a[0], b[1] - a[1]), (d[0] - c[0], d[1] - c[1])
    denominator = _cross(first, second)
    if abs(denominator) <= 1e-7 * max(1, math.hypot(*first) * math.hypot(*second)):
        return None
    ratio = _cross((c[0] - a[0], c[1] - a[1]), second) / denominator
    return [a[0] + ratio * first[0], a[1] + ratio * first[1]]


def _recover_loop(walls):
    lines = {wall["id"]: _wall_line(wall) for wall in walls}
    matches = {(wall["id"], end): [] for wall in walls for end in (0, 1)}
    for index, wall in enumerate(walls):
        a, b = lines[wall["id"]]
        for other in walls[:index]:
            c, d = lines[other["id"]]
            intersect = _intersection(a, b, c, d)
            for own_end, own_point in enumerate((a, b)):
                for other_end, other_point in enumerate((c, d)):
                    point = intersect
                    if point is None:
                        # Parallel continuation only; nearby parallel displaced
                        # walls are not silently turned into a large room edge.
                        length = _distance(a, b)
                        separation = abs(_cross((b[0] - a[0], b[1] - a[1]),
                                                (c[0] - a[0], c[1] - a[1]))) / length
                        if separation > 0.02 or _distance(own_point, other_point) > JOIN_TOLERANCE:
                            continue
                        point = [(own_point[i] + other_point[i]) / 2 for i in (0, 1)]
                    if max(_distance(own_point, point), _distance(other_point, point)) <= JOIN_TOLERANCE:
                        first, second = (wall["id"], own_end), (other["id"], other_end)
                        matches[first].append((second, point))
                        matches[second].append((first, point))
    for endpoint, candidates in matches.items():
        if len(candidates) != 1:
            problem = "partial/disconnected" if not candidates else "branched/ambiguous"
            _fail(endpoint[0], f"{problem} wall loop at endpoint {endpoint[1]}; rescan rather than inventing walls")
    start = (min(lines), 0)
    current = start
    ordered_ids, vertices, corrections = [], [], []
    while current[0] not in ordered_ids:
        ident, begin = current
        ordered_ids.append(ident)
        partner, point = matches[current][0]
        vertices.append(point[:])
        for endpoint in (current, partner):
            delta = _distance(lines[endpoint[0]][endpoint[1]], point)
            if delta > EPS:
                corrections.append({"surfaceId": endpoint[0], "kind": "wall_endpoint_join",
                                    "endpoint": endpoint[1], "distanceMeters": delta})
        current = matches[(ident, 1 - begin)][0][0]
    if current != start or len(ordered_ids) != len(walls):
        _fail("surfaces", "disconnected or multiple room loops are unsupported")
    try:
        triangulate_polygon(vertices)
    except GeometryError as error:
        _fail("surfaces", "invalid/self-intersecting recovered room loop: " + str(error))
    # Keep IDs paired with their outgoing edge while making the loop CCW in X/Z.
    if signed_area(vertices) < 0:
        vertices = [vertices[0]] + list(reversed(vertices[1:]))
        ordered_ids = list(reversed(ordered_ids))
    for index, vertex in enumerate(vertices):
        if _distance(vertex, vertices[(index + 1) % len(vertices)]) < 0.05:
            _fail("surfaces", "wall recovery would create a collapsed/very short segment")
    return ordered_ids, vertices, corrections


def _offset_loop(vertices):
    shifted = []
    for index, a in enumerate(vertices):
        b = vertices[(index + 1) % len(vertices)]
        length = _distance(a, b)
        outward = ((b[1] - a[1]) / length, -(b[0] - a[0]) / length)
        shifted.append(([a[i] + outward[i] * WALL_THICKNESS / 2 for i in (0, 1)],
                        [b[i] + outward[i] * WALL_THICKNESS / 2 for i in (0, 1)]))
    result = []
    for index, original in enumerate(vertices):
        previous, current = shifted[index - 1], shifted[index]
        point = _intersection(*previous, *current)
        if point is None:
            if _distance(previous[1], current[0]) > 0.021:
                _fail("surfaces", "parallel offset corner is ambiguous")
            point = [(previous[1][i] + current[0][i]) / 2 for i in (0, 1)]
        if _distance(original, point) > 4 * WALL_THICKNESS / 2:
            _fail("surfaces", "corner offset exceeds miter limit; unsupported narrow/acute geometry")
        result.append(point)
    return result


def _evidence_id(value):
    return "rp-" + hashlib.sha256(value.encode()).hexdigest()[:24]


def import_scan(raw: object) -> dict:
    """Return a review-required canonical request or explicitly decline a scan."""
    scan = validate_scan(raw)
    surfaces = {surface["id"]: surface for surface in scan["surfaces"]}
    source_walls = [surface for surface in scan["surfaces"] if surface["category"] == "wall"]
    ordered_ids, inside, corrections = _recover_loop(source_walls)
    centerlines = _offset_loop(inside)
    bottoms, tops = [], []
    for wall in source_walls:
        matrix, dimensions = wall["transform"], wall["dimensions"]
        center_bottom = matrix[13] - dimensions[1] * matrix[5] / 2
        center_top = matrix[13] + dimensions[1] * matrix[5] / 2
        bottoms.extend(center_bottom + sign * dimensions[0] * matrix[1] / 2 for sign in (-1, 1))
        tops.extend(center_top + sign * dimensions[0] * matrix[1] / 2 for sign in (-1, 1))
    floor_y, top_y = median(bottoms), median(tops)
    if max(abs(value - floor_y) for value in bottoms) > FLOOR_TOLERANCE:
        _fail("surfaces", "wall bottoms do not support one flat floor; stairs or partial walls are unsupported")
    if max(abs(value - top_y) for value in tops) > FLOOR_TOLERANCE:
        _fail("surfaces", "nonuniform/sloped wall tops are unsupported")
    height = top_y - floor_y
    if not 0.5 <= height <= 20:
        _fail("surfaces", "recovered room height is outside supported range")
    warnings = [
        "RoomPlan surfaces are sensor-derived estimates, not survey-accurate measurements; review scale and fit.",
        "RoomPlan does not identify interior/exterior faces or wall thickness. Observed planes are ASSUMED inside faces for this model only.",
        "Wall thickness is an inferred 0.12 m modeling default; centerlines offset outward 0.06 m preserve the assumed inside planes, not certified clearances.",
        "Only one closed planar room is supported. Glass, door leaves, ceilings, stairs geometry, and curved/nonrectangular structural surfaces are not reconstructed.",
    ]
    if corrections:
        warnings.append("Small wall endpoint gaps were corrected by bounded joins; inspect the recorded correction distances.")
    prefix = f"roomplan:{scan['projectId']}:{scan['jobId']}:"
    evidence = []
    source_evidence = {}
    for surface in scan["surfaces"]:
        ident = _evidence_id(prefix + surface["id"])
        source_evidence[surface["id"]] = ident
        evidence.append({"id": ident, "sourceUrl": None, "privateAssetId": prefix + "surface:" + surface["id"],
                         "observedAt": scan["capturedAt"], "claim": f"Native RoomPlan {surface['category']} surface dimensions/transform; capture confidence {surface['confidence']}. Sensor-derived estimate, not survey accuracy.",
                         "dimensionStatus": "source_dimension", "confirmedByUserAt": None})
        if surface["confidence"] in ("low", "unknown"):
            warnings.append(f"Surface {surface['id']} has {surface['confidence']} capture confidence.")
    thickness_id = _evidence_id(prefix + "thickness")
    layout_id = _evidence_id(prefix + "layout")
    evidence.extend([
        {"id": thickness_id, "sourceUrl": None, "privateAssetId": prefix + "scan.input.json",
         "observedAt": scan["capturedAt"], "claim": "Wall thickness 0.12 m is an inferred modeling convention; RoomPlan does not provide thickness.",
         "dimensionStatus": "inferred", "confirmedByUserAt": None},
        {"id": layout_id, "sourceUrl": None, "privateAssetId": prefix + "scan.input.json",
         "observedAt": scan["capturedAt"], "claim": "One closed room loop derived from source wall planes, bounded endpoint corrections, and assumed inside-face outward offsets; floor Y normalized to zero.",
         "dimensionStatus": "inferred", "confirmedByUserAt": None},
    ])
    walls = []
    source_segments = {}
    for index, ident in enumerate(ordered_ids):
        surface = surfaces[ident]
        matrix, dims = surface["transform"], surface["dimensions"]
        bottom = matrix[13] - dims[1] * matrix[5] / 2
        if abs(bottom - floor_y) > EPS:
            corrections.append({"surfaceId": ident, "kind": "floor_alignment", "distanceMeters": abs(bottom - floor_y)})
        if abs(dims[1] - height) > EPS:
            corrections.append({"surfaceId": ident, "kind": "height_alignment", "distanceMeters": abs(dims[1] - height)})
        walls.append({"id": ident, "start": centerlines[index], "end": centerlines[(index + 1) % len(centerlines)],
                      "height": height, "thickness": WALL_THICKNESS,
                      "evidenceIds": [source_evidence[ident], thickness_id, layout_id]})
        source_segments[ident] = (inside[index], inside[(index + 1) % len(inside)])
    openings = []
    for surface in scan["surfaces"]:
        if surface["category"] == "wall":
            continue
        matrix, dims = surface["transform"], surface["dimensions"]
        center = (matrix[12], matrix[14])
        opening_axis = (matrix[0], matrix[2])
        axis_length = math.hypot(*opening_axis)
        opening_axis = tuple(value / axis_length for value in opening_axis)
        width = dims[0] * axis_length
        candidates = []
        for parent in walls:
            a, b = source_segments[parent["id"]]
            length = _distance(a, b)
            direction = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
            parallel = abs(_dot(opening_axis, direction)) >= math.cos(math.radians(2))
            center_plane_error = abs(_cross(direction, (center[0] - a[0], center[1] - a[1])))
            plane_error = center_plane_error + width / 2 * abs(_cross(opening_axis, direction))
            along = _dot((center[0] - a[0], center[1] - a[1]), direction)
            if parallel and plane_error <= OPENING_TOLERANCE and along - width / 2 >= -OPENING_TOLERANCE and along + width / 2 <= length + OPENING_TOLERANCE:
                candidates.append((parent, along - width / 2, along + width / 2, length, center_plane_error))
        parent_id = surface["parentId"]
        if parent_id is not None:
            if parent_id not in surfaces or surfaces[parent_id]["category"] != "wall":
                _fail(surface["id"], "parentId does not identify a source wall")
            candidates = [candidate for candidate in candidates if candidate[0]["id"] == parent_id]
        if len(candidates) != 1:
            _fail(surface["id"], "opening parent is missing, incompatible, or geometrically ambiguous; no nearest-wall guess used")
        wall, low, high, length, plane_error = candidates[0]
        if plane_error > EPS:
            corrections.append({"surfaceId": surface["id"], "kind": "opening_plane_projection", "distanceMeters": plane_error})
        clipped_low, clipped_high = max(0, low), min(length, high)
        if clipped_low != low or clipped_high != high:
            corrections.append({"surfaceId": surface["id"], "kind": "opening_horizontal_clip",
                                "distanceMeters": max(abs(clipped_low - low), abs(clipped_high - high))})
        sill = matrix[13] - dims[1] * matrix[5] / 2 - floor_y
        opening_height = dims[1] * matrix[5]
        kind = "window" if surface["category"] == "window" else "door"
        if kind == "door":
            if abs(sill) > OPENING_TOLERANCE:
                _fail(surface["id"], "non-floor-aligned door/generic opening is unsupported; not relabeled as a window")
            if abs(sill) > EPS:
                corrections.append({"surfaceId": surface["id"], "kind": "opening_floor_alignment", "distanceMeters": abs(sill)})
            sill = 0.0
        elif sill < 0:
            if sill < -OPENING_TOLERANCE:
                _fail(surface["id"], "window extends below recovered floor")
            corrections.append({"surfaceId": surface["id"], "kind": "opening_floor_clip", "distanceMeters": -sill})
            opening_height += sill
            sill = 0.0
        overhang = sill + opening_height - height
        if overhang > OPENING_TOLERANCE:
            _fail(surface["id"], "opening extends above room height")
        if overhang > 0:
            corrections.append({"surfaceId": surface["id"], "kind": "opening_height_clip", "distanceMeters": overhang})
            opening_height -= overhang
        if clipped_high - clipped_low < 0.01 or opening_height < 0.01:
            _fail(surface["id"], "opening collapsed after bounded clipping")
        source_start, source_end = source_segments[wall["id"]]
        source_length = _distance(source_start, source_end)
        axis = ((source_end[0] - source_start[0]) / source_length, (source_end[1] - source_start[1]) / source_length)
        offset = clipped_low + _dot((source_start[0] - wall["start"][0], source_start[1] - wall["start"][1]), axis)
        openings.append({"id": surface["id"], "wallId": wall["id"], "kind": kind, "offset": offset,
                         "width": clipped_high - clipped_low, "height": opening_height, "sillHeight": sill,
                         "evidenceIds": [source_evidence[surface["id"]], source_evidence[wall["id"]], thickness_id, layout_id]})
    room_evidence = [source_evidence[ident] for ident in ordered_ids]
    # The shared contract permits at most64 evidence references per element.
    # Policy evidence remains attached to every wall if all64 room slots are
    # needed for source surfaces.
    if len(room_evidence) <= 62:
        room_evidence = [layout_id, thickness_id] + room_evidence
    from .objects import compile_objects
    items, omitted_objects = compile_objects(scan, floor_y, evidence, warnings)
    if "objects" in scan:
        warnings.append("Detected existing objects are separate locked size proxies, not textured furniture meshes or catalog products; review their dimensions and placement.")
    try:
        request = validate_request({"jobId": scan["jobId"], "projectId": scan["projectId"], "inputRevision": scan["inputRevision"],
            "geometry": {"units": "m", "coordinateSystem": "right-handed-y-up",
                         "rooms": [{"id": scan["roomId"], "label": scan["roomLabel"], "floorPolygon": centerlines,
                                    "height": height, "evidenceIds": room_evidence}],
                         "walls": walls, "openings": openings}, "evidence": evidence,
            **({"items": items} if "objects" in scan else {})})
    except GeometryError as error:
        raise RoomPlanError("Canonical geometry rejected the sensor-derived proposal: " + str(error)) from None
    if any(correction["kind"].startswith("opening_") for correction in corrections):
        warnings.append("Tiny opening boundary/floor discrepancies were clipped; inspect correction distances before relying on fit.")
    if corrections:
        warnings.append("The importer applied recorded bounded geometry/alignment corrections; review every correction before relying on fit.")
    return {"status": "needs_review", "reviewRequired": True, "method": "native_roomplan_surface_import",
            "request": request, "warnings": warnings, "corrections": corrections, "floorY": floor_y,
            **({"detectedObjectCount": len(scan["objects"]), "importedItemCount": len(items), "omittedObjects": omitted_objects} if "objects" in scan else {}),
            "coordinatePolicy": {"units": "m", "coordinateSystem": "right-handed-y-up",
                "sourceToCanonicalTranslation": [0, -floor_y, 0], "wallThicknessMeters": WALL_THICKNESS,
                "observedWallPlanes": "assumed_inside_faces_not_certified", "sourcePlaneLoop": inside,
                "maxEndpointCorrectionMeters": JOIN_TOLERANCE}}


def _read(path):
    with Path(path).open("rb") as stream:
        body = stream.read(MAX_INPUT_BYTES + 1)
    if len(body) > MAX_INPUT_BYTES:
        raise RoomPlanError("RoomPlan JSON exceeds 2 MiB")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise RoomPlanError("RoomPlan JSON contains duplicate keys")
            result[key] = value
        return result
    def constant(_):
        raise RoomPlanError("RoomPlan JSON contains nonfinite numbers")
    try:
        return json.loads(body, object_pairs_hook=pairs, parse_constant=constant), body
    except (UnicodeError, ValueError, RecursionError) as error:
        raise RoomPlanError("RoomPlan input is invalid bounded UTF-8 JSON") from error


def _write(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    os.chmod(path, 0o600)


def run(input_path, output_path, *, render=False, blender=None, preview=False,
        expected_project=None, expected_job=None, expected_revision=None):
    """Keep private source/dossier and optionally generate a fresh Blender draft."""
    bundle = None
    if Path(input_path).suffix.lower() == ".zip":
        from .photo_bundle import read_photo_bundle
        bundle = read_photo_bundle(input_path)
        raw, body = bundle["scan"], bundle["scanBytes"]
    else:
        raw, body = _read(input_path)
    for key, expected in (("projectId", expected_project), ("jobId", expected_job), ("inputRevision", expected_revision)):
        if expected is not None and (not isinstance(raw, dict) or raw.get(key) != expected):
            raise RoomPlanError(f"RoomPlan {key} does not match the authorized job")
    output = Path(output_path).absolute()
    if output.exists() or output.is_symlink():
        raise RoomPlanError("RoomPlan output already exists; choose a fresh private directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir(mode=0o700)
    source_path = output / "scan.input.json"
    source_path.write_bytes(body)
    os.chmod(source_path, 0o600)
    dossier = {"schemaVersion": "roomplan-result/1.0", "status": "failed", "reviewRequired": True,
               "method": "native_roomplan_surface_import", "inputSha256": hashlib.sha256(body).hexdigest(),
               "sourcePath": "scan.input.json", "reconstructionRequestPath": None, "draftManifestPath": None}
    if bundle is not None:
        _write_photo_sources(output, bundle, dossier)
    try:
        compiled = import_scan(raw)
        if bundle is not None:
            _attach_photo_evidence(output, bundle, compiled, dossier)
        dossier.update({key: compiled[key] for key in ("status", "warnings", "corrections", "floorY", "coordinatePolicy")})
        dossier.update({key: compiled["request"][key] for key in ("projectId", "jobId", "inputRevision")})
        dossier.update({key: compiled[key] for key in ("detectedObjectCount", "importedItemCount", "omittedObjects") if key in compiled})
        _write(output / "reconstruction.request.json", compiled["request"])
        dossier["reconstructionRequestPath"] = "reconstruction.request.json"
        _write(output / "roomplan.dossier.json", dossier)
        if render:
            result = generate(output / "reconstruction.request.json", output / "draft", blender=blender, preview=preview)
            result["warnings"].extend(compiled["warnings"])
            _write(output / "draft/manifest.json", result)
            dossier["draftManifestPath"] = "draft/manifest.json"
        _write(output / "roomplan.dossier.json", dossier)
        return dossier
    except Exception as error:
        dossier["status"] = "failed"
        dossier["error"] = str(error)[:2000] if isinstance(error, RoomPlanError) else "RoomPlan draft generation failed; inspect private worker configuration."
        _write(output / "roomplan.dossier.json", dossier)
        raise


def _private_bytes(path, body):
    path.write_bytes(body)
    os.chmod(path, 0o600)


def _write_photo_sources(output, bundle, dossier):
    """Copy only individually validated members, never extract ZIP paths."""
    _private_bytes(output / "scan.input.zip", bundle["archiveBytes"])
    _private_bytes(output / "photos.manifest.json", bundle["manifestBytes"])
    (output / "photos").mkdir(mode=0o700)
    for photo in bundle["manifest"]["photos"]:
        _private_bytes(output / "photos" / (photo["id"] + ".jpg"), bundle["files"][photo["path"]])
    dossier.update({"photoCount": len(bundle["manifest"]["photos"]),
                    "photoManifestPath": "photos.manifest.json", "photoRegistrationPath": None,
                    "appearancePhotosPath": None, "photoArchivePath": "scan.input.zip",
                    "photoArchiveSha256": bundle["sha256"]})


def _attach_photo_evidence(output, bundle, compiled, dossier):
    from .photo_bundle import representative_photos
    photos = bundle["manifest"]["photos"]
    request = compiled["request"]
    references = {}
    for photo in photos:
        ident = _evidence_id(request["jobId"] + ":rgb:" + photo["id"])
        references[photo["id"]] = ident
        request["evidence"].append({"id": ident, "sourceUrl": None,
            "privateAssetId": request["jobId"] + ":" + photo["path"],
            "observedAt": photo["capturedAt"],
            "claim": "Captured-room RGB appearance evidence; photo SHA-256 " + photo["sha256"]
                + ". Camera pose is source ARKit tracking, not verified texture alignment or furniture identity.",
            "dimensionStatus": None, "confirmedByUserAt": None})
    validate_request(request)
    registration = {"schemaVersion": "roomplan-photo-registration/1.0", "reviewRequired": True,
        "sourceManifestPath": "photos.manifest.json", "coordinateSystem": bundle["manifest"]["coordinateSystem"],
        "imageConvention": bundle["manifest"]["imageConvention"],
        "sourceToCanonicalTranslation": compiled["coordinatePolicy"]["sourceToCanonicalTranslation"],
        "posePolicy": "Camera-to-world column-major transforms remain unmodified in source ARKit space. Add the recorded translation once for canonical room coordinates. ARKit drift/relocalization may require registration review.",
        "photos": [{**photo, "evidenceId": references[photo["id"]]} for photo in photos]}
    _write(output / "photo-registration.json", registration)
    selected = representative_photos(photos)
    _write(output / "appearance.photos.json", {"photos": [
        {"id": photo["id"], "evidenceId": references[photo["id"]], "sha256": photo["sha256"],
         "mediaType": "image/jpeg", "scope": "captured_room", "path": photo["path"]}
        for photo in selected]})
    dossier.update({"photoRegistrationPath": "photo-registration.json",
                    "appearancePhotosPath": "appearance.photos.json", "appearancePhotoCount": len(selected)})
    compiled["warnings"].append("RGB photos are retained as captured-room appearance evidence, with original camera poses and calibration. They do not automatically create textured walls or exact furniture meshes; registration and appearance require review.")
