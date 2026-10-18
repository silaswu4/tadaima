# Repository state and implementation plan

Repository originally inspected October 17, 2026 at base commit `cbbe48fe69b1b12afa4b1fb9c245bce6b83e84c4`; this inventory was updated October 18 for the local reconstruction inputs and approved optional native scanner. Historical scaffold details remain identified below. This document separates observed code from proposed work. See [team ownership](team-ownership.md) before editing.

## What exists

| Path | Observed responsibility |
| --- | --- |
| `app/page.tsx` | Thin Next.js entry point for `frontend/HomePage.tsx` |
| `frontend/HomePage.tsx` | Latest hero composition, tadaima headline, placeholder `#` sign-in and scan links |
| `app/layout.tsx` | Local Paper Mono font and tadaima page metadata |
| `frontend/styles/globals.css` | Light surface/ink tokens, grain overlay, some unused-looking warm accent tokens; no cleanup requested |
| `spatial/components/AsciiHero.tsx` | Current homepage renderer configuration and playback/visibility state |
| `spatial/components/AsciiField.tsx` | Incoming WebGL2 live ASCII renderer |
| `spatial/components/RoomHero.tsx` | Earlier pencil-room client component, lazy scene import, selection labels, coarse-pointer mode; retained but not mounted on homepage |
| `spatial/room/scene.ts` | Hardcoded room shell and furniture, GLB loading, pencil contours/edges, fixed camera, raycast hover/touch selection, render loop/disposal |
| `spatial/room/parts.ts` | Procedural meter-based objects and materials; local parts use floor origin and front `+Z` |
| `backend/contracts.ts` | Type-only starting subset of room/evidence/product contracts; no runtime service or validators |
| `reconstruction/contracts.ts` | Geometry-to-artifacts request/result and revision-bound manifest types |
| `reconstruction/processor.server.ts` | Local Node adapter invoking the actual Python/Blender pipeline |
| `reconstruction/geometry.py`, `joins.py` | Bounded runtime validation, concave triangulation, opening cuts, conservative corner joins |
| `reconstruction/pipeline.py`, `cli.py`, `blender_worker.py` | Private staging, trusted headless Blender, editable `.blend`, GLB, hashes/manifest, and optional preview |
| `reconstruction/address/` | Local bounded public evidence acquisition, research/vision provider adapters, data-only proposal handoffs, provenance validation, and draft generation |
| `app/capture/page.tsx`, `reconstruction/capture/` | Browser capture demo, bounded photo ZIP processing, photo-only inferred proposals without tape measurements, and optional explicit-dimension mode |
| `reconstruction/ios/TadaimaScan/TadaimaScan.xcodeproj`, `reconstruction/roomplan/` | Native scan/preview/export app compiles for iOS and Simulator; Swift-emitted synthetic scan imports through Blender/GLB. [Verification](native-scan.md) excludes physical iPhone capture and accuracy |
| `reconstruction/tests/`, `verify-glb.mjs` | Geometry/failure tests, actual Blender reopen, Three.js loading, and optional Khronos validation |
| `public/models/` | Seven bundled GLB models, referenced by the hero |
| `app/fonts/` | Paper Mono WOFF2 and SIL Open Font License text |
| `HANDOFF.md` | Historical design notes from the Michael working name; opening notice records the later native-input exception |
| `AGENTS.md` | Next.js version-specific guidance plus the team's four working boundaries |
| `README.md` | Mostly create-next-app starter text; the docs entry link points here |

The earlier Three.js room hero creates nine object entries: rug, sofa, coffee table, lounge chair, cabinet, shelves, side table, vase, and floor lamp. The scene has a fixed camera and a hardcoded room approximately 6 by 6.2 meters, with 2.7-meter wall height. These values describe a demonstration scene, not a reconstruction of the user's home. The newer homepage uses the separate ASCII renderer instead.

The ASCII configuration references `/art/japan.mp4`, third-party test footage deliberately excluded in the incoming `.gitignore`. It is not available in a fresh clone. The scaffold preserves that incoming work and its exclusion; licensed replacement media is required before claiming the background ships with the repository.

