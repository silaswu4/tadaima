"""Local worker orchestration; no shell interpolation or third-party Python deps."""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from reconstruction import GENERATOR_VERSION
from reconstruction.geometry import GeometryError, validate_request

MAX_INPUT_BYTES = 2 * 1024 * 1024


class PipelineError(RuntimeError):
    """A worker/configuration failure, distinct from invalid input geometry."""


def _unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise GeometryError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value):
    raise GeometryError(f"Non-finite JSON number: {value}")


def _request_source(path: Path):
    with path.open("rb") as stream:
        body = stream.read(MAX_INPUT_BYTES + 1)
    if len(body) > MAX_INPUT_BYTES:
        raise GeometryError("Request exceeds the 2 MiB limit")
    try:
        raw = json.loads(body.decode("utf-8"), object_pairs_hook=_unique_keys,
                         parse_constant=_reject_constant)
    except (json.JSONDecodeError, UnicodeError, RecursionError) as error:
        raise GeometryError(f"Invalid request JSON: {error}") from error
    return validate_request(raw), body


def read_request(path: Path):
    return _request_source(path)[0]


def resolve_blender(explicit: str | None = None) -> str:
    candidate = explicit or os.environ.get("BLENDER_BIN") or shutil.which("blender")
    if not candidate:
        mac = Path("/Applications/Blender.app/Contents/MacOS/Blender")
        candidate = str(mac) if mac.is_file() else None
    if not candidate:
        raise PipelineError("Blender not found. Install Blender 4.5 LTS+ or set BLENDER_BIN / --blender.")
    resolved = shutil.which(candidate)
    if not resolved or not Path(resolved).is_file():
        raise PipelineError(f"Blender executable not found: {candidate}")
    return str(Path(resolved).resolve())


