"""Bounded, photo-cited visual design sidecar for a fixed reconstruction request.

A local Codex inspection may author this data-only file without provider keys.
The sidecar changes material and model families, never geometry, item positions,
dimensions or ownership. Missing bindings retain their existing fallback.
Staged photo metadata is supplied by the trusted capture-import boundary; no
network, provider call, image generation or automatic source upgrade occurs.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path

from reconstruction.address.schema import ID, ResearchError, arr, enum, obj, text, validate
from reconstruction.geometry import GeometryError, validate_request

MAX_PROFILE_BYTES = 2 * 1024 * 1024
MAX_PHOTOS = 32
MODELS = (
    "box_arm_sofa", "rounded_sofa", "loop_arm_plywood_chair", "box_arm_chair",
    "pedestal_table", "round_side_table", "rect_table", "cabinet", "waste_station",
    "unresolved_proxy",
)
COLOR = {"type": "string", "pattern": r"#[0-9a-fA-F]{6}"}
DIGEST = {"type": "string", "pattern": r"[0-9a-f]{64}"}
NUMBER = {"type": "number"}
CONFIDENCE = enum("low", "medium", "high")
REFERENCES = arr(ID, MAX_PHOTOS, 1)
SURFACE_SCHEMA = obj(
    entityId=ID, finish=enum("paint", "carpet", "wood", "tile"),
    color=COLOR, secondaryColor=COLOR, pattern=enum("plain", "dash", "linear", "inset_dash"),
    roughness=NUMBER, repeatMeters=NUMBER, rotationDegrees=NUMBER,
    confidence=CONFIDENCE, evidenceIds=REFERENCES,
)
ITEM_SCHEMA = obj(
    itemId=ID, label=text(200), model=enum(*MODELS),
    primaryColor=COLOR, secondaryColor=COLOR, frameColor=COLOR, accentColor=COLOR,
    pattern=enum("plain", "dash"), seatCount=NUMBER,
    confidence=CONFIDENCE, evidenceIds=REFERENCES, notes=text(2000),
)
DESIGN_PROFILE_SCHEMA = obj(
    schemaVersion=enum("room-visual-design/1.0"), producer=text(200),
    projectId=ID, jobId=ID, inputRevision=NUMBER, inputSha256=DIGEST,
    sources=arr(obj(photoId=ID, evidenceId=ID, sha256=DIGEST), MAX_PHOTOS),
    surfaces=arr(SURFACE_SCHEMA, 544), items=arr(ITEM_SCHEMA, 256),
    notes=arr(text(2000), 64),
)


def _fail(message):
    raise GeometryError("design profile: " + message)


def _photo_sources(photos, known_evidence):
    if not isinstance(photos, list) or len(photos) > MAX_PHOTOS:
        _fail("expected at most 32 staged photo metadata records")
    indexed = {}
    evidence_ids = set()
    for photo in photos:
        if not isinstance(photo, dict):
            _fail("staged photo metadata must be an object")
        try:
            validate(photo.get("id"), ID)
            validate(photo.get("evidenceId"), ID)
            validate(photo.get("sha256"), DIGEST)
        except ResearchError as error:
            _fail("invalid staged photo identity or SHA-256: " + str(error))
        if (photo["id"] in indexed or photo["evidenceId"] in evidence_ids
                or photo["evidenceId"] not in known_evidence):
            _fail("duplicate staged photo identity or unknown photo evidence")
        if "body" in photo:
            body = photo["body"]
            if not isinstance(body, bytes) or hashlib.sha256(body).hexdigest() != photo["sha256"]:
                _fail("staged photo bytes differ from source hash")
        indexed[photo["id"]] = photo
        evidence_ids.add(photo["evidenceId"])
    return indexed


def validate_design_profile(raw, request, photos):
    """Validate a local visual sidecar against exact normalized inputs and photos.

    ``photos`` is the full staged metadata list (``id/evidenceId/sha256`` plus
    optional calibrated capture fields), not the eight-photo appearance subset.
    If actual ``body`` bytes are supplied, their digest is also verified. Extra
    metadata fields are not copied into the sidecar. Inspected but uncited photo
    sources are permitted; every assigned surface/item still needs real cited
    evidence from the bounded source list.
    """
    # Keep this import lazy: appearance itself imports pipeline.read_request,
    # while pipeline integrations may import this sidecar validator.
    from reconstruction.appearance import request_sha256
    normalized = validate_request(request)
    try:
        validate(raw, DESIGN_PROFILE_SCHEMA)
    except ResearchError as error:
        _fail(str(error))
    for key in ("projectId", "jobId", "inputRevision"):
        if type(raw[key]) is not type(normalized[key]) or raw[key] != normalized[key]:
            _fail(f"{key} differs from the inspected reconstruction request")
    if raw["inputSha256"] != request_sha256(normalized):
        _fail("inputSha256 differs from the inspected reconstruction request")

    indexed = _photo_sources(photos, {item["id"] for item in normalized["evidence"]})
    sources = {}
    photo_ids = set()
    for source in raw["sources"]:
        photo = indexed.get(source["photoId"])
        if (photo is None or source["evidenceId"] != photo["evidenceId"]
                or source["sha256"] != photo["sha256"]):
            _fail("photo source identity, evidence or hash differs from staged metadata")
        if source["photoId"] in photo_ids or source["evidenceId"] in sources:
            _fail("duplicate photo source")
        photo_ids.add(source["photoId"])
        sources[source["evidenceId"]] = source

    def evidence_refs(binding):
        refs = binding["evidenceIds"]
        if len(set(refs)) != len(refs) or set(refs) - sources.keys():
            _fail("binding cites unavailable or duplicate photo evidence")

    entities = {entity["id"] for kind in ("rooms", "walls")
                for entity in normalized["geometry"][kind]}
    known_items = {item["id"] for item in normalized.get("items", [])}
    seen = set()
    for surface in raw["surfaces"]:
        if surface["entityId"] not in entities or surface["entityId"] in seen:
            _fail("unknown or duplicate floor/wall entity")
        seen.add(surface["entityId"])
        evidence_refs(surface)
        for key, lower, upper in (("roughness", .04, 1), ("repeatMeters", .02, 20),
                                  ("rotationDegrees", -360, 360)):
            if not lower <= surface[key] <= upper:
                _fail(f"{key} is outside supported range")
    seen = set()
    for item in raw["items"]:
        if item["itemId"] not in known_items or item["itemId"] in seen:
            _fail("unknown or duplicate captured item")
        seen.add(item["itemId"])
        if type(item["seatCount"]) is not int or not 1 <= item["seatCount"] <= 4:
            _fail("seatCount must be an integer between 1 and 4")
        evidence_refs(item)

    result = deepcopy(raw)
    for surface in result["surfaces"]:
        for key in ("color", "secondaryColor"):
            surface[key] = surface[key].lower()
    for item in result["items"]:
        for key in ("primaryColor", "secondaryColor", "frameColor", "accentColor"):
            item[key] = item[key].lower()
    return result


def read_design_profile(path, request, photos):
    """Read at most 2 MiB of strict JSON, then bind it to the supplied scan input."""
    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                _fail("duplicate JSON key")
            result[key] = value
        return result

    def constant(_):
        _fail("nonfinite JSON value")

    try:
        with Path(path).open("rb") as stream:
            body = stream.read(MAX_PROFILE_BYTES + 1)
        if len(body) > MAX_PROFILE_BYTES:
            _fail("JSON exceeds 2 MiB")
        raw = json.loads(body, object_pairs_hook=pairs, parse_constant=constant)
    except GeometryError:
        raise
    except (OSError, ValueError, UnicodeError, RecursionError) as error:
        raise GeometryError("design profile: cannot read strict JSON") from error
    return validate_design_profile(raw, request, photos)
