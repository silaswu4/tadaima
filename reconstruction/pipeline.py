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


def read_request(path: Path):
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise GeometryError("Request exceeds the 2 MiB limit")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_keys,
                         parse_constant=_reject_constant)
    except (json.JSONDecodeError, UnicodeError, RecursionError) as error:
        raise GeometryError(f"Invalid request JSON: {error}") from error
    return validate_request(raw)


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
             timeout: float = 120, preview: bool = False) -> dict:
    """Publish a complete fresh artifact directory, or leave no final directory.

    Caller supplies trusted output/configuration paths. Input JSON never chooses
    filenames or executable code. Existing outputs are never overwritten.
    """
    request = read_request(request_path)
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
                   "--", "--request", str(scene_json), "--output", str(staging)]
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
        if request.get("items"):
            warnings.append("Existing furniture is represented by separate sensor-size proxies, not exact textured meshes or merchant products.")
        if any(e["dimensionStatus"] == "inferred" for e in request["evidence"]):
            warnings.append("Some evidence is inferred; user confirmation does not turn it into a physical measurement.")
        manifest = {
            "schemaVersion": "1.0", "jobId": request["jobId"], "projectId": request["projectId"],
            "inputRevision": request["inputRevision"], "generatorVersion": GENERATOR_VERSION,
            "inputSha256": files["sceneJson"]["sha256"],
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
        # Another process using this job ID must not replace a successful run.
        if output.exists() or output.is_symlink():
            raise PipelineError("Output was created by another job while Blender was running")
        staging.rename(output)
        return manifest
    finally:
        if staging.exists():
            shutil.rmtree(staging)
