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

- [`contracts.ts`](contracts.ts) v0.2: room plan, items, products, plan changes, proposals, validation, jobs, spot shopping (`FloorSpot`, `Placement`, `ShopRequest`, `ShopResult`, `ShopJobOutput`, `PlaceResult`), cart and checkout. Type-only.
- [`client.ts`](client.ts): browser-safe client for the viewer and product screens (`roomClient(projectId)`), including async `shop()` with polling.
- [`fixtures/demo-room.ts`](fixtures/demo-room.ts): synthetic 5.0 x 4.2 m living room furnished from real IKEA products. Owned sofa and desk are locked; five proposed purchases come to $1,397.97 of a $1,500 cap; seats exactly 4. [`fixtures/real-catalog.json`](fixtures/real-catalog.json) holds 33 real IKEA and Target products.
- [`plan/rules.ts`](plan/rules.ts): pure `applyChanges`, `costOf`, `validate` (in room, clearance overlap, locked kept, budget, seats, sizes known, in stock). Unknown is never a pass.
- [`plan/planner.ts`](plan/planner.ts): Claude Opus turns a request into plan changes, retried against the validator.
- [`shopping/placement.ts`](shopping/placement.ts): where a piece goes when the shopper points at the floor. Wall pieces snap their back to the nearest wall; blocked spots slide along the wall or turn; every placement passes `in_room` and `no_overlap`.
- [`shopping/spot.ts`](shopping/spot.ts) and [`shopping/shop.ts`](shopping/shop.ts): shop at a spot. Instant catalog matches, then a live Browser Use search measured at the same spot; results are re-checked against the live plan on every read. `placeProduct` and `moveItemTo`.
- [`shopping/assets.ts`](shopping/assets.ts): our 3D library. Each product maps to the closest GLB in `public/models` for its category; `assetTransform` scales it per axis to the product's real size. Rugs and lamps are procedural.
- [`research/browserUse.ts`](research/browserUse.ts): Browser Use Cloud v4 product research with structured output.
- [`checkout/`](checkout/) and [`payments/stripe.ts`](payments/stripe.ts): cart derived from the plan, live price recheck, Stripe test-mode card, shopper-approved mandate, agent pays within it. Test mode only; retailer orders are simulated.
- [`voice/`](voice/): ElevenLabs agent config and the browser client tools.
- [`fetch/`](fetch/README.md): Matthew's Fetch/ASI:One Python adapter, with single-use browser pairing to the actual private scanned room. [`session/fetch.ts`](session/fetch.ts) scopes research/proposals/previews/cart reads; explicit acceptance remains in the web room. The Python process must run separately with the team's existing seed and the same backend URL.

Item `position` is the center of the footprint on the floor, `dimensions` are `[width, height, depth]` before rotation, `rotationY` is radians about +Y (three.js convention). A piece's front is local +Z.

## API

