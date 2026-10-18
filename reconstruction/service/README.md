# Reconstruction service

FastAPI job service around the existing reconstruction pipelines: raw geometry, native RoomPlan scans, mobile capture ZIPs, and address research. Owner: project lead (`reconstruction/`). The Next.js app (Matthew's integration layer) calls this service from the server with a bearer token; browsers should not hold the token.

Jobs run in-process on a bounded worker pool. Job records live in SQLite and artifacts on disk under `TADAIMA_DATA_DIR`. One container, no queue or object store. A restart marks unfinished jobs `failed` with error `Interrupted`; resubmit them.

## Phone scan to room (demo)

```bash
reconstruction/service/demo.sh     # starts this service + Next on :3000, prints the phone settings
```

1. Install TadaimaScan on the iPhone (see `reconstruction/ios/TadaimaScan/README.md`). Optionally bake the settings in: add `TADAIMA_SERVER=http://<mac>.local:8000 TADAIMA_UPLOAD_KEY=<key>` to the `xcodebuild` command.
2. Phone and Mac on the same network. Venue Wi-Fi often isolates clients; use the phone's hotspot if the upload can't connect.
3. Scan, then tap **Send to Tadaima**. The app uploads the scan (with photos when captured) straight to this service's `POST /v1/jobs/roomplan` with `x-tadaima-upload-key`, and polls the job.
4. On the Mac, open `http://localhost:3000/rooms`. The **From your iPhone** panel lists the scan; **Enter room** saves it to the browser and opens it for shopping.

Layout-only scans (no photos) open with measured furniture stand-ins; the viewer binds only photo-textured models. The web `/api/scans` routes accept requests from this machine (by `Host` header), with `x-tadaima-upload-key`, or with the HttpOnly cookie the inbox sets after someone enters the key. On untrusted networks someone could spoof the `Host` header to list and download your scans, so use a trusted network or the hotspot.

### Deployed (Vercel + Railway)

The web app runs on Vercel; this service runs on Railway (below), because it needs Blender. Vercel limits request bodies to 4.5 MB, so the phone uploads to the Railway URL directly. Set the same key in both places:

- Railway: `TADAIMA_API_KEY`, `TADAIMA_UPLOAD_KEY`.
- Vercel: `TADAIMA_SERVICE_URL` (the Railway URL), `TADAIMA_SERVICE_TOKEN` (= `TADAIMA_API_KEY`), `TADAIMA_SCAN_UPLOAD_KEY` (= `TADAIMA_UPLOAD_KEY`).
- Phone: scan server = the Railway URL, upload key = `TADAIMA_UPLOAD_KEY`.

On the deployed `/rooms`, the inbox asks for the scan key once and remembers it in a cookie.

Keep `TADAIMA_DATA_DIR` outside the repository. Next's file watcher reloads pages whenever files under the repo change.

## Run locally

From the repository root:

```bash
uv venv reconstruction/service/.venv -p 3.12
VIRTUAL_ENV=reconstruction/service/.venv uv pip install -r reconstruction/service/requirements-dev.txt

export TADAIMA_DATA_DIR="$HOME/Library/Application Support/tadaima-reconstruction/data"   # outside the repo
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
| `TADAIMA_UPLOAD_KEY` | Optional, 24+ characters. Sent by TadaimaScan as `x-tadaima-upload-key`; it can only submit RoomPlan scans and poll RoomPlan jobs, not list jobs or download artifacts |
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
| `POST /v1/jobs/roomplan?render=true&preview=false` | TadaimaScan export: `roomplan-scan/1.0` JSON (2 MiB) or the scan + photos ZIP (144 MiB) | Imports the scan and optionally renders `draft/`. A ZIP also photo-textures the room |
| `POST /v1/jobs/capture` | multipart: `capture` ZIP (32 MiB max), optional `proposal` JSON, form `infer`, `inferAppearance`, `render` (default true), `preview` | `infer` sends photos to OpenAI. `proposal` is the keyless hash-bound handoff |
| `POST /v1/jobs/address` | JSON: `projectId`, `jobId`, `address`, optional `unit`, `targetRoom`, `listingUrls`, `inputRevision`, `discovery`, `collectOnly`, `renderDraft` (default true), `preview`, `inferAppearance`, `rounds` | Needs Browser Use unless `discovery` is supplied, and OpenAI unless `collectOnly` |
| `GET /v1/jobs?kind=roomplan&limit=20` | | Most recent jobs first; used by the `/rooms` phone inbox |
| `GET /v1/jobs/{id}` | | Status `queued` → `running` → `succeeded`/`failed`, plus a result receipt and `artifacts` |
| `GET /v1/jobs/{id}/artifacts/{name}` | | Downloads one allow-listed file |

Submissions are validated before queueing. Invalid geometry, open RoomPlan loops, and malformed ZIPs return `422` with `{"detail": {"error", "message"}}`. Oversized bodies return `413`. Provider modes without configured keys return `503`, before any work is queued. Submissions return `202` with the job record.

`succeeded` means the pipeline finished. It does not mean the room is usable: read `result.status` (for example `needs_review`, `needs_capture`) and `result.warnings`. Capture and address results always carry `reviewRequired: true`, and photo-only scale stays labeled unverified.

Only these files are downloadable: `manifest.json`, `scene.glb`, `scene.blend`, `preview.png`, `scene.json` for geometry jobs, and the RoomPlan/capture dossier, `reconstruction.request.json`, inference/proposal JSON, and `draft/*` (including `draft/scene.json`, which the web importer pairs with `draft/scene.glb`) for the input jobs. Uploaded photos, raw scans, the address dossier, fetched pages, and the SQLite database are never served. Address strings are not stored in the job table.

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

- No cancellation or retries.
- No per-user authorization: anyone with the token can read any job. The Next server must map users to job IDs.
- Artifacts are never garbage collected.
