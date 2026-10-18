# Address Research and Reconstruction

This worker implements **address + optional unit/listing URLs → Browser Use research → downloaded spatial evidence → OpenAI vision geometry proposal → local geometric validation → optional editable Blender and GLB draft**. It reuses the existing `RoomGeometry`, `Evidence`, and reconstruction worker. No new app, client provider keys, public upload directory, or generated AI Python execution is introduced.

This is an implemented local/server worker, not a connected onboarding screen or deployed job service. Provider protocol and full orchestration are tested with synthetic responses. Live provider access/model performance require configured credentials; offline tests do not establish that an arbitrary apartment can be reconstructed accurately.

## Run

Use Python 3.11+ from the repository root. Research and extraction use only the standard library. For rendering, follow the [Blender setup](../README.md).

Set these in the worker's environment using your normal secret manager or local uncommitted environment configuration:

| Variable | Required | Purpose |
| --- | --- | --- |
| `BROWSER_USE_API_KEY` | Yes for automated discovery | Browser Use Cloud V4 research agent |
| `OPENAI_API_KEY` | Yes for geometry extraction | OpenAI Responses API |
| `OPENAI_MODEL` | Yes for geometry extraction | Explicit account-available model supporting images, PDFs, and Structured Outputs; no silent model fallback |
| `BROWSER_USE_MODEL` | Optional | Explicit Browser Use model; otherwise provider default |
| `BLENDER_BIN` | Only for `--render-draft` | Blender 4.5 LTS executable |

The standalone Python CLI does **not** automatically load Next.js `.env.local`. A Node worker inherits its configured server environment. Never prefix these with `NEXT_PUBLIC_` or put them in requests, frontend code, logs, source control, or browser storage.

```bash
python3 -m reconstruction.address \
  --address '100 Example Street, Los Angeles, CA 90024' \
  --unit 201 \
  --project-id project-example --job-id address-research-001 \
  --output reconstruction/output/address-research-001 \
  --render-draft
```

This command uses a deliberately fictional address. Use a fresh output directory/job for each run. Research defaults to the **entire unit**; use `--target-room 'living room'` to narrow it. Add repeated `--listing-url` arguments to seed known public listings. Add `--preview` for a CPU Blender render. A valid inferred draft can render with `--render-draft`, but remains unconfirmed and keeps `reviewRequired: true`.

For backend identity/revision control, use `--input /private/request.json`:

```json
{
  "projectId": "project-example",
  "jobId": "address-research-001",
  "inputRevision": 0,
  "address": "100 Example Street, Los Angeles, CA 90024",
  "unit": "201",
  "listingUrls": [],
  "targetRoom": "entire unit"
}
```

The CLI returns one compact JSON receipt, rather than dumping address/source text into stdout. Schema/input/provider failures return nonzero and a sanitized error on stderr. Once a job starts, `dossier.json` is updated after acquisition and on failure, preserving private research for diagnosis. An existing directory is never overwritten. A failed job is not a reusable output directory.

## Stages and evidence boundaries