The label dimensions are calculated from scene object bounding boxes after transforms. They are not merchant specifications or independently verified physical measurements. Rotated world-space bounds can differ from intrinsic product width/depth. Treat this code as a useful interaction/rendering starting point, not a finished fit engine.

Commit `07d83cb` attributes the bundled furniture models to CC0 Poly Haven assets in its message. Before redistribution beyond the current assets, preserve or verify the individual source records and license provenance; there is not yet a full per-asset provenance manifest in the app.

## What does not exist

No hosted upload/job service, canonical runtime room-plan service, backend persistence/authentication, product catalog, real retailer shopping agent, cart preparation/checkout, WebXR session, shared-device state, voice agent, Fetch agent, wallet, or Solana contract is connected yet. Local address and browser-photo pipelines now exist; live paid-provider execution and physical iPhone scanning are separate verification gates, not implied by passing fixture tests. The optional RoomPlan companion/importer is being added; its current evidence belongs in [native scanning](native-scan.md). Reconstruction has Python and standalone Node checks; shared TypeScript types alone do not implement the remaining application services.

## Dependencies and local setup

Observed package versions:

- Next.js `16.4.2`.
- React and React DOM `19.3.0`.
- Three.js `^0.186.1`.
- TypeScript `^5`, ESLint `^9`, Tailwind CSS `^4`.
- A tracked `package-lock.json` is present. The package is named `tadaima`.

