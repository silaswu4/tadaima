# Mobile Web Photo Reconstruction

Updated October 18, 2026: **no tape measure or numeric dimension form is required**. The `/capture` diagnostic page collects four wall photographs, lets the user review them, and exports a private photo-only capture ZIP. The worker requests a vision proposal, validates its geometry, and can generate an editable Blender scene and GLB.

The supported output is an approximate rectangular single-room shell. Room size, scale, shape and openings proposed from photographs are **inferred**, never measured or user-confirmed. This is visual layout estimation, not calibrated photogrammetry, browser LiDAR, native RoomPlan, or a guarantee that furniture fits.

## Browser flow

```bash
npm ci
npm run dev
```

Open `/capture`. Photograph walls A, B, C and D, or select existing images. Include corners, floor/ceiling and doors/windows; shift your viewpoint between shots. Review the four images and download the capture ZIP. There are no width/height inputs, door/window forms or measurement requirements.

The browser currently exports a ZIP; it does not run the vision worker or show a generated model automatically. Photos remain in the tab until exported, without cloud storage or refresh recovery. Download before closing. Camera access requires HTTPS or localhost ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)); an iPhone cannot reach your computer through its own localhost. Test on an HTTPS deployment/tunnel. The muted inline preview follows [WebKit guidance](https://webkit.org/blog/6784/new-video-policies-for-ios/).

Existing-photo selection works when camera access is unavailable or denied. Pending permission can be cancelled. Camera tracks stop on page hiding, cancellation and unmount, and interrupted streams must be reopened. Images are decoded, resized to at most 1,600 pixels on the long edge, JPEG re-encoded without copying EXIF/GPS, hashed, and given basic brightness/edge warnings. These checks do not prove sharpness, physical wall coverage or a real camera capture.

## Keyless Codex workflow

First ingest the ZIP, without provider keys or invented room dimensions:

```bash
python3 -m reconstruction.capture \
  --input /private/path/capture.zip \
  --output reconstruction/output/photo-capture-001
```

A complete capture returns `needs_reconstruction`, not `needs_measurements`. The worker saves the validated photographs, `capture.json`, `capture.dossier.json`, and `inference.request.json`. The last file supplies the vision prompt, schema, image paths/hashes and identity information for a Codex-assisted handoff.

Have Codex inspect the actual selected photo bytes and produce a `capture-geometry-handoff/1.0` JSON packet using the schema/instructions in `inference.request.json`. It binds the complete capture to project/job/revision, ZIP SHA-256 and photo SHA-256 hashes. Producer names are declarations, not authenticated identities. Blank, unrelated, nonrectangular or insufficient images should request specific replacement views rather than receive a fabricated room.

Then render the independently validated proposal, using a fresh output directory:

```bash
export BLENDER_BIN="/Applications/Blender.app/Contents/MacOS/Blender"
python3 -m reconstruction.capture \
  --input /private/path/capture.zip \
  --proposal-file /private/path/photo-proposal.json \
  --output reconstruction/output/photo-draft-001 \
  --render --preview
node reconstruction/verify-glb.mjs reconstruction/output/photo-draft-001/draft
```

Python 3.11+ is required; rendering uses [Blender 4.5 LTS](https://www.blender.org/download/lts/4-5/). Image inspection and the handoff are an explicit local verification path, not automatic inference inside the web page.

## Hosted vision inference

Reuse the existing server-only Responses API vision adapter. With a configured vision-capable model and server-side credentials:

```bash
# Supply OPENAI_API_KEY securely in the worker environment.
export OPENAI_VISION_MODEL="your-vision-capable-model"
python3 -m reconstruction.capture \
  --input /private/path/capture.zip --infer \
  --output reconstruction/output/photo-hosted-001 --render
```

`--infer` explicitly sends selected photo bytes to OpenAI. No hosted call occurs by default. `--model` overrides `OPENAI_VISION_MODEL`. `--infer` and `--proposal-file` are mutually exclusive. Up to eight distinct images are selected, prioritizing A–D; omitted references cannot be cited. Invalid structured proposals get at most one repair attempt; file handoffs do not retry a static packet. No fallback room dimensions are invented when extraction fails.

See [OpenAI image-input documentation](https://developers.openai.com/api/docs/guides/images-vision). General vision estimates are not a benchmarked metric reconstruction method. [MapAnything](https://github.com/facebookresearch/map-anything) is a separate multi-view geometry candidate, not installed or called by this implementation. Its capture/compute evaluation remains separate work.

## States and artifacts

| State | Meaning |
| --- | --- |
| `needs_capture` | Missing/duplicate wall views or the vision proposal requests more usable images; no render |
| `needs_reconstruction` | Valid photo-only capture is saved; no vision provider/handoff supplied yet |
| `needs_review` | Valid inferred room proposal; scale and dimensions remain unverified |
| `failed` | Inference or Blender generation failed; captured inputs remain available |

All results require review. `missingMeasurements` is retained for worker compatibility but is empty for the photo-only flow; lack of a tape measure is not a blocker. `captureRequests`, when present, describe missing views rather than numeric measurements. A successful proposal saves `vision.proposal.json`, `reconstruction.request.json` and optional `draft/scene.blend`, `draft/scene.glb`, `draft/manifest.json` and CPU `preview.png`. The original capture's null dimensions remain unchanged.

The legacy `guided_photos` and `manual` ZIP modes still accept explicit measurements for compatibility. They are not exposed by the current browser UI; their `needs_measurements`/`ready_for_review` states apply only to those inputs.

## Geometry, validation and integration

`contracts.ts` defines capture metadata and reuses existing reconstruction identity types. `vision.py` validates the inferred proposal and cited actual images; `geometry.py` converts it into the existing canonical `ReconstructionRequest`. Clear inside dimensions span `[0,0]` to `[W,D]`; centerlines extend by half the inferred wall thickness. A runs +X, B +Z, C −X, D −Z. Opening offsets follow each wall from its inside corner. The existing geometry validator rejects out-of-bounds/overlapping apertures and invalid meshes before Blender runs.

Every vision-derived dimension and shape assumption remains inferred; no user confirmation timestamps are fabricated. Referenced photo bytes and citations remain provenance, not proof that the model interpreted them correctly. Exact JSON schemas, finite/range checks and image/hash binding are enforced independently of provider output.

The ZIP contains exactly `capture.json` plus declared `photos/<safe-id>.jpg`: 32 MiB total, 256 KiB JSON, 16 photos, 4 MiB per image, 24 MiB combined photo bytes. Directory counts are bounded before ZipFile allocation. CRC, SHA-256, JPEG headers/dimensions, paths, compression and metadata are checked. Header screening is not full pixel decoding. Keep inputs and generated evidence private and outside Git/public assets.

Matthew owns authenticated uploads, private storage, worker isolation, job authorization and revision checks. The CLI accepts `--expected-project`, `--expected-job`, and `--expected-revision`; browser-generated IDs are not authorization. Angelina owns product-screen integration, Silas the viewer. This diagnostic page lives under `reconstruction/capture/demo/`, with thin `/capture` route wiring and namespaced CSS to work with the current root loader. No root dependency/configuration changes are introduced.

## Verification boundaries

```bash
python3 -m unittest discover -s reconstruction/tests -p 'test_*.py'
node --test reconstruction/tests/test-capture-browser.mjs
npm run lint
npm run build
```

Tests cover pending photo-only capture without measurements, actual-byte handoff binding, inferred provenance, null/invalid proposals, citation checks, camera races, ZIP interoperability and actual Blender generation when `BLENDER_BIN` is available. Synthetic fixtures establish pipeline behavior, not real-room inference accuracy.

Physical iPhone camera/Safari behavior, real-room model accuracy, hosted provider/model performance, authenticated uploads, visual model corrections and the product viewer handoff still need verification or integration. Four guided wall references are a baseline for a vision layout draft, not an evaluated photogrammetry capture specification. See the [broader capture research](../../docs/capture-and-reconstruction.md).
