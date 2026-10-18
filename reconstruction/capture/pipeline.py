"""Private capture bundle -> measured rectangular shell -> existing Blender worker."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path

from reconstruction.pipeline import generate
from .bundle import BundleError, read_bundle
from .geometry import compile_capture


def _write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    os.chmod(path, 0o600)


def run(bundle_path, output_path, *, render=False, blender=None, preview=False,
        expected_project=None, expected_job=None, expected_revision=None):
    bundle = read_bundle(bundle_path)
    manifest = bundle["manifest"]
    for field, expected in (("projectId", expected_project), ("jobId", expected_job), ("inputRevision", expected_revision)):
        if expected is not None and manifest[field] != expected:
            raise BundleError(f"Capture {field} does not match the authorized job")
    compiled = compile_capture(manifest)
    output = Path(output_path).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir(mode=0o700)
    (output / "photos").mkdir(mode=0o700)
    dossier = {"schemaVersion": "capture-result/1.0", "projectId": manifest["projectId"],
               "jobId": manifest["jobId"], "inputRevision": manifest["inputRevision"],
               "processedAt": datetime.now(timezone.utc).isoformat(),
               "status": compiled["status"], "reviewRequired": True,
               "method": "user_dimensions_rectangular_shell", "photoUsage": "reference_only",
               "bundleSha256": bundle["sha256"],
               "missingMeasurements": compiled["missingMeasurements"],
               "warnings": list(dict.fromkeys(compiled["warnings"] + bundle["warnings"] + [
                   "Photos are reference evidence; this version does not estimate camera poses, depth, or automatic wall/opening geometry.",
                   "Dimensions are user declarations, not readings from browser LiDAR or AR tracking."])),
               "photoCount": len(manifest["photos"]), "captureManifestPath": "capture.json",
               "reconstructionRequestPath": None, "draftManifestPath": None}
    for filename, body in bundle["files"].items():
        path = output / filename  # read_bundle accepts only photos/<safe-id>.jpg.
        path.write_bytes(body)
        os.chmod(path, 0o600)
    _write(output / "capture.json", manifest)
    if manifest["captureMode"] == "guided_photos" and compiled["request"] is not None:
        seen = {}
        covered = set()
        for photo in manifest["photos"]:
            if photo["sha256"] not in seen:
                covered.add(photo["wall"])
            seen[photo["sha256"]] = photo["wall"]
        if set("abcd") - covered:
            dossier["status"] = "needs_capture"
            dossier["warnings"].append("Add distinct reference photos for walls A, B, C and D, or explicitly choose manual dimensions mode.")
    if compiled["request"] is not None:
        _write(output / "reconstruction.request.json", compiled["request"])
        dossier["reconstructionRequestPath"] = "reconstruction.request.json"
    _write(output / "capture.dossier.json", dossier)
    try:
        if render and compiled["request"] is not None and dossier["status"] != "needs_capture":
            rendered = generate(output / "reconstruction.request.json", output / "draft", blender=blender, preview=preview)
            rendered["warnings"].append("Mobile measured-room draft. Photos are reference-only; review capture.dossier.json before relying on fit.")
            _write(output / "draft/manifest.json", rendered)
            dossier["draftManifestPath"] = "draft/manifest.json"
        _write(output / "capture.dossier.json", dossier)
        return dossier
    except Exception:
        dossier["status"] = "failed"
        dossier["warnings"].append("Scene generation failed. Captured evidence and proposed geometry remain available.")
        _write(output / "capture.dossier.json", dossier)
        raise
