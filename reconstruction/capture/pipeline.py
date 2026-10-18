"""Private photo capture -> vision proposal or explicit geometry -> Blender."""

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


def _has_four_views(manifest):
    choices = [{photo["sha256"] for photo in manifest["photos"] if photo["wall"] == wall}
               for wall in "abcd"]

    def assign(index, used):
        if index == 4:
            return True
        return any(assign(index + 1, used | {digest}) for digest in choices[index] - used)

    # Four labels must have four distinct images. Optional overviews and earlier
    # duplicates must not displace a valid alternative view for another wall.
    return assign(0, set())


def run(bundle_path, output_path, *, render=False, blender=None, preview=False,
        expected_project=None, expected_job=None, expected_revision=None,
        geometry_provider=None, proposal_file=None):
    if geometry_provider is not None and proposal_file is not None:
        raise BundleError("Choose either a vision provider or a proposal file")
    bundle = read_bundle(bundle_path)
    manifest = bundle["manifest"]
    for field, expected in (("projectId", expected_project), ("jobId", expected_job), ("inputRevision", expected_revision)):
        if expected is not None and manifest[field] != expected:
            raise BundleError(f"Capture {field} does not match the authorized job")
    photo_mode = manifest["captureMode"] == "photo_inference"
    if not photo_mode and (geometry_provider is not None or proposal_file is not None):
        raise BundleError("Vision inference requires a photo_inference capture")
    compiled = ({"status": "needs_reconstruction", "missingMeasurements": [], "request": None,
                 "warnings": ["No measurements required. A vision proposal is pending; no room dimensions have been invented."]}
                if photo_mode else compile_capture(manifest))
    output = Path(output_path).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir(mode=0o700)
    (output / "photos").mkdir(mode=0o700)
    dossier = {"schemaVersion": "capture-result/1.0", "projectId": manifest["projectId"],
               "jobId": manifest["jobId"], "inputRevision": manifest["inputRevision"],
               "processedAt": datetime.now(timezone.utc).isoformat(),
               "status": compiled["status"], "reviewRequired": True,
               "method": "vision_estimated_rectangular_shell" if photo_mode else "user_dimensions_rectangular_shell",
               "photoUsage": "pending_vision" if photo_mode else "reference_only",
               "bundleSha256": bundle["sha256"],
               "missingMeasurements": compiled["missingMeasurements"],
               "warnings": list(dict.fromkeys(compiled["warnings"] + bundle["warnings"] + (
                   ["Photo-only scale is unverified. This is a visual draft, not a calibrated metric scan."] if photo_mode else [
                   "Photos are reference evidence; this mode uses explicitly supplied dimensions.",
                   "Dimensions are user declarations, not readings from browser LiDAR or AR tracking."]))),
               "photoCount": len(manifest["photos"]), "captureManifestPath": "capture.json",
               "inferenceRequestPath": None, "proposalPath": None,
               "reconstructionRequestPath": None, "draftManifestPath": None}
    for filename, body in bundle["files"].items():
        path = output / filename  # read_bundle accepts only photos/<safe-id>.jpg.
        path.write_bytes(body)
        os.chmod(path, 0o600)
    _write(output / "capture.json", manifest)
    needs_views = (manifest["captureMode"] in ("photo_inference", "guided_photos")
                   and (photo_mode or compiled["request"] is not None) and not _has_four_views(manifest))
    if needs_views:
        dossier["status"] = "needs_capture"
        dossier["warnings"].append("Add distinct reference photos for walls A, B, C and D before reconstruction.")
    _write(output / "capture.dossier.json", dossier)
    try:
        if photo_mode:
            from .vision import FilePhotoGeometryProvider, infer_capture, write_inference_request
            write_inference_request(bundle, output / "inference.request.json")
            os.chmod(output / "inference.request.json", 0o600)
            dossier["inferenceRequestPath"] = "inference.request.json"
            if not needs_views and (geometry_provider is not None or proposal_file is not None):
                provider = (FilePhotoGeometryProvider(proposal_file, bundle)
                            if proposal_file is not None else geometry_provider)
                compiled = infer_capture(bundle, provider)
                dossier.update({key: compiled[key] for key in ("status", "photoUsage", "method", "missingMeasurements")})
                dossier["warnings"] = list(dict.fromkeys(bundle["warnings"] + compiled["warnings"]))
                if "captureRequests" in compiled:
                    dossier["captureRequests"] = compiled["captureRequests"]
                if "citations" in compiled:
                    dossier["citations"] = compiled["citations"]
                _write(output / "vision.proposal.json", compiled["proposal"])
                dossier["proposalPath"] = "vision.proposal.json"
        if compiled["request"] is not None:
            _write(output / "reconstruction.request.json", compiled["request"])
            dossier["reconstructionRequestPath"] = "reconstruction.request.json"
        _write(output / "capture.dossier.json", dossier)
        if render and compiled["request"] is not None and dossier["status"] != "needs_capture":
            rendered = generate(output / "reconstruction.request.json", output / "draft", blender=blender, preview=preview)
            rendered["warnings"].append(
                "Photo-only vision draft: scale and dimensions are unverified; review capture.dossier.json before relying on fit."
                if photo_mode else "Mobile measured-room draft. Photos are reference-only; review capture.dossier.json before relying on fit.")
            _write(output / "draft/manifest.json", rendered)
            dossier["draftManifestPath"] = "draft/manifest.json"
        _write(output / "capture.dossier.json", dossier)
        return dossier
    except Exception:
        dossier["status"] = "failed"
        dossier["warnings"].append("Reconstruction failed. Captured evidence and any validated geometry remain available.")
        _write(output / "capture.dossier.json", dossier)
        raise