1. **Discover.** Browser Use investigates exact address/unit, official property-manager floor-plan and gallery pages, relevant rental/sale listings, brochures, and public tour references. It returns bounded structured sources, separate layout candidates, media URLs, missing evidence, and conflicts. Website content and user strings are reference data, not executable instructions. Research is limited to property spatial evidence; occupant/owner identity is outside the task.
2. **Acquire.** The worker downloads actual public HTML and media, extracts additional image/PDF/tour links from HTML and JSON-LD, and records final URLs, source pages, byte counts, and SHA-256 hashes. Agent-reported `findings`, `scope`, and `matchReason` are assertions for review, distinct from successfully fetched text/pixels. A download proves the bytes were retrieved, not that a listing's claims are true or its pictures show the requested unit.
3. **Fill gaps.** At most two research rounds. If a unit was requested, a generic building floor plan does not end the search for an exact-unit match. First-round acquisition reserves source/candidate/asset slots and 8 MiB of the media byte budget for the next round. The agent receives previous findings/gaps; this is a bounded follow-up, not an indefinite crawler. A later explicit association may refine an unassigned asset from the same source, retaining its original attribution; conflicting named candidate associations cannot support accepted geometry.
4. **Inspect.** OpenAI receives actual downloaded image/PDF bytes, stable asset IDs, selected source excerpts, and candidate metadata. The model selects one candidate and produces shell geometry, evidence claims, per-numeric-field bindings, assumptions, missing measurements, conflicts, and omitted features. Only explicitly classified floor-plan assets can support a room polygon. A brochure is not automatically a floor plan.
5. **Validate.** Independent local checks reject missing/unseen citations, mixed candidate sources/assets, duplicate IDs, unsupported fields, missing field bindings, and attempts to upgrade inferred evidence to source dimensions. The existing validator checks polygons, wall coverage, room overlap, opening bounds, finite units/values, and evidence references. One extraction repair call receives the validation error. Two invalid proposals fail without rendering.
6. **Publish a draft.** A valid proposal produces `reconstruction.request.json`. `--render-draft` passes this data to the trusted existing worker, producing separate editable shell entities in `draft/scene.blend`, a self-contained `draft/scene.glb`, source JSON, and a hashed manifest. Address-derived claims and manifest warnings explicitly label the result unconfirmed. The full dossier remains authoritative for evidence applicability/review status.

Source applicability values:

| Value | Meaning |
| --- | --- |
| `exact_unit` | Source explicitly claims the target unit; still requires checking whether each picture/plan is specific to it |
| `apartment_type` | Named plan or unit type without a verified assignment to the requested unit |
| `building_generic` | Shared building, staged apartment, amenity, or general residence photo |
| `unknown` | Match not established or inconsistent |

An exact-unit declaration with inconsistent/missing `unitText` is downgraded. Layouts remain separate candidates; square-footage agreement alone does not identify a unit's plan. Gallery extraction does not assign every building image to a named unit. No automatic evidence gets `confirmedByUserAt` or the `measured` dimension status. `source_dimension` means a model extracted a stated dimension; geometric checks cannot independently certify that it read the pixels correctly.

## Result files and statuses

| File | Contents |
| --- | --- |
| `discovery-1.json`, optionally `discovery-2.json` | Original locally validated research result for each round |
| `pages/srcNNN.html` | Downloaded source bytes, hashed in dossier |
| `assets/assetNNN.*` | Downloaded supported media; identical hashes share stored bytes |
| `dossier.json` | Request, timestamps, source applicability, fetch successes/failures, candidates, assets, claims, field bindings, conflicts, review status |
| `proposal-1.json`, optionally `proposal-2.json` | Raw model proposals; invalid attempts remain diagnostic data |
| `reconstruction.request.json` | Validated canonical reconstruction input, present only with usable geometry |
| `draft/` | Optional Blender/GLB artifacts; never proof of real-world dimensional accuracy |

Successful receipts have one of these statuses; every receipt has `reviewRequired: true`:

- `evidence_collected`: acquisition-only mode; no geometry extraction was attempted. Check individual fetch statuses—this is not a promise that media was found.
- `needs_evidence`: no usable downloaded plan, or the model declined to propose supported geometry.
- `needs_review`: valid proposal with inferred dimensions, unresolved unit mapping, missing measurements, or conflicts.
- `draft_ready`: structurally valid proposal whose bindings declare source dimensions and candidate declares exact-unit applicability. This still means a reviewable draft, not verified ground truth.

The on-disk dossier additionally uses transient `researching` and terminal `failed`. No filesystem receipt is an authenticated public download URL. The backend must apply project authorization and upload/map artifacts to private storage, keeping the input revision tied to the accepted room plan.

## Acquisition-only and reproducible testing

To inspect a research result without OpenAI extraction:

```bash
python3 -m reconstruction.address --input /private/request.json \
  --collect-only --output reconstruction/output/collected-001
```

To exercise acquisition from an explicitly pre-researched or recorded discovery object, use `--discovery-file /private/discovery.json`. Its shape is `DISCOVERY_SCHEMA` in [schema.py](schema.py). This bypasses Browser Use entirely and must not be described as a live agent run. It can be combined with `--collect-only` without provider credentials, or with OpenAI extraction. The output retains the discovery and downloaded evidence. Production Browser Use is the default when this flag is absent.

