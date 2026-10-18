"""FastAPI wrapper around the reconstruction pipelines.

Submit a job, poll it, then download the allow-listed artifacts. Each job
writes to its own private directory under TADAIMA_DATA_DIR.
"""

from contextlib import asynccontextmanager
import hmac
import logging
import os
from pathlib import Path
import re
import shutil
import tempfile
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from reconstruction.address.pipeline import validate_discovery
from reconstruction.address.schema import validate_input
from reconstruction.capture.bundle import MAX_ZIP_BYTES, read_bundle
from reconstruction.pipeline import MAX_INPUT_BYTES, PipelineError, read_request, resolve_blender
from reconstruction.roomplan.importer import _read as read_roomplan, import_scan
from reconstruction.roomplan.photo_bundle import MAX_ZIP_BYTES as MAX_ROOMPLAN_ZIP_BYTES, read_photo_bundle
from . import handlers
from .jobs import JobRunner, JobStore
from .settings import Settings

logger = logging.getLogger("tadaima.service")

_JOB_ID = re.compile(r"[0-9a-f]{32}")
_MEDIA_TYPES = {".json": "application/json", ".glb": "model/gltf-binary",
                ".blend": "application/x-blender", ".png": "image/png"}


class AddressJob(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    project_id: str = Field(alias="projectId")
    job_id: str = Field(alias="jobId")
    input_revision: int = Field(0, alias="inputRevision")
    address: str
    unit: str | None = None
    target_room: str = Field("entire unit", alias="targetRoom")
    listing_urls: list[str] = Field(default_factory=list, alias="listingUrls")
    # A pre-researched discovery record bypasses Browser Use.
    discovery: dict[str, Any] | None = None
    collect_only: bool = Field(False, alias="collectOnly")
    render_draft: bool = Field(True, alias="renderDraft")
    preview: bool = False
    infer_appearance: bool = Field(False, alias="inferAppearance")
    rounds: int = Field(2, ge=1, le=2)


def _fail(status: int, error: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": error, "message": message})


async def _read_body(request: Request, limit: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise _fail(413, "PayloadTooLarge", f"Request body exceeds {limit // (1024 * 1024)} MiB")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise _fail(413, "PayloadTooLarge", f"Request body exceeds {limit // (1024 * 1024)} MiB")
    return bytes(body)


async def _read_upload(upload: UploadFile, limit: int, label: str) -> bytes:
    body = await upload.read(limit + 1)
    if len(body) > limit:
        raise _fail(413, "PayloadTooLarge", f"{label} exceeds {limit // (1024 * 1024)} MiB")
    return body


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    jobs_dir = settings.data_dir / "jobs"
    staging_dir = settings.data_dir / "staging"

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        for directory in (settings.data_dir, jobs_dir, staging_dir):
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        store = JobStore(settings.data_dir / "jobs.sqlite3")
        interrupted = store.fail_interrupted()
        if interrupted:
            logger.warning("marked %d interrupted job(s) as failed after restart", interrupted)
        app.state.store = store
        app.state.runner = JobRunner(store, jobs_dir, settings.workers)
        yield
        app.state.runner.shutdown()

    app = FastAPI(title="Tadaima reconstruction", version="1.0.0", lifespan=lifespan)
    if settings.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins),
                           allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type", "X-Tadaima-Upload-Key"])

    def authorize(request: Request) -> None:
        if settings.api_key is None:
            return
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(token.encode(), settings.api_key.encode()):
            raise _fail(401, "Unauthorized", "Missing or invalid bearer token")

    Auth = Depends(authorize)

    def authorize_phone(request: Request) -> None:
        """TadaimaScan uploads straight here (photo bundles exceed Vercel's 4.5 MB body limit).

        The upload key only submits RoomPlan scans and polls RoomPlan jobs; it cannot list or download.
        """
        provided = request.headers.get("x-tadaima-upload-key", "")
        if settings.upload_key and provided and hmac.compare_digest(provided.encode(), settings.upload_key.encode()):
            request.state.phone = True
            return
        request.state.phone = False
        authorize(request)

    PhoneAuth = Depends(authorize_phone)

    def _stage(files: dict[str, bytes], validate) -> Path:
        """Write inputs to a private staging directory and validate them there."""
        directory = Path(tempfile.mkdtemp(dir=staging_dir))
        try:
            for name, body in files.items():
                path = directory / name
                path.write_bytes(body)
                os.chmod(path, 0o600)
            validate(directory)
        except HTTPException:
            shutil.rmtree(directory)
            raise
        except handlers.SAFE_ERRORS as error:
            shutil.rmtree(directory)
            raise _fail(422, type(error).__name__, str(error)[:2000]) from None
        return directory

    async def stage(files: dict[str, bytes], validate) -> Path:
        # Validation can take seconds on adversarial geometry; keep the event loop responsive.
        return await run_in_threadpool(_stage, files, validate)

    def enqueue(request: Request, kind: str, params: dict, staged: Path | None, work) -> dict:
        store: JobStore = request.app.state.store
        runner: JobRunner = request.app.state.runner
        job_id = store.create(kind, params)
        job_dir = runner.job_dir(job_id)
        if staged is None:
            job_dir.mkdir(mode=0o700)
        else:
            staged.rename(job_dir)
        runner.submit(job_id, work)
        return describe(request, store.get(job_id))

    def describe(request: Request, job: dict) -> dict:
        names = handlers.available_artifacts(job["kind"], request.app.state.runner.job_dir(job["id"]))
        return {**job, "artifacts": [{"name": name, "url": f"/v1/jobs/{job['id']}/artifacts/{name}"} for name in names]}

    def require_openai(model: str) -> None:
        if not settings.openai_api_key or not model:
            raise _fail(503, "ProviderNotConfigured", "OpenAI inference needs OPENAI_API_KEY and a model on the service")

    @app.get("/healthz")
    def health() -> dict:
        return {"ok": True}

    @app.get("/v1/capabilities", dependencies=[Auth])
    def capabilities() -> dict:
        try:
            resolve_blender(settings.blender)
            blender = True
        except PipelineError:
            blender = False
        return {"blender": blender,
                "openaiGeometry": bool(settings.openai_api_key and settings.openai_model),
                "openaiVision": bool(settings.openai_api_key and settings.openai_vision_model),
                "browserUse": bool(settings.browser_use_api_key)}

    @app.post("/v1/jobs/geometry", status_code=202, dependencies=[Auth])
    async def submit_geometry(request: Request, preview: bool = False) -> dict:
        body = await _read_body(request, MAX_INPUT_BYTES)
        staged = await stage({"input.json": body}, lambda directory: read_request(directory / "input.json"))
        return enqueue(request, "geometry", {"preview": preview}, staged, handlers.geometry(settings, preview=preview))

    @app.post("/v1/jobs/roomplan", status_code=202, dependencies=[PhoneAuth])
    async def submit_roomplan(request: Request, render: bool = True, preview: bool = False) -> dict:
        body = await _read_body(request, MAX_ROOMPLAN_ZIP_BYTES)
        if body.startswith(b"PK"):
            # Photo bundle from TadaimaScan: scan JSON plus calibrated JPEGs (and optional mesh).
            files, validate = {"input.zip": body}, lambda directory: import_scan(read_photo_bundle(directory / "input.zip")["scan"])
        elif len(body) <= MAX_INPUT_BYTES:
            files, validate = {"input.json": body}, lambda directory: import_scan(read_roomplan(directory / "input.json")[0])
        else:
            raise _fail(413, "PayloadTooLarge", "RoomPlan JSON exceeds 2 MiB")
        staged = await stage(files, validate)
        photos = "input.zip" in files
        return enqueue(request, "roomplan", {"render": render, "preview": preview, "photos": photos}, staged,
                       handlers.roomplan(settings, render=render, preview=preview, photos=photos))

    @app.post("/v1/jobs/capture", status_code=202, dependencies=[Auth])
    async def submit_capture(
        request: Request,
        capture: Annotated[UploadFile, File(description="Capture ZIP from /capture")],
        proposal: Annotated[UploadFile | None, File(description="Optional hash-bound vision handoff JSON")] = None,
        infer: Annotated[bool, Form()] = False,
        infer_appearance: Annotated[bool, Form(alias="inferAppearance")] = False,
        render: Annotated[bool, Form()] = True,
        preview: Annotated[bool, Form()] = False,
    ) -> dict:
        if infer and proposal is not None:
            raise _fail(422, "InvalidRequest", "Choose either infer or a proposal file, not both")
        if infer or infer_appearance:
            require_openai(settings.openai_vision_model)
        files = {"input.zip": await _read_upload(capture, MAX_ZIP_BYTES, "Capture ZIP")}
        if proposal is not None:
            files["proposal.json"] = await _read_upload(proposal, MAX_INPUT_BYTES, "Proposal")
        staged = await stage(files, lambda directory: read_bundle(directory / "input.zip"))
        params = {"infer": infer, "inferAppearance": infer_appearance, "render": render,
                  "preview": preview, "proposal": proposal is not None}
        return enqueue(request, "capture", params, staged, handlers.capture(
            settings, infer=infer, infer_appearance=infer_appearance, render=render, preview=preview,
            has_proposal=proposal is not None))

    @app.post("/v1/jobs/address", status_code=202, dependencies=[Auth])
    async def submit_address(request: Request, job: AddressJob) -> dict:
        if job.collect_only and (job.render_draft or job.infer_appearance):
            raise _fail(422, "InvalidRequest", "collectOnly cannot be combined with renderDraft or inferAppearance")
        if job.discovery is None and not settings.browser_use_api_key:
            raise _fail(503, "ProviderNotConfigured", "Address research needs BROWSER_USE_API_KEY, or supply a discovery record")
        if not job.collect_only or job.infer_appearance:
            require_openai(settings.openai_model)
        research = {"projectId": job.project_id, "jobId": job.job_id, "inputRevision": job.input_revision,
                    "address": job.address, "unit": job.unit, "listingUrls": job.listing_urls,
                    "targetRoom": job.target_room}
        try:
            research = validate_input(research)
            if job.discovery is not None:
                validate_discovery(job.discovery)
        except handlers.SAFE_ERRORS as error:
            raise _fail(422, type(error).__name__, str(error)[:2000]) from None
        # The address itself stays out of the job table; only flags are recorded.
        params = {"collectOnly": job.collect_only, "renderDraft": job.render_draft, "preview": job.preview,
                  "inferAppearance": job.infer_appearance, "rounds": job.rounds, "discovery": job.discovery is not None}
        return enqueue(request, "address", params, None, handlers.address(
            settings, research, discovery=job.discovery, collect_only=job.collect_only, render=job.render_draft,
            preview=job.preview, infer_appearance=job.infer_appearance, rounds=job.rounds))

    def load(request: Request, job_id: str) -> dict:
        job = request.app.state.store.get(job_id) if _JOB_ID.fullmatch(job_id) else None
        if job is None:
            raise _fail(404, "NotFound", "No such job")
        return job

    @app.get("/v1/jobs", dependencies=[Auth])
    def list_jobs(request: Request, kind: str | None = None, limit: int = 20) -> dict:
        if kind is not None and kind not in handlers.ARTIFACTS:
            raise _fail(422, "InvalidRequest", "Unknown job kind")
        jobs = request.app.state.store.recent(kind, max(1, min(limit, 100)))
        return {"jobs": [describe(request, job) for job in jobs]}

    @app.get("/v1/jobs/{job_id}", dependencies=[PhoneAuth])
    def get_job(request: Request, job_id: str) -> dict:
        job = load(request, job_id)
        if request.state.phone and job["kind"] != "roomplan":
            raise _fail(404, "NotFound", "No such job")
        return describe(request, job)

    @app.get("/v1/jobs/{job_id}/artifacts/{name:path}", dependencies=[Auth])
    def get_artifact(request: Request, job_id: str, name: str) -> FileResponse:
        job = load(request, job_id)
        job_dir = request.app.state.runner.job_dir(job_id)
        if name not in handlers.available_artifacts(job["kind"], job_dir):
            raise _fail(404, "NotFound", "No such artifact for this job")
        path = job_dir / "out" / name
        return FileResponse(path, media_type=_MEDIA_TYPES.get(path.suffix, "application/octet-stream"),
                            filename=path.name)

    return app