def _sha256(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def generate(request_path: Path, output_path: Path, *, blender: str | None = None,
             timeout: float = 120, preview: bool = False,
             photo_bundle: Path | None = None,
             design_profile: Path | None = None) -> dict:
    """Publish a complete fresh artifact directory, or leave no final directory.

    Caller supplies trusted output/configuration paths. Input JSON never chooses
    filenames or executable code. Existing outputs are never overwritten.
    """
    request, request_bytes = _request_source(request_path)
    source_request_sha256 = hashlib.sha256(request_bytes).hexdigest()
    if design_profile is not None and photo_bundle is None:
        raise GeometryError("A visual design profile requires its original matching photo bundle")
    if isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0:
        raise PipelineError("Timeout must be a positive finite number of seconds")
    binary = resolve_blender(blender)
    # Do not resolve away the final symlink before checking it.
    output = output_path.absolute()
    if output.exists() or output.is_symlink():
        raise PipelineError(f"Output already exists; choose a fresh job directory: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".tadaima-shell-", dir=output.parent))
    try:
        scene_json = staging / "scene.json"
        scene_json.write_text(json.dumps(request, sort_keys=True, indent=2, ensure_ascii=False,
                                         allow_nan=False) + "\n", encoding="utf-8")
        command = [binary, "--background", "--factory-startup", "--disable-autoexec",
                   "--python-exit-code", "1", "--python", str(Path(__file__).with_name("blender_worker.py")),
                   "--", "--request", str(scene_json), "--output", str(staging),
                   "--source-request-sha256", source_request_sha256]
        photo_sources = staging / "photo-sources"
        if photo_bundle is not None:
            # A private sidecar, not a second room schema or an arbitrary image
            # URL. Revalidate source bytes and bind poses to this exact geometry.
            from reconstruction.roomplan.texture_source import prepare_texture_source
            source = prepare_texture_source(Path(photo_bundle), request, photo_sources)
            command.extend(["--photo-source", str(source)])
            if design_profile is not None:
                from reconstruction.design_profile import read_design_profile
                source_metadata = json.loads(source.read_text())
                design = read_design_profile(design_profile, request, source_metadata["photos"])
                if {item["itemId"] for item in design["items"]} != {item["id"] for item in request.get("items", [])}:
                    raise GeometryError("Structured room rendering requires a visual binding for every captured item")
                profile_path = staging / "visual-design.input.json"
                profile_path.write_text(json.dumps(design, sort_keys=True, indent=2, allow_nan=False) + "\n")
                command.extend(["--design-profile", str(profile_path)])
        if preview:
            command.append("--preview")
        log_path = staging / "worker.log"
        try:
            with log_path.open("w", encoding="utf-8") as log:
                process = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=log,
                                         stderr=subprocess.STDOUT, timeout=timeout, check=False)
        except subprocess.TimeoutExpired as error:
            raise PipelineError(f"Blender exceeded {timeout:g}s; no artifact directory was published") from error
        if process.returncode:
            tail = log_path.read_text(errors="replace")[-8000:]
            raise PipelineError(f"Blender failed (exit {process.returncode}):\n{tail}")
        metadata = json.loads((staging / "worker-result.json").read_text())
        if photo_bundle is not None:
            if not isinstance(metadata.get("photoTexturing", metadata.get("surfaceReconstruction", metadata.get("visualDesign"))), dict):
                raise PipelineError("Photo texturing was requested but the worker produced no coverage report")
            # The original archive stays with its caller. All render textures
            # must already be packed into both portable artifacts.
            shutil.rmtree(photo_sources)
        artifacts = {}
        files = {}
        for key, filename, media_type in (
            ("sceneJson", "scene.json", "application/json"),
            ("blend", "scene.blend", "application/x-blender"),
            ("glb", "scene.glb", "model/gltf-binary"),
        ):
            path = staging / filename
            if not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
                raise PipelineError(f"Blender did not produce {filename}")
            asset_id = f"{request['projectId']}:{request['jobId']}:{key}"
            artifacts[key + "AssetId"] = asset_id
            files[key] = {"assetId": asset_id, "fileName": filename, "mediaType": media_type,
                          "byteLength": path.stat().st_size, "sha256": _sha256(path)}
        warnings = [
            "Geometry is supplied input, not a measured photo/scan reconstruction.",
            "Wall segments and floor boundaries are centerlines; usable clearance must account for wall thickness.",
            ("Openings are real apertures with metadata markers; door leaves, glass, frames, ceilings"
             + (", and furniture" if not request.get("items") else "") + " are not generated."),
        ]
        if request.get("items") and not metadata.get("surfaceReconstruction"):
            warnings.append("Existing furniture is represented by separate sensor-size proxies, not exact textured meshes or merchant products.")
        if photo_bundle is not None:
            report_key = ("visualDesign" if metadata.get("visualDesign") else
                          "surfaceReconstruction" if metadata.get("surfaceReconstruction") else "photoTexturing")
            report = staging / {"visualDesign": "visual-design.json", "surfaceReconstruction": "surface-reconstruction.json",
                                "photoTexturing": "photo-texturing.json"}[report_key]
            if not report.is_file() or report.is_symlink():
                raise PipelineError("Photo texturing coverage report is missing")
            files[report_key] = {
                "assetId": f"{request['projectId']}:{request['jobId']}:{report_key}",
                "fileName": report.name, "mediaType": "application/json",
                "byteLength": report.stat().st_size, "sha256": _sha256(report),
            }
            warnings.extend(metadata[report_key].get("warnings", []))
            if report_key == "surfaceReconstruction":
                warnings = ["The visible model preserves observed LiDAR surfaces; RoomPlan planning proxies remain separate in the Blender file."] + metadata[report_key].get("warnings", [])
            elif report_key == "visualDesign":
                warnings = list(metadata[report_key].get("warnings", []))
                profile_path = staging / "visual-design.input.json"
                files["visualDesignInput"] = {
                    "assetId": f"{request['projectId']}:{request['jobId']}:visualDesignInput",
                    "fileName": profile_path.name, "mediaType": "application/json",
                    "byteLength": profile_path.stat().st_size, "sha256": _sha256(profile_path),
                }
        if any(e["dimensionStatus"] == "inferred" for e in request["evidence"]):
            warnings.append("Some evidence is inferred; user confirmation does not turn it into a physical measurement.")
        manifest = {
            "schemaVersion": "1.0", "jobId": request["jobId"], "projectId": request["projectId"],
            "inputRevision": request["inputRevision"], "generatorVersion": GENERATOR_VERSION,
            "inputSha256": files["sceneJson"]["sha256"],
            "sourceRequestSha256": source_request_sha256,
            "units": "m", "coordinateSystem": "right-handed-y-up",
            "wallAlignment": "centerline", "floorThicknessMeters": 0.08,
            "artifacts": artifacts, "files": files, "warnings": warnings, **metadata,
        }
        if preview:
            path = staging / "preview.png"
            if not path.is_file():
                raise PipelineError("Preview was requested but not produced")
            manifest["preview"] = {"fileName": "preview.png", "mediaType": "image/png",
                                   "byteLength": path.stat().st_size, "sha256": _sha256(path)}
        (staging / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2,
                                                         allow_nan=False) + "\n")
        (staging / "worker-result.json").unlink()
        for path in staging.rglob("*"):
            if not path.is_symlink():
                path.chmod(0o700 if path.is_dir() else 0o600)
        # Another process using this job ID must not replace a successful run.
        if output.exists() or output.is_symlink():
            raise PipelineError("Output was created by another job while Blender was running")
        staging.rename(output)
        return manifest
    finally:
        if staging.exists():
            shutil.rmtree(staging)
