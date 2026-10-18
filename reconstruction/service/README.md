# Reconstruction service

FastAPI job service around the existing reconstruction pipelines: raw geometry, native RoomPlan scans, mobile capture ZIPs, and address research. Owner: project lead (`reconstruction/`). The Next.js app (Matthew's integration layer) calls this service from the server with a bearer token; browsers should not hold the token.

Jobs run in-process on a bounded worker pool. Job records live in SQLite and artifacts on disk under `TADAIMA_DATA_DIR`. One container, no queue or object store. A restart marks unfinished jobs `failed` with error `Interrupted`; resubmit them.

## Run locally

From the repository root:

```bash
uv venv reconstruction/service/.venv -p 3.12
VIRTUAL_ENV=reconstruction/service/.venv uv pip install -r reconstruction/service/requirements-dev.txt

export TADAIMA_DATA_DIR="$PWD/reconstruction/output/service"   # gitignored; never under public/
export TADAIMA_API_KEY="$(openssl rand -hex 24)"
export BLENDER_BIN="/Applications/Blender.app/Contents/MacOS/Blender"
reconstruction/service/.venv/bin/python -m reconstruction.service   # http://localhost:8000/docs
```

`TADAIMA_ALLOW_NO_AUTH=1` disables auth for local development. Without it, the service refuses to start unless it has a 24+ character `TADAIMA_API_KEY`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `TADAIMA_DATA_DIR` | Required. Private directory for `jobs.sqlite3`, `jobs/<id>/`, and `staging/` |
| `TADAIMA_API_KEY` | Bearer token for every `/v1` route |
| `TADAIMA_WORKERS` | Concurrent jobs, default `1`. Blender is CPU and memory heavy |
| `TADAIMA_CORS_ORIGINS` | Comma-separated origins. Leave unset when only the Next server calls the service |
| `BLENDER_BIN` | Blender 4.5 LTS+. Set in the Docker image |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Address geometry and appearance inference |
| `OPENAI_VISION_MODEL` | Capture photo inference. Falls back to `OPENAI_MODEL` |
| `BROWSER_USE_API_KEY`, `BROWSER_USE_MODEL` | Address research without a supplied discovery record |
| `PORT`, `HOST`, `LOG_LEVEL` | Server binding and logging |

## API

Interactive schema: `GET /docs`. Every `/v1` route needs `Authorization: Bearer $TADAIMA_API_KEY`.

| Route | Body | Notes |
| --- | --- | --- |
| `GET /healthz` | | Unauthenticated liveness |
| `GET /v1/capabilities` | | Whether Blender and each provider are configured, so the UI can hide unavailable modes |
| `POST /v1/jobs/geometry?preview=false` | `ReconstructionRequest` JSON, 2 MiB max | Blend, GLB, and manifest |
| `POST /v1/jobs/roomplan?render=true&preview=false` | `roomplan-scan/1.0` JSON from TadaimaScan | Imports the scan, optionally renders `draft/` |
| `POST /v1/jobs/capture` | multipart: `capture` ZIP (32 MiB max), optional `proposal` JSON, form `infer`, `inferAppearance`, `render` (default true), `preview` | `infer` sends photos to OpenAI. `proposal` is the keyless hash-bound handoff |
| `POST /v1/jobs/address` | JSON: `projectId`, `jobId`, `address`, optional `unit`, `targetRoom`, `listingUrls`, `inputRevision`, `discovery`, `collectOnly`, `renderDraft` (default true), `preview`, `inferAppearance`, `rounds` | Needs Browser Use unless `discovery` is supplied, and OpenAI unless `collectOnly` |
| `GET /v1/jobs/{id}` | | Status `queued` → `running` → `succeeded`/`failed`, plus a result receipt and `artifacts` |
| `GET /v1/jobs/{id}/artifacts/{name}` | | Downloads one allow-listed file |

Submissions are validated before queueing. Invalid geometry, open RoomPlan loops, and malformed ZIPs return `422` with `{"detail": {"error", "message"}}`. Oversized bodies return `413`. Provider modes without configured keys return `503`, before any work is queued. Submissions return `202` with the job record.

`succeeded` means the pipeline finished. It does not mean the room is usable: read `result.status` (for example `needs_review`, `needs_capture`) and `result.warnings`. Capture and address results always carry `reviewRequired: true`, and photo-only scale stays labeled unverified.

Only these files are downloadable: `manifest.json`, `scene.glb`, `scene.blend`, `preview.png`, `scene.json` for geometry jobs, and the dossier, `reconstruction.request.json`, inference/proposal JSON, and `draft/*` for the input jobs. Uploaded photos, raw scans, fetched pages, and the SQLite database are never served. Address strings are not stored in the job table.

```bash
curl -s -H "Authorization: Bearer $TADAIMA_API_KEY" -H 'content-type: application/json' \
  --data-binary @reconstruction/fixtures/living-room.request.json localhost:8000/v1/jobs/geometry
curl -s -H "Authorization: Bearer $TADAIMA_API_KEY" localhost:8000/v1/jobs/<id>
curl -s -H "Authorization: Bearer $TADAIMA_API_KEY" -o scene.glb localhost:8000/v1/jobs/<id>/artifacts/scene.glb
```

## Docker and Railway

```bash
docker build --platform linux/amd64 -f reconstruction/service/Dockerfile -t tadaima-reconstruction .
docker run -p 8000:8000 -e TADAIMA_API_KEY=... -v tadaima-data:/data tadaima-reconstruction
```

The image downloads official Blender 4.5.14 LTS for linux-x64 and verifies its SHA-256. It runs as a non-root user with data at `/data`. `Dockerfile.dockerignore` limits the build context to `reconstruction/` and `public/materials/room/`, which Blender shading needs.

On Railway, create a service from this repository and set its config-as-code path to `reconstruction/service/railway.json`. Then:

- Attach a volume at `/data`.
- Set `RAILWAY_RUN_UID=0`. Railway mounts volumes as root, so the non-root user can't write to it otherwise.
- Set `TADAIMA_API_KEY` and any provider keys.

Keep one replica: jobs and SQLite are local to the container.

## Tests

```bash
python -m unittest discover -s reconstruction/tests -p 'test_service.py' -v
```

These need `requirements-dev.txt`. Without it the module is skipped explicitly. With `BLENDER_BIN` set, two extra cases render real GLBs through the API.

## Known limits

- No cancellation, retries, or job listing.
- No per-user authorization: anyone with the token can read any job. The Next server must map users to job IDs.
- Artifacts are never garbage collected.
- RoomPlan imports inherit the importer's strict wall-join tolerance: nearly-collinear split walls from real scans can be rejected as a partial loop.
