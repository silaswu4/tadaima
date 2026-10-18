"""Provider schemas plus independent validation of untrusted structured output."""

from __future__ import annotations

import math
import re


class ResearchError(ValueError):
    pass


def obj(**properties):
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def arr(items, maximum=64, minimum=0):
    return {"type": "array", "items": items, "maxItems": maximum, "minItems": minimum}


def text(maximum=2000):
    return {"type": "string", "maxLength": maximum, "minLength": 1}


def enum(*values):
    return {"type": "string", "enum": list(values)}


def nullable(schema):
    return {"anyOf": [schema, {"type": "null"}]}


ID = {"type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"}
URL = text(8192)
SCOPE = enum("exact_unit", "apartment_type", "building_generic", "unknown")
KIND = enum("floor_plan", "photo", "document", "tour", "unknown")
REFS = arr(ID, 64)
NUMBER = {"type": "number"}
POINT = arr(NUMBER, 2, 2)

DISCOVERY_SCHEMA = obj(
    summary=text(4000),
    sources=arr(obj(id=ID, url=URL, title=text(500),
                    kind=enum("property_manager", "listing", "brochure", "other"),
                    scope=SCOPE, matchReason=text(2000), addressText=nullable(text(500)),
                    unitText=nullable(text(64)), findings=arr(text(), 20)), 12),
    candidates=arr(obj(id=ID, label=text(500), scope=SCOPE, sourceIds=REFS,
                       matchReason=text(2000)), 12),
    assets=arr(obj(url=URL, sourceId=ID, candidateId=nullable(ID), kind=KIND,
                   label=text(500)), 40),
    gaps=arr(text(), 20),
    conflicts=arr(text(), 20),
)

# This is the existing RoomGeometry wire shape, not a competing application type.
# Runtime geometric validation remains reconstruction.geometry.validate_request.
GEOMETRY_SCHEMA = obj(
    units=enum("m"), coordinateSystem=enum("right-handed-y-up"),
    rooms=arr(obj(id=ID, label=text(512), floorPolygon=arr(POINT, 256, 3),
                  height=NUMBER, evidenceIds=REFS), 32, 1),
    walls=arr(obj(id=ID, start=POINT, end=POINT, height=NUMBER,
                  thickness=NUMBER, evidenceIds=REFS), 512, 1),
    openings=arr(obj(id=ID, wallId=ID, kind=enum("door", "window"), offset=NUMBER,
                     width=NUMBER, height=NUMBER, sillHeight=NUMBER, evidenceIds=REFS), 256),
)

PROPOSAL_SCHEMA = obj(
    summary=text(4000), selectedCandidateId=nullable(ID),
    geometry=nullable(GEOMETRY_SCHEMA),
    claims=arr(obj(id=ID, text=text(2000), sourceIds=REFS, assetIds=REFS,
                   dimensionStatus=nullable(enum("source_dimension", "inferred"))), 256),
    bindings=arr(obj(elementId=ID, field=enum("floorPolygon", "start", "end", "height", "thickness",
                                              "offset", "width", "sillHeight"),
                     evidenceIds=REFS, method=enum("source_dimension", "inferred"),
                     explanation=text(1000)), 2048),
    missingMeasurements=arr(text(), 64), assumptions=arr(text(), 64),
    conflicts=arr(text(), 32), omittedFeatures=arr(text(), 64),
)


def validate(value, schema, path="output"):
    """Validate our bounded JSON Schema subset even when a provider ignores it."""
    if "anyOf" in schema:
        for option in schema["anyOf"]:
            try:
                validate(value, option, path)
                return value
            except ResearchError:
                pass
        raise ResearchError(f"{path}: value does not match allowed types")
    kind = schema["type"]
    valid = {"object": isinstance(value, dict), "array": isinstance(value, list),
             "string": isinstance(value, str), "null": value is None,
             "number": not isinstance(value, bool) and isinstance(value, (int, float))}
    if not valid[kind]:
        raise ResearchError(f"{path}: expected {kind}")
    if kind == "object":
        if set(value) != set(schema["properties"]):
            raise ResearchError(f"{path}: missing or unsupported fields")
        for key, spec in schema["properties"].items():
            validate(value[key], spec, f"{path}.{key}")
    elif kind == "array":
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 4096):
            raise ResearchError(f"{path}: array outside size limits")
        for i, item in enumerate(value):
            validate(item, schema["items"], f"{path}[{i}]")
    elif kind == "string":
        if not schema.get("minLength", 1) <= len(value) <= schema.get("maxLength", 8192) or not value.strip():
            raise ResearchError(f"{path}: text outside size limits")
        if "pattern" in schema and not re.fullmatch(schema["pattern"], value):
            raise ResearchError(f"{path}: invalid ID")
        if "enum" in schema and value not in schema["enum"]:
            raise ResearchError(f"{path}: unsupported value")
    elif kind == "number":
        if abs(value) > 1e12 or not math.isfinite(value):
            raise ResearchError(f"{path}: nonfinite or unbounded number")
    return value


def validate_input(raw):
    if not isinstance(raw, dict) or set(raw) - {"jobId", "projectId", "inputRevision", "address", "unit", "listingUrls", "targetRoom"}:
        raise ResearchError("request: unsupported fields")
    for key in ("jobId", "projectId", "address", "inputRevision"):
        if key not in raw:
            raise ResearchError(f"request: missing {key}")
    for key in ("jobId", "projectId"):
        validate(raw[key], ID, key)
    validate(raw["address"], text(500), "address")
    revision = raw["inputRevision"]
    if isinstance(revision, bool) or not isinstance(revision, int) or not 0 <= revision <= 2**53 - 1:
        raise ResearchError("inputRevision: expected a nonnegative safe integer")
    result = {**raw, "unit": raw.get("unit"), "listingUrls": raw.get("listingUrls", []),
              "targetRoom": raw.get("targetRoom", "entire unit")}
    validate(result["unit"], nullable(text(64)), "unit")
    validate(result["listingUrls"], arr(URL, 6), "listingUrls")
    validate(result["targetRoom"], text(500), "targetRoom")
    return result
