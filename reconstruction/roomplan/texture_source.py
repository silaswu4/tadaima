"""Bind a validated native RGB archive to the exact canonical render request.

This boundary stages only validated JPEG bytes and data-only camera metadata.
It does not change geometry, infer correspondence, or certify ARKit registration.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from reconstruction.geometry import validate_request
from .importer import RoomPlanError, _evidence_id, import_scan
from .photo_bundle import read_photo_bundle


def _photo_evidence(request, photo):
    # Match the native importer exactly: photo IDs alone do not bind image bytes.
    return {"id": _evidence_id(request["jobId"] + ":rgb:" + photo["id"]),
        "sourceUrl": None, "privateAssetId": request["jobId"] + ":" + photo["path"],
        "observedAt": photo["capturedAt"],
        "claim": "Captured-room RGB appearance evidence; photo SHA-256 " + photo["sha256"]
            + ". Camera pose is source ARKit tracking, not verified texture alignment or furniture identity.",
        "dimensionStatus": None, "confirmedByUserAt": None}


def _write_private(path, body):
    with open(path, "xb", opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        stream.write(body)


def prepare_texture_source(bundle_path: Path, request: dict, output: Path) -> Path:
    """Stage a fresh private source directory after validating all bindings.

    Appearance estimates may change between renders. Geometry and existing items
    must still equal the original native import; otherwise the camera registration
    belongs to a different scene and this boundary declines automatic projection.
    Source poses remain unmodified; apply sourceToCanonicalTranslation once.
    """
    canonical = validate_request(request)
    bundle = read_photo_bundle(bundle_path)
    compiled = import_scan(bundle["scan"])
    original = compiled["request"]
    for key in ("projectId", "jobId", "inputRevision", "geometry"):
        if canonical[key] != original[key]:
            raise RoomPlanError("Photo texturing source does not match canonical " + key)
    if (("items" in canonical) != ("items" in original)
            or canonical.get("items") != original.get("items")):
        raise RoomPlanError("Photo texturing source does not match captured items")
    evidence = {item["id"]: item for item in canonical["evidence"]}
    photos = []
    for photo in bundle["manifest"]["photos"]:
        expected = _photo_evidence(canonical, photo)
        if evidence.get(expected["id"]) != expected:
            raise RoomPlanError("Photo texturing requires original SHA-bound captured-photo evidence")
        photos.append({**photo, "evidenceId": expected["id"]})
    scene_bytes = (json.dumps(canonical, sort_keys=True, indent=2, ensure_ascii=False,
                             allow_nan=False) + "\n").encode("utf-8")
    source = {"schemaVersion": "roomplan-texture-source/1.0",
        **{key: canonical[key] for key in ("projectId", "jobId", "inputRevision")},
        "inputSha256": hashlib.sha256(scene_bytes).hexdigest(),
        "sourceArchiveSha256": bundle["sha256"],
        "sourceToCanonicalTranslation": compiled["coordinatePolicy"]["sourceToCanonicalTranslation"],
        "photos": photos}
    output = Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise RoomPlanError("Photo texture source output must be a fresh private directory")
    output.mkdir(mode=0o700)
    (output / "photos").mkdir(mode=0o700)
    for photo in photos:
        _write_private(output / "photos" / (photo["id"] + ".jpg"), bundle["files"][photo["path"]])
    source_path = output / "photo-input.json"
    _write_private(source_path, (json.dumps(source, sort_keys=True, indent=2,
                                          ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8"))
    return source_path
