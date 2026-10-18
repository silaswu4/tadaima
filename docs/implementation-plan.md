# Repository state and implementation plan

Repository inspected October 17, 2026 at base commit `cbbe48fe69b1b12afa4b1fb9c245bce6b83e84c4` on `main`. This document separates observed code from proposed work.

## What exists

| Path | Observed responsibility |
| --- | --- |
| `app/page.tsx` | Full-height hero, “Michael” headline, placeholder `#` sign-in and scan links |
| `app/layout.tsx` | Local Paper Mono font and Michael page metadata |
| `app/globals.css` | Light surface/ink tokens, grain overlay, some unused-looking warm accent tokens; no cleanup requested |
| `components/RoomHero.tsx` | Client component, lazy scene import, loading fade, selection label, centimeter/inch display, coarse-pointer lightweight mode |
| `lib/room/scene.ts` | Hardcoded room shell and furniture, GLB loading, pencil contours/edges, fixed camera, raycast hover/touch selection, render loop/disposal |
| `lib/room/parts.ts` | Procedural meter-based objects and materials; local parts use floor origin and front `+Z` |
| `public/models/` | Seven bundled GLB models, referenced by the hero |
| `app/fonts/` | Paper Mono WOFF2 and SIL Open Font License text |
| `HANDOFF.md` | Earlier Michael product/design handoff; partially superseded by web-only requirements |
| `AGENTS.md` | Next.js-generated warning to read installed version-specific guides before writing application code |
| `README.md` | Mostly create-next-app starter text; the docs entry link points here |

The hero creates nine object entries: rug, sofa, coffee table, lounge chair, cabinet, shelves, side table, vase, and floor lamp. The scene has a fixed camera and a hardcoded room approximately 6 by 6.2 meters, with 2.7-meter wall height. These values describe a demonstration scene, not a reconstruction of the user's home.

The label dimensions are calculated from scene object bounding boxes after transforms. They are not merchant specifications or independently verified physical measurements. Rotated world-space bounds can differ from intrinsic product width/depth. Treat this code as a useful interaction/rendering starting point, not a finished fit engine.

Commit `07d83cb` attributes the bundled furniture models to CC0 Poly Haven assets in its message. Before redistribution beyond the current assets, preserve or verify the individual source records and license provenance; there is not yet a full per-asset provenance manifest in the app.

## What does not exist

No address search, upload route, room-capture pipeline, Apple RoomPlan import, Blender job, structured room plan, backend persistence, authentication, product catalog, real retailer search, cart preparation, checkout, WebXR session, shared-device state, voice agent, Fetch agent, wallet, or Solana contract was found in the inspected source tree. No automated application test suite is configured in `package.json`.

## Dependencies and local setup

Observed package versions:

- Next.js `16.4.2`.
- React and React DOM `19.3.0`.
- Three.js `^0.186.1`.
- TypeScript `^5`, ESLint `^9`, Tailwind CSS `^4`.
- A tracked `package-lock.json` is present. The package name remains `michael`.

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

`start` runs a production build after one has been produced; it is not a substitute for `build`. These are documented commands, not claims that they were executed successfully during the documentation task.

Before application changes, follow `AGENTS.md` and read the relevant installed Next.js guides under `node_modules/next/dist/docs/`. Do not assume older framework conventions apply to this version.

There are no integration secrets or environment contracts established by this repository. Choose provider configuration when implementing each adapter and document the real variables in a sanitized example file. Do not paste guessed environment variables or actual credentials into public docs.

## Recommended implementation order

### 1. Establish the canonical room slice

Build one synthetic/measured room fixture using the [proposed data contract](data-model.md), plus stable IDs and a validated loader. Refactor only enough of the current scene to render that data. Retain the visual direction while replacing hardcoded shopping assumptions.

Done when: the same plan produces the same metric scene, an item can be selected by ID, product dimensions are distinct from mesh bounds, and missing geometry/evidence is visible. A fixture is labeled a fixture.

### 2. Add functional controls and revisions

Implement item keep/lock, a constraint form, one plan change, a before/after diff, and server-owned revisions. Add persistence with a deliberately selected provider. First prove the flow with a deterministic proposal before integrating model generation.

Done when: a locked item cannot be removed by a replan, a stale write is rejected, and another browser session can load the accepted revision.

### 3. Make both input paths real

For address onboarding, search a prepared permitted demo property, show candidate sources, and require match/dimension confirmation. For iPhone onboarding, implement permission-aware camera capture/upload and guided measurement entry. Both feed the same room-plan confirmation screen.

Done when: an unmatched unit produces a useful capture/measurement fallback, a denied camera permission has a usable upload path, and each source/dimension retains its provenance. Capture does not need a research-grade neural reconstruction to establish a truthful first slice.

### 4. Add the Blender worker

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

## Suggested ownership boundaries

If dividing work, establish the room-plan/tool contract first. Good independent boundaries are capture/reconstruction, viewer/Quest, research/planner, and commerce/sponsor adapters. Avoid separate copies of state or competing schema definitions. No actual team member assignments or skills have been confirmed in this documentation.
