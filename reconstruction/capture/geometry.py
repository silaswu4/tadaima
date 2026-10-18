"""Compile explicit rectangular-room measurements, not photo-derived geometry.

The frozen input wire schema lives in capture/contracts.ts. Public functions:
    validate_manifest(raw) -> normalized MobileCaptureManifest (no I/O).
    compile_capture(raw) -> review state and optional ReconstructionRequest.

Clear room dimensions and aperture offsets describe inside wall faces. The
shared generator uses centerline boundaries, so the compiler adds half the
wall thickness at both room bounds and at each opening's starting offset.
Evidence records user-declared tape/laser measurements as measured; this does
not certify that a person actually took the measurement. Photos remain private
references and never provide a fabricated dimensional measurement.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime
from typing import Any

from reconstruction.geometry import EPS, GeometryError, validate_request

# The capture CLI can report one validation error type while preserving errors
# raised by the shared canonical room validator.
CaptureError = GeometryError

SCHEMA_VERSION = "mobile-capture/1.0"
DEFAULT_WALL_THICKNESS = 0.12
MAX_PHOTOS = 16
MAX_OPENINGS = 32
WALLS = ("a", "b", "c", "d")
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")


def _fail(path: str, message: str):
    raise GeometryError(f"{path}: {message}")


def _object(raw: Any, path: str, fields: set[str]):
    if not isinstance(raw, dict):
        _fail(path, "expected an object")
    if missing := fields - raw.keys():
        _fail(path, "missing fields: " + ", ".join(sorted(missing)))
    if extra := raw.keys() - fields:
        _fail(path, "unsupported fields: " + ", ".join(sorted(map(str, extra))))
    return raw


def _array(raw: Any, path: str, maximum: int):
    if not isinstance(raw, list) or len(raw) > maximum:
        _fail(path, f"expected an array of at most {maximum} entries")
    return raw


def _id(raw: Any, path: str):
    if not isinstance(raw, str) or not _ID.fullmatch(raw):
        _fail(path, "expected a safe ASCII ID, at most 64 characters")
    return raw


def _text(raw: Any, path: str, maximum=512):
    if not isinstance(raw, str) or not raw.strip() or len(raw) > maximum:
        _fail(path, f"expected nonempty text, at most {maximum} characters")
    return raw


def _number(raw: Any, path: str, low: float, high: float):
    # Range checks exclude infinities/NaN before float conversion and avoid
    # OverflowError when JSON supplies an arbitrarily large Python integer.
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not low <= raw <= high:
        _fail(path, f"expected a finite number from {low} to {high}")
    return float(raw)


def _integer(raw: Any, path: str, low: int, high: int):
    if isinstance(raw, bool) or not isinstance(raw, int) or not low <= raw <= high:
        _fail(path, f"expected an integer from {low} to {high}")
    return raw


def _timestamp(raw: Any, path: str):
    value = _text(raw, path, 64)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _fail(path, "expected an ISO 8601 timestamp with timezone")
    if parsed.tzinfo is None:
        _fail(path, "timestamp must include timezone")
    return value


def _measurement(raw: Any, path: str, low: float, high: float, *, nullable=False):
    if raw is None and nullable:
        return None
    item = _object(raw, path, {"valueMeters", "method", "observedAt"})
    if item["method"] not in ("tape", "laser", "estimate"):
        _fail(path, "method must be tape, laser, or estimate")
    return {"valueMeters": _number(item["valueMeters"], f"{path}.valueMeters", low, high),
            "method": item["method"], "observedAt": _timestamp(item["observedAt"], f"{path}.observedAt")}


def validate_manifest(raw: object) -> dict:
    """Validate metadata only; reading or authenticating referenced JPEGs is I/O.

    Exactly one explicitly rectangular room is supported. Required but missing
    dimensions are represented by null and remain missing rather than defaulted.
    JPEG dimensions are metadata until the capture worker decodes each file.
    """
    item = _object(raw, "capture", {"schemaVersion", "jobId", "projectId", "inputRevision", "capturedAt",
                                    "captureMode", "room", "photos", "openings"})
    if item["schemaVersion"] != SCHEMA_VERSION:
        _fail("capture.schemaVersion", f"expected {SCHEMA_VERSION}")
    if item["captureMode"] not in ("guided_photos", "manual"):
        _fail("capture.captureMode", "expected guided_photos or manual")
    room = _object(item["room"], "room", {"id", "label", "shape", "clearWidth", "clearDepth", "height",
                                         "wallThickness", "confirmedRectangularAt"})
    if room["shape"] != "rectangle":
        _fail("room.shape", "only explicit rectangle geometry is supported")
    normalized_room = {
        "id": _id(room["id"], "room.id"), "label": _text(room["label"], "room.label"), "shape": "rectangle",
        "clearWidth": _measurement(room["clearWidth"], "room.clearWidth", 0.2, 100, nullable=True),
        "clearDepth": _measurement(room["clearDepth"], "room.clearDepth", 0.2, 100, nullable=True),
        "height": _measurement(room["height"], "room.height", 0.5, 20, nullable=True),
        "wallThickness": _measurement(room["wallThickness"], "room.wallThickness", 0.02, 1, nullable=True),
        "confirmedRectangularAt": None if room["confirmedRectangularAt"] is None else
            _timestamp(room["confirmedRectangularAt"], "room.confirmedRectangularAt"),
    }
    photos = []
    photo_ids = set()
    for index, photo in enumerate(_array(item["photos"], "photos", MAX_PHOTOS)):
        path = f"photos[{index}]"
        photo = _object(photo, path, {"id", "fileName", "sha256", "mediaType", "width", "height", "wall",
                                      "capturedAt", "quality"})
        ident = _id(photo["id"], f"{path}.id")
        if ident in photo_ids:
            _fail(path, "duplicate photo ID")
        photo_ids.add(ident)
        if photo["fileName"] != f"photos/{ident}.jpg":
            _fail(f"{path}.fileName", "expected photos/<matching-safe-id>.jpg")
        if not isinstance(photo["sha256"], str) or not _SHA256.fullmatch(photo["sha256"]):
            _fail(f"{path}.sha256", "expected a 64-character SHA-256 hexadecimal digest")
        if photo["mediaType"] != "image/jpeg":
            _fail(f"{path}.mediaType", "only image/jpeg is supported")
        if photo["wall"] not in (*WALLS, "overview"):
            _fail(f"{path}.wall", "expected a, b, c, d, or overview")
        quality = _object(photo["quality"], f"{path}.quality", {"meanLuminance", "edgeEnergy"})
        photos.append({"id": ident, "fileName": photo["fileName"], "sha256": photo["sha256"].lower(),
            "mediaType": "image/jpeg", "width": _integer(photo["width"], f"{path}.width", 320, 4096),
            "height": _integer(photo["height"], f"{path}.height", 320, 4096), "wall": photo["wall"],
            "capturedAt": _timestamp(photo["capturedAt"], f"{path}.capturedAt"),
            "quality": {"meanLuminance": _number(quality["meanLuminance"], f"{path}.quality.meanLuminance", 0, 255),
                        "edgeEnergy": _number(quality["edgeEnergy"], f"{path}.quality.edgeEnergy", 0, 255)}})
    openings = []
    opening_ids = set()
    for index, opening in enumerate(_array(item["openings"], "openings", MAX_OPENINGS)):
        path = f"openings[{index}]"
        opening = _object(opening, path, {"id", "wall", "kind", "offset", "width", "height", "sillHeight"})
        ident = _id(opening["id"], f"{path}.id")
        if ident in opening_ids or ident == normalized_room["id"]:
            _fail(path, "duplicate room/opening ID")
        opening_ids.add(ident)
        if opening["wall"] not in WALLS:
            _fail(f"{path}.wall", "expected a, b, c, or d")
        if opening["kind"] not in ("door", "window"):
            _fail(f"{path}.kind", "expected door or window")
        normalized = {"id": ident, "wall": opening["wall"], "kind": opening["kind"],
            "offset": _measurement(opening["offset"], f"{path}.offset", 0, 100),
            "width": _measurement(opening["width"], f"{path}.width", 0.01, 100),
            "height": _measurement(opening["height"], f"{path}.height", 0.01, 20),
            "sillHeight": _measurement(opening["sillHeight"], f"{path}.sillHeight", 0, 20)}
        if normalized["kind"] == "door" and normalized["sillHeight"]["valueMeters"] > EPS:
            _fail(path, "door sillHeight must be zero")
        clear_dimension = normalized_room["clearWidth" if normalized["wall"] in ("a", "c") else "clearDepth"]
        if clear_dimension and normalized["offset"]["valueMeters"] + normalized["width"]["valueMeters"] > clear_dimension["valueMeters"] + EPS:
            _fail(path, "opening extends beyond the clear inside wall length")
        if normalized_room["height"] and normalized["sillHeight"]["valueMeters"] + normalized["height"]["valueMeters"] > normalized_room["height"]["valueMeters"] + EPS:
            _fail(path, "opening extends above room height")
        openings.append(normalized)
    return {
        "schemaVersion": SCHEMA_VERSION, "jobId": _id(item["jobId"], "jobId"),
        "projectId": _id(item["projectId"], "projectId"),
        "inputRevision": _integer(item["inputRevision"], "inputRevision", 0, 9_007_199_254_740_991),
        "capturedAt": _timestamp(item["capturedAt"], "capturedAt"), "captureMode": item["captureMode"],
        "room": normalized_room, "photos": photos, "openings": openings,
    }


def _stable_id(prefix: str, value: str):
    return prefix + "-" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:24]


def compile_capture(raw: object) -> dict:
    """Produce a reviewable shell from explicit dimensions, never infer from photos.

    All successful states require human review. An estimated measurement or
    inferred default thickness selects needs_review; all supplied measurements
    declared tape/laser select ready_for_review. Missing dimensions or an absent
    rectangular confirmation select needs_measurements with request=None.
    """
    manifest = validate_manifest(raw)
    room = manifest["room"]
    missing = [f"room.{key}" for key in ("clearWidth", "clearDepth", "height") if room[key] is None]
    if room["confirmedRectangularAt"] is None:
        missing.append("room.confirmedRectangularAt")
    warnings = [
        "This is a measurement-driven rectangular shell; photos are references, not photogrammetry or a measured scan.",
        "Tape/laser methods are user declarations and have not been independently verified.",
    ]
    if manifest["captureMode"] == "guided_photos":
        coverage = {photo["wall"] for photo in manifest["photos"]}
        absent = [wall.upper() for wall in WALLS if wall not in coverage]
        if absent:
            warnings.append("Guided photo reference coverage is incomplete: " + ", ".join(absent) + ".")
    if missing:
        return {"status": "needs_measurements", "reviewRequired": True, "warnings": warnings,
                "missingMeasurements": missing, "request": None}
    prefix = f"capture:{manifest['projectId']}:{manifest['jobId']}:"
    evidence = []
    measurements = {}
    inferred = False

    def add_measurement(path, measurement, *, default=False):
        nonlocal inferred
        evidence_id = _stable_id("ev", prefix + path)
        status = "inferred" if default or measurement["method"] == "estimate" else "measured"
        inferred = inferred or status == "inferred"
        if default:
            claim = "Wall thickness defaulted to 0.12 m; inferred by the compiler, not measured."
        else:
            claim = (f"{path}: {measurement['valueMeters']:g} m; user-declared "
                     f"{measurement['method']} measurement, not independently verified.")
        evidence.append({"id": evidence_id, "sourceUrl": None, "privateAssetId": prefix + path,
            "observedAt": measurement["observedAt"], "claim": claim, "dimensionStatus": status,
            "confirmedByUserAt": None})
        measurements[path] = evidence_id
        return evidence_id

    for key in ("clearWidth", "clearDepth", "height"):
        add_measurement("room." + key, room[key])
    thickness = room["wallThickness"]
    if thickness is None:
        thickness = {"valueMeters": DEFAULT_WALL_THICKNESS, "method": "estimate", "observedAt": manifest["capturedAt"]}
        warnings.append("Wall thickness was not supplied; 0.12 m is an inferred modeling default.")
        add_measurement("room.wallThickness", thickness, default=True)
    else:
        add_measurement("room.wallThickness", thickness)
    shape_id = _stable_id("ev", prefix + "room.confirmedRectangularAt")
    evidence.append({"id": shape_id, "sourceUrl": None, "privateAssetId": prefix + "room.confirmedRectangularAt",
        "observedAt": room["confirmedRectangularAt"], "claim": "User confirmed the rectangular-room assumption.",
        "dimensionStatus": None, "confirmedByUserAt": room["confirmedRectangularAt"]})
    photo_evidence = {}
    for photo in manifest["photos"]:
        ident = _stable_id("ev", prefix + "photo." + photo["id"])
        evidence.append({"id": ident, "sourceUrl": None, "privateAssetId": prefix + photo["fileName"],
            "observedAt": photo["capturedAt"], "claim": f"Private {photo['wall']} reference photo; no dimensions derived from it.",
            "dimensionStatus": None, "confirmedByUserAt": None})
        photo_evidence[photo["id"]] = ident
    width, depth, height, t = (room["clearWidth"]["valueMeters"], room["clearDepth"]["valueMeters"],
                                room["height"]["valueMeters"], thickness["valueMeters"])
    points = [[-t / 2, -t / 2], [width + t / 2, -t / 2],
              [width + t / 2, depth + t / 2], [-t / 2, depth + t / 2]]
    wall_ids = {wall: _stable_id("wall", room["id"] + ":" + wall) for wall in WALLS}
    walls = []
    for index, letter in enumerate(WALLS):
        refs = [measurements["room.clearWidth" if letter in ("a", "c") else "room.clearDepth"],
                measurements["room.height"], measurements["room.wallThickness"]]
        refs += [photo_evidence[photo["id"]] for photo in manifest["photos"] if photo["wall"] in (letter, "overview")]
        walls.append({"id": wall_ids[letter], "start": points[index][:], "end": points[(index + 1) % 4][:],
                      "height": height, "thickness": t, "evidenceIds": refs})
    openings = []
    for opening in manifest["openings"]:
        refs = [add_measurement(f"opening.{opening['id']}.{field}", opening[field])
                for field in ("offset", "width", "height", "sillHeight")]
        refs += [photo_evidence[photo["id"]] for photo in manifest["photos"] if photo["wall"] == opening["wall"]]
        openings.append({"id": opening["id"], "wallId": wall_ids[opening["wall"]], "kind": opening["kind"],
                         "offset": opening["offset"]["valueMeters"] + t / 2,
                         "width": opening["width"]["valueMeters"], "height": opening["height"]["valueMeters"],
                         "sillHeight": opening["sillHeight"]["valueMeters"], "evidenceIds": refs})
    request = validate_request({
        "jobId": manifest["jobId"], "projectId": manifest["projectId"], "inputRevision": manifest["inputRevision"],
        "geometry": {"units": "m", "coordinateSystem": "right-handed-y-up",
            "rooms": [{"id": room["id"], "label": room["label"], "floorPolygon": points, "height": height,
                       "evidenceIds": list(measurements.values())[:4] + [shape_id] + list(photo_evidence.values())}],
            "walls": walls, "openings": openings}, "evidence": evidence,
    })
    if inferred:
        warnings.append("One or more dimensions are inferred or estimated and need measurement review.")
    return {"status": "needs_review" if inferred else "ready_for_review", "reviewRequired": True,
            "warnings": warnings, "missingMeasurements": [], "request": request}