From the repository root:

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`. Available verification/production commands are:

```bash
npm run lint
npm run build
npm run start
```

`start` runs a production build after one has been produced; it is not a substitute for `build`.

The final four-folder scaffold, including the incoming ASCII update, passed `npm run lint` and `npm run build`. A production browser smoke check verified the dark homepage layout, copy, and controls; the excluded background test clip is absent, so footage playback was not verified. A source comparison confirmed that the incoming page/renderers were preserved except for import paths. The initial move also loaded the earlier nine-object 3D hero before the ASCII update arrived. Documentation links and JSON examples passed checks. These results do not establish any unimplemented shopping, reconstruction, mobile hardware, or Quest capability. Installation reported five high-severity npm audit findings in the existing dependency tree; dependency versions and the lockfile were not changed in this scaffold.

Before application changes, follow `AGENTS.md` and read the relevant installed Next.js guides under `node_modules/next/dist/docs/`. Do not assume older framework conventions apply to this version.

Reconstruction accepts `BLENDER_BIN` or an explicit executable option, plus trusted private output paths and timeouts documented in [its README](../reconstruction/README.md). Address and photo inference have documented provider configuration and keyless data-only handoff paths; see their folder READMEs. Provider adapters existing in source does not prove configured credentials or successful paid execution. Never commit real credentials or private captures.

## Recommended implementation order

### 1. Establish the canonical room slice

Build one synthetic/measured room fixture using the [proposed data contract](data-model.md), plus stable IDs and a validated loader. Refactor only enough of the current scene to render that data. Retain the visual direction while replacing hardcoded shopping assumptions.

Done when: the same plan produces the same metric scene, an item can be selected by ID, product dimensions are distinct from mesh bounds, and missing geometry/evidence is visible. A fixture is labeled a fixture.

### 2. Add functional controls and revisions

Implement item keep/lock, a constraint form, one plan change, a before/after diff, and server-owned revisions. Add persistence with a deliberately selected provider. First prove the flow with a deterministic proposal before integrating model generation.

Done when: a locked item cannot be removed by a replan, a stale write is rejected, and another browser session can load the accepted revision.

### 3. Integrate the local input paths

Local address research and browser-photo processing exist. Connect their evidence and review states to authorized backend jobs and the shared room-plan confirmation screen. Photo-only input needs actual room images, not tape measurements; uncertain scale must stay visible. Add the approved optional native RoomPlan companion/importer as another input to that boundary, then test a real iPhone 14 Pro capture.

Done when: an unmatched unit offers browser photos or native capture; denied camera permission retains an existing-photo path; every geometry proposal preserves its actual evidence and review requirement. Verify native surface import and physical scanning separately from simulator compilation. Hosted upload authorization, persistence, and jobs must be demonstrated before describing them as connected.

### 4. Add the Blender worker

This stage is implemented locally and is shared by the address/photo input paths. See [working commands, verification, and handoffs](../reconstruction/README.md). Hosted queue/storage integration remains pending; the scope below describes the stage's acceptance criteria.

Generate the confirmed shell from a validated geometry schema using controlled Python. Save source JSON, editable `.blend`, and optimized GLB with a manifest tied to the input revision. Add meaningful async stages and a failure/retry path.

Done when: the export preserves scale, openings, named objects, and fixed fixtures; the viewer loads the artifact; malformed geometry is rejected. Model-generated arbitrary scripts are not required.

### 5. Ground real products and constrained shopping

Select two merchants and prepare source-linked candidate data/assets. Integrate Browser Use for real research and rechecks. Add normalized product variants, known/unknown cost accounting, geometric checks, and the “$300 cheaper, keep these items, preserve four seats” interaction.

Done when: the revised plan satisfies its declared constraints or explains why it cannot, links each product to evidence, and never silently changes SKU dimensions.

### 6. Prove cart preparation

Implement exact variant/quantity checks and one real merchant cart preparation flow with user handoff as needed. Use a demo/test path where available; do not place a real order merely to prove a cart flow. Keep unknown shipping/tax visible until observed.

Done when: displayed cart results match actual observed cart contents, duplicate retries are prevented, and final purchase approval is distinct from preparation.

### 7. Add voice, Quest, and ASI:One interfaces

Each adapter uses the same validated operations. Quest uses the shared GLB/state, feature detection, local spatial alignment, and usable fallback controls. ElevenLabs voice handles selected-object references and actual tool outcomes. Fetch requires an ACP/Agentverse/ASI:One path that completes its primary flow in conversation.

These can be developed independently once the room-plan API is stable. Fetch eligibility is a scope decision early enough to leave time for registration and a complete conversational flow.

Done when: the [device and demo acceptance checks](demo-and-validation.md) have recorded results, and the ASI:One flow changes the same plan rather than a separate mock.

### 8. Select one Solana proof, if pursuing that prize

Choose the resale escrow extension or bounded room mandate based on team capacity and product fit. Implement and test the smallest meaningful on-chain behavior on devnet, with a visible transaction and at least one real rejected/blocked invalid operation where relevant. Do not imply devnet settles a retail order.

This is intentionally a decision gate: deeper research is complete, but the user has not chosen a feature. See [Solana options](solana-options.md).

### 9. Finish the demo and submission

Record the live/prepared/simulated boundaries, expose sources and uncertainty, test actual devices, prepare the correct demo lengths for each target, and complete the [submission checklist](sponsors-and-submission.md). Review pre-existing-code disclosure and source/license provenance.

## Scope cuts that preserve the thesis

Prefer one well-measured room over a visually impressive but ungrounded entire apartment. Use labeled dimensionally accurate proxies when exact retailer models are unavailable. Keep a confirmed-plan fixture available for a failed capture or unavailable GPU. Keep a real retailer link and honest handoff if cart automation is blocked.

Cut research-grade reconstruction, unlimited merchants, automated delivery/assembly booking, and broad marketplace integrations before cutting product evidence, locked-item behavior, plan revisions, cost honesty, or the explicit purchase boundary.

## Assigned ownership boundaries

The user assigned four working areas and requested that Silas and Angelina focus on frontend work. Following both ownership swaps, Matthew owns `backend/`, the project lead owns `reconstruction/`, Angelina owns `frontend/`, and Silas owns `spatial/`. See [team ownership](team-ownership.md) and [agent prompts](agent-prompts.md) for tasks and handoffs; prior experience and registration status are not inferred from these assignments. Avoid separate copies of state or competing schema definitions.
