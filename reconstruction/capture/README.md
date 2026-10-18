# Mobile Web Capture and Measured Reconstruction

Implemented October 18, 2026. The `/capture` diagnostic page collects four wall photographs and user dimensions, exports a private ZIP, and feeds the existing editable Blender/GLB worker. It needs no provider credentials.

The baseline is **one rectangular room, measured clear width/depth/height, and explicitly located doors/windows**. Photographs are reference evidence. This is not automated photo-to-depth, calibrated camera tracking, LiDAR, native RoomPlan, or whole-unit photogrammetry. An attractive shell does not independently verify that furniture fits.

## Try the browser flow

From the repository root:

```bash
npm ci
npm run dev
```

Open `/capture` on the development server. Choose four photographs or explicitly start the rear camera, enter dimensions in meters, confirm the room is rectangular, optionally locate openings, and download the capture ZIP. Manual dimensions mode also works without photographs.

Camera access requires a secure context: HTTPS or localhost ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)). An iPhone cannot access your computer through its own `localhost`; use an HTTPS deployment or development tunnel for device testing. The live preview uses muted, inline video ([WebKit](https://webkit.org/blog/6784/new-video-policies-for-ios/)). A permission prompt may remain unanswered, so cancellation and existing-photo selection remain available. Camera tracks stop on cancellation, page hiding, or unmount. Interrupted tracks require reopening the camera.

Images stay in the tab until exported. There is no upload, cloud persistence, or refresh recovery. Download before closing. The browser decodes and re-encodes photographs as JPEG, strips copied EXIF/GPS metadata, limits the longest edge to 1,600 pixels, and records SHA-256 and simple brightness/edge observations. Unsupported source formats produce a JPEG fallback message. These observations are warnings, not a validated blur or coverage detector.

## Process the capture

Python 3.11+ validates and compiles the ZIP without Blender:

```bash
python3 -m reconstruction.capture \
  --input /private/path/capture.zip \
  --output reconstruction/output/mobile-room-001
```

Install [Blender 4.5 LTS](https://www.blender.org/download/lts/4-5/) and add rendering:

```bash
export BLENDER_BIN="/Applications/Blender.app/Contents/MacOS/Blender"
python3 -m reconstruction.capture \
  --input /private/path/capture.zip \
  --output reconstruction/output/mobile-room-002 \
  --render --preview
node reconstruction/verify-glb.mjs reconstruction/output/mobile-room-002/draft
```

Use a fresh output directory for each invocation. Outputs contain `capture.json`, private reference `photos/`, `capture.dossier.json`, and, when sufficient, `reconstruction.request.json`. `--render` creates `draft/scene.blend`, `draft/scene.glb`, source geometry, and a manifest; `--preview` adds a CPU-rendered PNG. Doors/windows are real wall apertures with editable identity metadata, without generated leaves, frames, or glass. See the [worker artifact contract](../README.md#artifacts-and-editability).

| Status | Meaning |
| --- | --- |
| `needs_measurements` | Required room dimensions or rectangular confirmation are absent; no geometry/render |
| `needs_capture` | Guided mode lacks distinct image bytes labelled A–D; proposed geometry may be retained, but rendering is blocked |
| `needs_review` | Geometry includes estimates or the inferred 0.12 m wall-thickness default |
| `ready_for_review` | All dimensions declare tape/laser methods; still requires human review |
| `failed` | Blender generation failed; captured evidence and proposed geometry remain available |

Every result has `reviewRequired: true`. Tape/laser labels are user declarations, not independently verified readings. Four distinct hashes cannot prove four physical wall views. The page uses an estimated wall thickness and therefore normally returns `needs_review`.

## Geometry and archive contract

[`contracts.ts`](contracts.ts) defines `mobile-capture/1.0`, reusing existing reconstruction identity fields. [`geometry.py`](geometry.py) compiles into the canonical `ReconstructionRequest`; it does not introduce a competing room geometry format.

- Inputs are clear inside width W, depth D, and floor-to-ceiling height, in meters.
- The clear interior spans `[0, 0]` to `[W, D]`. With thickness t, wall centerlines follow `[-t/2, -t/2]` to `[W+t/2, D+t/2]`. This preserves the supplied usable dimensions.
- A runs +X, B +Z, C −X, D −Z around the plan. Opening offsets follow each wall's arrow from its clear inside corner; the compiler adds t/2 for the centerline contract.
- Openings must fit the wall and height, doors have zero sill, and invalid overlap/contact is rejected. The UI diagram shows declared openings; it does not extract them from photographs.
- Measured/estimated/default values retain separate evidence. Photographs never become dimensional evidence automatically.

The ZIP contains exactly `capture.json` and its declared `photos/<safe-id>.jpg` files. Limits: 32 MiB ZIP, 256 KiB JSON, 16 photographs, 4 MiB per photograph, 24 MiB total photo bytes, and 32 openings. JPEG metadata must declare dimensions between 320 and 4,096 pixels. The browser currently exports four wall views at up to 1,600 pixels.

[`bundle.py`](bundle.py) reads a bounded snapshot, rejects traversal, duplicate/extra paths, unsupported/encrypted entries, unsafe metadata and oversized expansion, then checks CRC, SHA-256, JPEG headers and dimensions. Header screening is not full pixel decoding or malware scanning. Do not publicly serve these private inputs without the production ingestion boundary.

## Integration boundaries

- `browser.ts`: camera lifecycle, photo normalization, observations, SHA-256 and ZIP export; no new dependency, secret, or network upload.
- `geometry.py`, `bundle.py`: strict input validation and measured-shell compilation.
- `pipeline.py`, `__main__.py`: local orchestration and optional existing Blender generation.
- `demo/` and thin `app/capture/page.tsx`: a scoped diagnostic interface. Angelina owns integration into the product screens; Silas owns the viewer.

Matthew's backend must assign authorized project/job/revision identifiers, authenticate uploads, store artifacts privately, isolate workers, and reject stale revisions. The local CLI accepts `--expected-project`, `--expected-job`, and `--expected-revision` for identity checks. Browser-generated demo IDs are not authorization. No production upload endpoint, resumable transfer, queue, or storage integration is included.

The demo uses namespaced plain CSS because the current root Turbopack CSS loader does not preserve CSS-module exports. Root configuration and dependencies remain unchanged.

## Verification and remaining work

```bash
python3 -m unittest discover -s reconstruction/tests -p 'test_*.py'
node --test reconstruction/tests/test-capture-browser.mjs
npm run lint
npm run build
```

Python coverage includes archive validation, exact clear dimensions, opening directions, measurement provenance, identity matching, review/recapture states and actual Blender generation when `BLENDER_BIN` is set. Browser helper tests cover ZIP interoperability and mocked camera cancellation/interruption races. Without Blender, integration tests are skipped explicitly.

A real browser file-selection flow decoded/re-encoded four synthetic photographs, rejected duplicate views and overlapping openings, and exported a ZIP. That actual export produced a 4.2 × 3.5 × 2.7 m clear-room shell with a door and window in Blender 4.5.14 LTS. The actual Three.js loader and Khronos validator accepted its GLB with zero errors or warnings. Synthetic photographs do not establish real-room reconstruction accuracy.

**Not yet verified:** the physical iPhone camera, Safari interruptions/orientation/HEIC behavior on target devices, real measured-room accuracy, authenticated uploads, and the product viewer handoff. Automatic photo-to-geometry, arbitrary room shapes, and multiroom alignment require separate implementation and evaluation. The four-reference-photo flow is not an adequate capture specification for photogrammetry; see the [research and candidate evaluation plan](../../docs/capture-and-reconstruction.md).