```bash
python3 -m unittest discover -s reconstruction/tests -p 'test_*.py' -v
node reconstruction/tests/test-address-processor.mjs
```

Set `BLENDER_BIN` to include real Blender integration tests, including the synthetic address orchestration through editable Blender/GLB generation. New address tests cover provider protocols, actual byte payload construction, downloader defenses, provenance/candidate gates, bounded repair, failure preservation, and the synthetic end-to-end orchestration. They use synthetic media and mocked providers; they do not evaluate architectural reconstruction accuracy. The Node 22.18+ adapter test uses an explicitly synthetic Python process to check private input, argv handling, and receipt identity validation.

## Backend handoff

Use the server-only `LocalAddressResearchProcessor` from [processor.server.ts](processor.server.ts) in Matthew's background worker. It takes absolute repository/private output roots, supplies IDs/revision, and invokes this CLI without shell interpolation. `renderDraft` enables optional generation. [contracts.ts](contracts.ts) reuses existing reconstruction identity types. Its receipt includes the private dossier path and relative request/manifest paths; read the dossier and upload artifacts through authorized backend storage. The adapter has a 40-minute process ceiling and is unsuitable for a short synchronous frontend request. Production job persistence, cancellation reconciliation, concurrency/CPU isolation, authenticated progress/events, and a user review UI belong to backend/frontend integration, not this module.

## Limits and practical accuracy

- At most 12 source pages, 12 candidates, 40 acquired/reference asset records across two rounds; 2 MiB per source page, 8 MiB per media file, 32 MiB aggregate media budget. Failed media attempts consume bounded slots. Extracted links are retained for research follow-up, not recursively crawled without limit.
- Vision gets at most eight distinct images and two PDFs, preferring plan candidates before photos and exact-unit plans before generic plans across research rounds. Obvious interface/tracking images and documents without spatial relevance are inventoried without using vision slots. Text is bounded to 8,000 characters per source; the full extracted text remains in the private dossier. Additional evidence remains inventoried but is marked `sentToVision: false` and cannot be cited by accepted geometry claims.
- Browser Use defaults to a $2 provider cap **per research round**, at most two rounds, with 240-second deadlines. OpenAI has a 16,000 output-token limit and up to two extraction calls. These are not a hard total dollar cap: image/PDF input tokens, remote browser lifetime, and provider billing rules still apply. No paid create/extraction POST is automatically retried after a transport error.
- Local downloads validate public HTTP(S) URLs, all DNS answers and every redirect, then pin the socket to checked public IPs while verifying TLS against the original hostname. No local networks, credentials, environment proxies, cookies, SVG, or scripts are accepted. MIME/header checks use actual bytes for supported PNG/JPEG/WebP/GIF/PDF; they are not a complete codec/PDF sanitizer. Browser Use's remote navigation has its own provider security boundary.
- Missing scale, mirrored layouts, staged galleries, stale listings, renovations, absent opening dimensions, or occluded rooms prevent claims of an accurate as-built model. Total area alone does not identify room dimensions. Photo-only metric reconstruction, calibrated camera pose, native LiDAR/RoomPlan, textured meshes, detailed appliances/cabinets, furniture generation, and interactive user corrections are not implemented by this address worker.
- Private output contains an address, room images, and source evidence. Keep it outside `public/` and Git. Apply appropriate retention/deletion and authorized artifact serving in the backend. No live address is committed as a test fixture.

## Research basis

The intended Homebuddy-style interaction is practical because public listing/manager sites can contain floor plans and photos; their applicability is the difficult part. The implementation follows [Browser Use V4 structured output](https://docs.browser-use.com/cloud/agent/structured-output), its [current OpenAPI schema](https://docs.browser-use.com/cloud/openapi/v4.json), OpenAI [vision inputs](https://developers.openai.com/api/docs/guides/images-vision), [PDF/file inputs](https://developers.openai.com/api/docs/guides/file-inputs), and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). See [provider protocol details](PROVIDERS.md). The existing [Blender research](../RESEARCH.md) explains metric geometry, openings, semantic object IDs, and GLB export.