Deployed at `https://tadaima-matthew-kims-projects-b1fc1628.vercel.app` behind Vercel deployment protection. Server-to-server callers send header `x-vercel-protection-bypass: <secret>`.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/api/projects/{id}` | | `{ plan, cost, validations }` |
| POST | `/api/projects/{id}/reset` | | fixture plan (demo and `proj_test_*` only) |
| POST | `/api/projects/{id}/changes` | `{ expectedRevision, changes }` | `ApplyResult` (drag, lock, remove) |
| POST | `/api/projects/{id}/proposals` | `{ intent, selectedItemId? }` | `PlanProposal` (~10 s, Claude) |
| POST | `/api/projects/{id}/proposals/{pid}/apply` | `{ expectedRevision }` | `ApplyResult` |
| POST | `/api/projects/{id}/shop` | `ShopRequest` | `Job<ShopJobOutput>`, catalog results included |
| GET | `/api/projects/{id}/shop/{jobId}` | | the job, re-checked against the room now |
| POST | `/api/projects/{id}/place` | `{ productId, spot, expectedRevision? }` | `PlaceResult` |
| POST | `/api/projects/{id}/items/{itemId}/move-to` | `{ spot, unlock? }` | `PlaceResult` (also brings a stored piece back) |
| POST | `/api/projects/{id}/items/{itemId}/store` | `{ unlock? }` | `ApplyResult` (put away in inventory) |
| GET | `/api/projects/{id}/brief?itemId=` | | what the shopping agent knows at an item |
| POST | `/api/projects/{id}/research` | `{ itemId, request? }` | `Job<ResearchJobOutput>` (replace an item) |
| GET | `/api/projects/{id}/jobs/{jobId}` | | research job |
| GET | `/api/projects/{id}/checkout` | | cart, recheck, cards, mandate, orders, blockers |
| POST | `/api/projects/{id}/checkout/recheck` \| `card` \| `card/test` \| `approve` \| `execute` \| `revoke` | | checkout steps |
| GET | `/api/voice/token` | | `{ token }` for ElevenLabs `startSession` |

Errors: 400 bad body, 404 unknown project/item/product/job, 409 refused checkout, 422 a spot that isn't on the floor.

For the website’s selected-room connection, private browser sessions and in-room checkout, see [in-room shopping integration](../docs/shopping-integration.md).

## Viewer integration (spot shopping)

1. Raycast the floor where the shopper looks or taps; that hit is the `FloorSpot` (`{ position: [x, 0, z] }`, plan meters).
2. `room.shop({ category, spot, maxPriceUsd, request }, onUpdate)`. The first update arrives at once with catalog matches; more arrive while the live search runs.
3. Draw each fitting result as a ghost at `result.placement` (position and rotationY), using `assetFor(product.category, product.dimensions)` and `assetTransform(asset, product.dimensions)`: recenter the GLB on its footprint with its base at y = 0, rotate it by `yaw`, scale by `scale`, then put it under a group at the placement.
4. "Add to cart" is `room.place(product.id, spot)`. On `ok`, redraw from `placed.plan`. A refusal says why (budget, no longer fits, stock).
5. Dragging a piece ends with `room.move(...)`; "put it here" is `room.moveTo(itemId, spot)`.

Plan items carry `assetUrl` and `dimensions`, so the same transform draws everything already in the room.

## Hands-on rearranging (drag, inventory)

Anything the shopper can pick up (mouse, touch, or a hand in the headset):

1. On grab, remember the item. Every frame while held, call `dragCheck(plan, itemId, position, rotationY)` from [`shopping/drag.ts`](shopping/drag.ts). It's pure and runs locally (no network): `fits` (green), `snapped` (amber: `pose` was nudged within 25 cm to fit), `droppable` false (red, with `problems` in plain words). Draw the piece at `pose`. A rotate gesture is `turned(rotationY, 1)`.
2. On release, if `droppable`: `room.drop(plan.revision, item, pose)`. The server runs the same rules; on `stale_revision`, refetch and drop again. If not droppable, animate back.
3. Inventory: `room.store(itemId)` puts a piece away (off the floor, seats nobody, a purchase leaves the cart). `inventory(plan)` lists them for a tray. Dragging one out is the same `dragCheck` + `drop` (it becomes a `take_out`), or `room.moveTo(itemId, spot)` to let the server place it.

Locked pieces (the shopper's own, marked keep) refuse to move or store unless the request says `unlock`; they stay locked where they land. A rule that's already failing (seats short because a chair is put away) doesn't freeze the room: changes are only refused for failures they add or make worse.

## Voice

[`voice/clientTools.ts`](voice/clientTools.ts) gives the ElevenLabs agent its client tools: `get_room`, `propose_change`, `apply_proposal`, `shop_here`, `check_search`, `place_product`, `move_here`, `put_away`, `get_cart`, `recheck_cart`, `pay_now`. Pass `getSpot` (the viewer's current floor spot) and `onShopUpdate: (msg) => conversation.sendUserMessage(msg)`: `shop_here` answers at once, and when the live search finishes the app sends an `[app update]` the agent relays to the shopper. Re-sync the agent after editing [`voice/agent-config.ts`](voice/agent-config.ts): `npx tsx --env-file=.env.local backend/voice/setup-agent.ts`.

## Testing

| Command | What it checks | Cost |
| --- | --- | --- |
| `npm test` | Rules, room brief, placement solver (including a property test that every placement passes the validator), spot ranking, 3D library | free |
| `npm run e2e` | Every API route against a running server (`npm run dev -- -p 3009`): reads, edits, races, shop, place, move, inventory, room sessions, checkout | ~$0.10 Claude |
| `E2E_PLANNER=1 npm run e2e` | Also the 16-case planner exam | +~$1 Claude |
| `E2E_LIVE=1 npm run e2e` | Also live Browser Use searches on IKEA | +~$0.05 |
| `npm run e2e:voice` | ElevenLabs agent behavior via its conversation simulator, including spot shopping | ElevenLabs credits |

Point the e2e suite at a deploy with `E2E_BASE=https://... E2E_BYPASS=<bypass secret>`. Each test makes its own `proj_test_<id>` copy of the demo room, so runs never touch `proj_demo`. `/dev` is a hand-testing console for all of it.

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
