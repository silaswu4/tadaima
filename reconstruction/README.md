# Reconstruction · Project lead

Owner: **you, the project lead**. Implemented stages: address research → private source/image bundle → vision-based geometry proposal → validated metric room geometry → editable Blender scene → standalone GLB and a revision-bound manifest. Hosted address providers need credentials; a [keyless Codex file handoff](address/README.md#keyless-codex-verification) can exercise the same validation/rendering path using inspected real evidence. A [mobile web capture stage](capture/README.md) now supports photo-only capture without tape measurements, a hash-bound Codex or hosted vision proposal, and a reviewable estimated rectangular shell. This estimates layout and scale rather than performing calibrated multi-view reconstruction; hosted uploads and application integration remain separate work. An optional [native RoomPlan companion](../docs/native-scan.md) and [sensor-scan importer](roomplan/README.md) add a LiDAR input for supported iPhones without tape measurements. Read [address pipeline setup and limitations](address/README.md) and [technical research and primary sources](RESEARCH.md).

## Requirements and quick start

- Python **3.11+**, standard library only.
- **Blender 4.5 LTS**, with its bundled glTF exporter. Tested with official **4.5.14 LTS** on macOS arm64; other versions need compatibility checks. The worker rejects Blender below 4.5.
- Existing root Node/Three.js dependencies (`npm ci`) for GLB verification. The optional Node adapter smoke harness uses Node 22.18+ native TypeScript support.

Download Blender from [the official site](https://www.blender.org/download/lts/4-5/). Put `blender` on PATH, set `BLENDER_BIN`, or pass `--blender`. A standard macOS installation uses:

```bash
export BLENDER_BIN="/Applications/Blender.app/Contents/MacOS/Blender"
```

Run from the repository root:

```bash
python3 -m reconstruction.cli validate \
  --input reconstruction/fixtures/living-room.request.json

python3 -m reconstruction.cli build \
  --input reconstruction/fixtures/living-room.request.json \
  --output reconstruction/output/demo-001 \
  --timeout 120 --preview
```

Validation works without Blender. `--preview` optionally renders a CPU Cycles PNG; omit it for the core export. Output directories must be fresh. Use a new job ID/directory for another revision or retry. The CLI prints one JSON result to stdout; errors go to stderr with nonzero exit status. No `bpy` pip package, GPU, runtime texture downloads, or new website dependency is required. Include the committed CC0 appearance assets under `public/materials/room/` when packaging the worker.

## Geometry contract

The [fixture](fixtures/living-room.request.json) is a **synthetic** 4.2 × 3.5 meter centerline room, 2.7 meters high, with 0.12-meter walls, a door, and a window. It is not a captured home or a physical measurement.

Inputs match [`ReconstructionRequest`](contracts.ts) and the existing [`RoomGeometry`/`Evidence` types](../backend/contracts.ts). Required top-level fields are `jobId`, `projectId`, `inputRevision`, `geometry`, and `evidence`. IDs use ASCII letters/digits/underscores/hyphens, starting with a letter or digit, at most 64 characters. Unsupported fields are rejected rather than silently dropped.

- Canonical geometry is right-handed, **Y-up meters**, with floor points `[x,z]`.
- Wall segments and room polygons follow **wall centerlines**. Thickness extends half to either side. Net usable interior dimensions must account for that thickness: approximately 4.08 × 3.38 meters for this fixture. Upstream producers must convert measured clear dimensions deliberately.
- Floors extend 0.08 meters below Y=0. All rooms share this elevation; no ceiling is generated.
- Opening offsets run from wall `start` toward `end`; `sillHeight` is above floor level. Doors require a zero sill.
- Application `[x,y,z]` becomes Blender `[x,-z,y]`; `export_yup=True` restores the original viewer axes. Do not rotate or rescale the resulting GLB again.
- Simple equal-profile corners use conservative miter caps. Ambiguous junctions, endpoint openings, mismatched profiles, sharp angles, and unsafe short segments use butt caps. This is a viewing shell, not a general CAD/BIM junction solver.
- Evidence remains provenance. Validation does not certify physical measurement accuracy or user approval; those are upstream responsibilities.

Validation covers finite numbers, safe IDs, evidence references, simple nondegenerate floor polygons, nonoverlapping room interiors, complete wall boundaries, duplicate wall coverage, opening bounds/overlap, and non-manifold aperture contacts. Concave/reversed/collinear polygons, rotated walls, multiple nonoverlapping rooms, and shared walls are supported. Shared walls appear once. Unsupported interior partitions and extra geometry fields are rejected explicitly.

Limits: 2 MiB JSON; 32 rooms; 512 walls; 256 openings, at most 32 per wall; 256 floor vertices per room/2,048 total; 2,048 evidence records; coordinates within ±10,000 meters; height/opening fields up to 1,000 meters and wall thickness up to 10 meters. These bound work, not accuracy.

## Artifacts and editability

| File | Purpose |
| --- | --- |
| `scene.json` | Normalized validated input, including private evidence |
| `scene.blend` | Separate editable floors/walls/opening metadata, packed PBR images/HDRI, and Cycles preview rig |
| `scene.glb` | Self-contained runtime shell with embedded PBR textures and no cameras, lights, animation, or Draco dependency |
| `manifest.json` | Project/job/revision, versions, IDs, file sizes/SHA-256 hashes, canonical bounds, statistics, and limitations |
| `worker.log` | Private generation diagnostics |
| `preview.png` | Optional CPU render |

Openings are actual gaps in wall geometry. Blender empties preserve door/window identity and dimensions; visible leaves, glass, frames, and swing behavior are not generated. A fully opened wall stays a semantic empty. Changing metadata does not parametrically rebuild the mesh: edit the mesh manually, or update the source JSON and regenerate. Files need not be byte-identical across Blender versions; the geometry construction and normalized source are deterministic for a given input/version.

Blender scene custom properties store `inputRevision` as text because Blender's integer properties are 32-bit. The source JSON and manifest retain the numeric safe-integer revision; consumers should use the manifest for application state.

Generation runs in a private staging directory, published only after save/export, required-file checks, and hashing succeed. Failure/timeout removes staging and does not publish a partial result. Existing results are not intentionally overwritten. The trusted Blender process uses factory startup, disabled automatic scripts, and a Python exception exit code. These flags are not an OS sandbox; production deployment still needs resource/process isolation.

`inputSha256` hashes normalized `scene.json`, not raw request bytes. IDs such as `project:job:glb` are **local handles** for the backend to map/upload; they are not existing cloud asset IDs. Keep outputs outside Git and `public/` unless explicitly approved for public sharing.

## Matthew: backend handoff

[`processor.server.ts`](processor.server.ts) implements `ReconstructionProcessor` with a Node subprocess and no shell interpolation. Import only on the server:

```ts
import { LocalReconstructionProcessor } from "@/reconstruction/processor.server";

const processor = new LocalReconstructionProcessor({
  projectRoot: process.cwd(),
  outputRoot: "/private/worker/artifacts",
  blenderPath: process.env.BLENDER_BIN,
  timeoutSeconds: 120,
});
const manifest = await processor.generate(request);
const privateDirectory = processor.getOutputDirectory(request);
// Upload manifest.files entries from privateDirectory through the backend storage adapter.
```

Paths must be absolute. Results are scoped to `outputRoot/projectId/jobId`. The adapter rejects unsafe path-like IDs and checks returned project/job/revision. It does not implement authentication, a queue, storage upload, deployment, or stale-plan policy. Compare `inputRevision` with current plan state before accepting results. The host must support Blender/native subprocesses; do not assume an edge function does.

## Silas: viewer handoff

Use the existing Three.js `GLTFLoader` at scale 1, Y up. Node metadata is `userData.entityId`, `userData.role` (`room_floor`, `wall`, `opening`), and `userData.evidenceIdsJson` (JSON-encoded array). Readable mesh names are not stable identity. The viewer owns its camera and lighting. Bounds include thickness/floor skirt, not net interior dimensions. Keep furniture and reference scans separate. Export extras contain IDs, not source URLs or evidence claims; full evidence stays in private JSON.

## Verification

```bash
python3 -m unittest discover -s reconstruction/tests -p 'test_*.py' -v
node reconstruction/verify-glb.mjs reconstruction/output/demo-001
node reconstruction/tests/test-processor.mjs
```

Without Blender, Python integration cases are explicitly skipped, not passed. With `BLENDER_BIN`, they generate artifacts, reopen `.blend`, check identity/manifold meshes/volume/holes, and use the actual Three.js loader. The Node adapter smoke test also requires Blender.

Optional full format validation, installed separately from website dependencies:

```bash
npm install --prefix /tmp/tadaima-gltf-validation --no-save --package-lock=false gltf-validator@2.0.0-dev.3.10
node reconstruction/verify-glb.mjs reconstruction/output/demo-001 \
  --validator-module /tmp/tadaima-gltf-validation/node_modules/gltf-validator/index.js
```

The verifier checks hashes, actual Three.js loading, finite positions, metadata, world bounds/axes, opening transforms, and clear wall apertures. The optional validator additionally requires zero Khronos errors and warnings.

### Recorded result, October 17, 2026

- **55 Python tests passed**, including three real Blender integration cases, on Blender 4.5.14 LTS/macOS arm64.
- Node adapter: actual Blender invocation, matching manifest, safe IDs, and duplicate-output rejection passed.
- Final synthetic fixture: **11,808-byte GLB**, five meshes, seven semantic entities, 144 triangles, two materials, no external resources.
- Khronos Validator `2.0.0-dev.3.10`: **zero errors, warnings, infos, or hints**.
- Actual installed Three.js loader: matching bounds, meter scale, IDs, and both apertures. Blender CPU preview visually inspected.
- Root `npm run lint` and `npm run build` passed during integration.

The [address research](address/README.md) and [mobile photo capture](capture/README.md) stages now feed this worker. Calibrated multi-view reconstruction, physical accuracy, hosted jobs/storage, product viewer integration, and Quest/mobile hardware tests remain unverified or separate work. Angelina owns capture/confirmation UI, Matthew backend integration, and Silas the viewer. See [team ownership](../docs/team-ownership.md).

## PBR materials and preview lighting

Generator `tadaima-shell/1.1.0` adds `renderProfile: "pbr-daylight-v1"` to the manifest and saved scene. [`shading.py`](shading.py) uses portable Principled materials: real oak base color/roughness/OpenGL normal maps at a 1.2 m repeat, plus subtle plaster normals at a 1 m repeat. Every face receives metric UVs without changing the supplied geometry, apertures, or dimensions. These are styling defaults, not measured or inferred finishes of the captured home.

The saved Blender scene uses a packed 1k studio HDR environment, warm area/daylight sources, Cycles indirect bounces, adaptive sampling, denoising, and AgX highlight handling. The camera fits all projected room bounds. Camera-facing walls are hidden from the **preview render** for a cutaway; their mesh data remains editable and is explicitly included in the GLB. To render from a different interior camera, restore render visibility on walls marked `previewCutaway`. The presentation ground and lighting rig are excluded from the exported room.

Images are decoded, converted to PNG, packed into the `.blend`, and embedded into the GLB. The files remain portable after transfer; no texture URLs or the original checkout are needed to view them. Blender node graphs and Cycles lighting are not exported as a browser shader or baked illumination. The web viewer supplies its own HDR reflections, lights and shadows, while retaining the exported PBR maps. Baked room shadows would be inappropriate for editable furniture and explode mode.

The synthetic fixture still has five meshes / 144 triangles; embedded images increase its GLB from approximately 12 KB to **6.04 MB**. The interactive demo uses the original 1k JPEG maps separately, totaling **4.20 MB including the HDRI**. Asset authors, original URLs, physical tile sizes, CC0 license, and checksums are recorded in [`public/materials/room/sources.json`](../public/materials/room/sources.json). These new shared assets are consumed only by reconstruction shading and the spatial room workspace; no shared contract, dependency, or root configuration changes are required.

The Node verifier now decodes embedded 8-bit RGB/RGBA PNG pixels and checks PBR bindings/UVs. Its bounded decoder rejects unsupported PNG encodings explicitly. This verifies image data and loader compatibility, not GPU appearance. Reopened-Blender checks additionally verify packed assets, path-tracing setup, camera framing, and unchanged topology/apertures. Run the decoder regression checks with `node --test reconstruction/tests/test-png-decoder.mjs`.
