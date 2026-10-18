# Backend · Matthew

Owner: **Matthew**. This is the application and agent integration area. Work alongside the project lead's reconstruction pipeline, Angelina's screens, and Silas's spatial viewer.

## Scope

- Canonical room-plan state, persistence, revisions, authorization, and async job coordination.
- Shared browser-safe types in [`contracts.ts`](contracts.ts).
- Product research and cart preparation through Browser Use.
- Constraint-aware planning and deterministic validation.
- ElevenLabs server tools/authentication and Fetch/ASI:One agent integration.
- The selected Solana adapter once the team chooses its scope; x402 remains rejected.
- Integration in root `app/` routes/layout and shared package/config changes.

## What exists

- [`contracts.ts`](contracts.ts) v0.2: room plan, items with category and seats, product candidates (with a `fixture` flag), plan changes, proposals, validation results, apply results, jobs and cart reviews.
- [`fixtures/demo-room.ts`](fixtures/demo-room.ts): a synthetic 5.0 x 4.2 m living room. Owned sofa and desk are locked, five proposed purchases ($1,725 of a $2,000 cap), seats exactly 4, plus a 14-product synthetic catalog for swaps. Not a real home or real offers.
- [`plan/rules.ts`](plan/rules.ts): pure `applyChanges`, `costOf` and `validate` (in room, clearance overlap, locked items kept, budget, seats, sizes known, product available). Unknown sizes or stock come back `unknown`, never `pass`.
- `npm test` runs `plan/rules.test.ts`.
- [`research/browserUse.ts`](research/browserUse.ts): server-only `researchProducts({ category, query, maxPriceUsd, maxWidthM?, merchant })` on Browser Use Cloud API v4 with structured output. Returns real `ProductCandidate`s plus evidence and run info (run id, live url for the activity feed; never persist the live url).
- [`fixtures/real-catalog.json`](fixtures/real-catalog.json): real IKEA US and Target products built by `npx tsx backend/research/build-catalog.ts` (needs `BROWSER_USE_API_KEY` in `.env.local`) and spot-checked by `npx tsx backend/research/verify-catalog.ts`. Prices and stock drift; recheck before cart.

Item `position` is the center of the footprint on the floor, `dimensions` are `[width, height, depth]` before rotation, `rotationY` is radians about +Y (three.js convention).

## First tasks

1. Agree on `contracts.ts` with the other three owners. The scaffold is a starting contract, not runtime validation or a complete implementation of the proposed data model.
2. Implement one fixture-backed project/plan read and validated revision write.
3. Connect the project lead's confirmed geometry output to the canonical plan.
4. Expose product research and a constrained revision through the same service operations used by the frontend, voice, and ASI:One.
5. Add exact-basket review and real cart state before payment work.

## Boundaries

`contracts.ts` must stay free of runtime imports, secrets, Node-only libraries, and provider SDKs so clients can safely use `import type`. Put actual server implementations in this folder and guard them with the framework's server-only boundary when introduced. Root `app/api/**/route.ts` files should be thin adapters to those implementations.

Do not put UI components, capture screens, or Three.js rendering here. Do not make a provider response canonical without validation. No endpoint, database, model provider, or external integration is implemented by this scaffold.

See [team ownership](../docs/team-ownership.md), [architecture](../docs/architecture.md), and [shopping behavior](../docs/agent-and-shopping.md). All application commands run from the repository root.
