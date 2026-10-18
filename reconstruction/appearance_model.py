"""Portable, bounded photo-appearance data; no image or network execution."""
from copy import deepcopy
import re

from reconstruction.address.schema import ID, arr, enum, obj, text, validate, ResearchError

SURFACE_SCHEMA = obj(
    entityId=ID, finish=enum("wood", "paint", "tile", "carpet"),
    color={"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"},
    roughness={"type": "number"}, tileMeters={"type": "number"},
    rotationDegrees={"type": "number"}, confidence=enum("low", "medium", "high"),
    evidenceIds=arr(ID, 8, 1),
)
PROPOSAL_SCHEMA = obj(surfaces=arr(SURFACE_SCHEMA, 544), notes=arr(text(2000), 64))
SCOPES = {"captured_room", "exact_unit", "building_reference", "unknown"}


def validate_appearance(raw, geometry, evidence):
    from reconstruction.geometry import GeometryError
    def fail(message):
        raise GeometryError("appearance: " + message)
    if not isinstance(raw, dict) or set(raw) != {"schemaVersion", "reviewRequired", "scope", "sources", "surfaces", "notes"}:
        fail("missing or unsupported fields")
    if raw["schemaVersion"] != "room-appearance/1.0" or raw["reviewRequired"] is not True:
        fail("expected reviewable room-appearance/1.0")
    if not isinstance(raw["scope"], str) or raw["scope"] not in SCOPES:
        fail("unsupported photo scope")
    try:
        validate({key: raw[key] for key in ("surfaces", "notes")}, PROPOSAL_SCHEMA)
        validate(raw["sources"], arr(obj(evidenceId=ID, sha256=text(64)), 8))
    except ResearchError as error:
        fail(str(error))
    sources = {}
    known_evidence = {item["id"] for item in evidence}
    for source in raw["sources"]:
        if source["evidenceId"] in sources or source["evidenceId"] not in known_evidence:
            fail("duplicate or unknown photo evidence")
        if not re.fullmatch(r"[a-f0-9]{64}", source["sha256"]):
            fail("photo source requires a SHA-256 digest")
        sources[source["evidenceId"]] = source["sha256"]
    entities = {item["id"] for key in ("rooms", "walls") for item in geometry[key]}
    seen = set()
    used = set()
    for surface in raw["surfaces"]:
        if surface["entityId"] not in entities or surface["entityId"] in seen:
            fail("unknown or duplicate floor/wall binding")
        seen.add(surface["entityId"])
        refs = surface["evidenceIds"]
        if len(set(refs)) != len(refs) or set(refs) - sources.keys():
            fail("surface references unavailable photo evidence")
        used.update(refs)
        for field, lower, upper in (("roughness", .04, 1), ("tileMeters", .1, 10), ("rotationDegrees", -360, 360)):
            if not lower <= surface[field] <= upper:
                fail(f"{field} is outside supported range")
    if set(sources) != used:
        fail("sources must match the photos cited by surfaces")
    result = deepcopy(raw)
    for surface in result["surfaces"]:
        surface["color"] = surface["color"].lower()
    return result
