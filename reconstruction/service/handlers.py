"""Job bodies: each one calls an existing pipeline with service-owned paths.

Inputs are saved under <job>/input.* before queueing; every pipeline writes a
fresh <job>/out directory. Clients never choose filesystem paths.
"""

from collections.abc import Callable
import logging
from pathlib import Path

from reconstruction.address.providers import BrowserUseResearchProvider, OpenAIGeometryProvider, ProviderError
from reconstruction.address.schema import ResearchError
from reconstruction.capture.bundle import BundleError
from reconstruction.capture.geometry import CaptureError
from reconstruction.geometry import GeometryError
from reconstruction.pipeline import PipelineError
from reconstruction.roomplan import RoomPlanError
from .jobs import JobFailure
from .settings import Settings

logger = logging.getLogger("tadaima.service")

# Errors whose messages describe the input, not private paths or provider bodies.
SAFE_ERRORS = (GeometryError, RoomPlanError, BundleError, CaptureError, ResearchError, ProviderError)

# Downloadable files per job kind, relative to <job>/out. Anything else stays private.
_DRAFT = ("draft/manifest.json", "draft/scene.glb", "draft/scene.blend", "draft/preview.png")
ARTIFACTS = {
    "geometry": ("manifest.json", "scene.glb", "scene.blend", "preview.png", "scene.json"),
    "roomplan": ("roomplan.dossier.json", "reconstruction.request.json", *_DRAFT),
    "capture": ("capture.dossier.json", "inference.request.json", "vision.proposal.json",
                "reconstruction.request.json", *_DRAFT),
    "address": ("dossier.json", "reconstruction.request.json", *_DRAFT),
}


def available_artifacts(kind: str, job_dir: Path) -> list[str]:
    output = job_dir / "out"
    return [name for name in ARTIFACTS[kind]
            if (output / name).is_file() and not (output / name).is_symlink()]


def _guard(work: Callable[[Path], dict]) -> Callable[[Path], dict]:
    def run(job_dir: Path) -> dict:
        try:
            return work(job_dir)
        except SAFE_ERRORS as error:
            raise JobFailure(str(error)[:2000]) from error
        except PipelineError as error:
            # Blender log tails can contain private absolute paths.
            logger.error("Blender stage failed in %s: %s", job_dir.name, error)
            raise JobFailure("Blender generation failed; see service logs.") from error
    return run


def _pick(result: dict, *keys: str) -> dict:
    return {key: result.get(key) for key in keys}


def geometry(settings: Settings, *, preview: bool) -> Callable[[Path], dict]:
    from reconstruction.pipeline import generate

    @_guard
    def work(job_dir: Path) -> dict:
        manifest = generate(job_dir / "input.json", job_dir / "out", blender=settings.blender, preview=preview)
        return {"status": "rendered", "manifest": manifest}
    return work


def roomplan(settings: Settings, *, render: bool, preview: bool) -> Callable[[Path], dict]:
    from reconstruction.roomplan import run

    @_guard
    def work(job_dir: Path) -> dict:
        dossier = run(job_dir / "input.json", job_dir / "out", render=render, preview=preview,
                      blender=settings.blender)
        return _pick(dossier, "status", "reviewRequired", "projectId", "jobId", "inputRevision", "warnings", "corrections")
    return work


def _openai(settings: Settings, model: str) -> OpenAIGeometryProvider:
    return OpenAIGeometryProvider(settings.openai_api_key, model)


def capture(settings: Settings, *, infer: bool, infer_appearance: bool, render: bool, preview: bool,
            has_proposal: bool) -> Callable[[Path], dict]:
    from reconstruction.capture.pipeline import run

    @_guard
    def work(job_dir: Path) -> dict:
        provider = _openai(settings, settings.openai_vision_model) if infer or infer_appearance else None
        dossier = run(job_dir / "input.zip", job_dir / "out", render=render, preview=preview, blender=settings.blender,
                      geometry_provider=provider if infer else None,
                      proposal_file=job_dir / "proposal.json" if has_proposal else None,
                      appearance_provider=provider if infer_appearance else None)
        return _pick(dossier, "status", "reviewRequired", "projectId", "jobId", "inputRevision", "method",
                     "photoUsage", "photoCount", "missingMeasurements", "warnings", "captureRequests", "appearanceStatus")
    return work


def address(settings: Settings, request: dict, *, discovery: dict | None, collect_only: bool, render: bool,
            preview: bool, infer_appearance: bool, rounds: int) -> Callable[[Path], dict]:
    from reconstruction.address.pipeline import run

    @_guard
    def work(job_dir: Path) -> dict:
        research = None if discovery is not None else BrowserUseResearchProvider(
            settings.browser_use_api_key, model=settings.browser_use_model)
        geometry_provider = None if collect_only else _openai(settings, settings.openai_model)
        dossier = run(request, job_dir / "out", research_provider=research, geometry_provider=geometry_provider,
                      discovery=discovery, collect_only=collect_only, research_rounds=rounds,
                      render_draft=render, blender=settings.blender, preview=preview,
                      appearance_provider=_openai(settings, settings.openai_model) if infer_appearance else None)
        # The dossier holds the full address and fetched page text; return a compact receipt only.
        return {"status": dossier["status"], "reviewRequired": True,
                "projectId": request["projectId"], "jobId": request["jobId"], "inputRevision": request["inputRevision"],
                "sourceCount": len(dossier["sources"]),
                "downloadedAssetCount": sum(asset["status"] == "downloaded" for asset in dossier["assets"]),
                "execution": dossier["execution"], "warnings": dossier.get("warnings", [])}
    return work
