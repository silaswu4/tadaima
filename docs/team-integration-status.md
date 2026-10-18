# Team Integration Status

Audit baseline: October 18, 2026, shared `main` at `93bd69b`. This records source inspection, not a claim that every provider or physical device was tested. The first-person/Quest integration being built after this baseline should record its verification separately.

## What Each Area Has Built

| Area | Integrated work | Important boundary |
| --- | --- | --- |
| Stephen / reconstruction | Native iPhone RoomPlan geometry, timestamped scan exports, calibrated photos, detailed ARKit mesh capture, address research, metric Blender/GLB generation, photo-informed furniture and surfaces | The clean room preserves measured layout and item envelopes; furniture parts, finishes and hidden details are estimates. Raw observed mesh is a separate reference. Private scans and photos are not repository fixtures. |
| Matthew / backend | Shared contract v0.2, revisioned plan store, deterministic validation/placement, real product catalog, Browser Use research, inventory/drag operations, ElevenLabs client tools, checkout review and Stripe test-mode payments | Browser Use, Claude planning, ElevenLabs and Stripe require configured providers. Catalog and pure geometry/placement rules do not. Retailer orders are simulated. |
| Silas / spatial | Integrated plan viewer at `/spatial`, object selection, proposal previews, revisions, WebXR entry/alignment; `/room` furniture workspace, explode/return, lighting and hash-bound reconstruction imports | At the audit baseline, `/room` has orbit controls; its scanned room is browser-local and is not automatically registered in the backend. |
| Angelina / product frontend | Integrated landing/capture presentation, responsive product entry points and styling | The landing and capture interfaces do not by themselves create a backend project or finish a reconstruction. |

## Remote Branches

`origin/work/backend-browser-use` (`38360d3`), `origin/work/backend-dev-console` (`e41f2b0`), and `origin/work/backend-dev-checkout` (`e94fcac`) are already ancestors of this main baseline. Their capabilities do not need another merge. The backend consolidation landed through `9fc9a7d`.

`origin/work/spatial-iso-hero` (`d890216`) has five unmerged commits:

- `43d4dc4`: isometric landing gallery.
- `042db8a`: room carousel and walkable rooms.
- `d513900`: landing hint adjustment.
- `df42c66`, `d890216`: room/landing brand mark.

Its additions include `/rooms`, `/rooms/[roomId]`, `RoomExperience`, `walk-scene`, `walk-xr`, a gallery and fixture room catalog. The walk engine has mouse-look/WASD, collision, touch controls, controller selection, smooth locomotion, snap turns, teleport and object handling. Its HUD reads the real catalog, but edits and basket state are local snapshots; checkout links to `/dev`. It does not consume the current private scan and does not call `roomClient` for accepted plan mutations. Treat this as useful parallel interaction work, not an already integrated scanned-room shopping flow.

Inspect unique work with `git diff main...origin/work/spatial-iso-hero`. A two-dot diff against this older branch shows unrelated later reconstruction files as deletions and must not be applied as a replacement tree.

`origin/work/backend-fetch-agent` has separate unmerged ASI:One account/onboarding work: sender-bound users, room inventory, agent HTTP routes and `backend/fetch/agent.py`. Its `createRoom` currently starts from a clone of `demoPlan`, even when an address is supplied; it is not an address reconstruction importer. Its additional `createPlan` is a read-then-write helper rather than an atomic create-if-absent operation. Do not merge this account feature merely to obtain a scan import helper.

## Reusable Application Interfaces

`backend/contracts.ts` is the shared type-only boundary. Coordinates are meters, right-handed Y-up. `PlacedItem.dimensions` is `[width, height, depth]` before yaw, `position` is the footprint center at floor level, and furniture front is local +Z.

`backend/client.ts` exposes `roomClient(projectId)`:

| Operation | Behavior |
| --- | --- |
| `get()` | Current plan, cost and validations. |
| `change`, `move`, `drop` | Expected-revision edits through server validation. |
| `store`, `moveTo` | Inventory and solver-assisted placement; locked items need explicit unlocking. |
| `propose`, `apply` | Natural-language proposal followed by explicit application. Planning needs its provider. |
| `shop(request, onUpdate)` | Immediate catalog results, optional live Browser Use search, then polling updates. Set `live: false` for catalog-only behavior. |
| `place(productId, spot, jobId?)` | Recompute fit against the current plan, add a purchase and return the accepted plan. |

Existing routes are `/api/projects/{projectId}` plus `/changes`, `/proposals`, `/shop`, `/place`, `/items/{itemId}/move-to`, `/items/{itemId}/store`, `/checkout` and associated checkout actions. The same plan operations serve web and voice. Do not implement a separate headset purchase state machine.

Pure browser-safe modules can also power a private local preview:

- `backend/shopping/placement.ts`: `placeAt`, `roomAt`, `facingAt` for measured fit and facing.
- `backend/shopping/spot.ts`: `evaluate`, `evaluateAll`, `catalogCandidates`, `itemFor` for catalog filtering, result ranking and placed purchase records.
- `backend/shopping/drag.ts`: `dragCheck`, `dropChange`, `inventory`, `turned` for continuous placement feedback and inventory.
- `backend/plan/rules.ts`: `applyChanges`, `validateChanges`, `blocking`, `costOf` for the canonical rules and proposed-purchase subtotal.
- `backend/shopping/assets.ts`: `assetFor`, `assetTransform`, `itemAsset`; library models are category approximations scaled to listed dimensions, not guaranteed exact SKU meshes.

`backend/fixtures/real-catalog.json` contains 33 observed IKEA/Target products and source evidence. These are saved observations; offline use does not recheck today's price or stock. Preserve merchant URLs, variant IDs, dimensions, observation dates and evidence. Never describe a category-matched visualization as an exact retailer model.

## The Scan-to-Shopping Gap

`spatial/room/import-room.ts` strictly parses reconstruction JSON into a `RoomPlan`. It preserves item IDs, evidence, geometry and metric envelopes. Imported existing furniture currently receives category `other` and unknown seat count. It creates `products: []` and no purchase budget.

`backend/plan/store.ts` only seeds `proj_demo`, `proj_dev`, and supported `proj_demo_*` / `proj_test_*` IDs. There is no scan import/create endpoint on this baseline. An arbitrary scanned project such as `local-roomplan` therefore returns 404 from shopping APIs. Changing its ID to a demo ID would cause shopping to use the wrong floor plan.

Catalog shopping reads **the current plan's products**, not a global list. A scan plan must explicitly receive the observed catalog and its evidence before catalog-only results are available.

The smallest correct integration has two possible scopes:

1. A private browser-local shopping preview uses a copy of the imported scan plan, appends the observed catalog and evidence, and applies the existing pure fit/rule functions. Label it as a preview basket, keep provider/checkout actions unavailable, and leave the original hash-bound scan unchanged. Newly added purchases render separately from its bound GLB.
2. Shared server/voice shopping needs an explicit validated scan registration operation. Parse the bounded reconstruction request, assign a fresh server project ID, preserve source job/hash provenance and existing item IDs, attach catalog evidence, and atomically create a new plan. Return the new plan and then use `roomClient` for all edits. Refuse overwrite, oversized bodies and invalid geometry. Add project authorization before making this a public hosted importer.

The source GLB's identity/request hash belongs to the original reconstruction. Server project identity and plan revisions must not silently invalidate that binding: retain the immutable source binding alongside the mutable shopping plan rather than rewriting GLB metadata.

The bounded local preview adapter is now implemented in `spatial/room/local-shopping.ts`: `prepareLocalShoppingPlan`, `searchLocalProducts`, `commitLocalProduct`, `removeLocalPurchase` and `localShoppingCost`. Search checks only a 0.4 m neighborhood with a 0.15 m grid and no whole-room fallback. It returns at most six ranked catalog results. Commit recomputes placement and runs the shared validator at the expected local revision. Removal refuses owned/locked items and applies the same revision and validation rules. Existing captured geometry, furniture, categories and evidence remain unchanged; new purchases are separate items. The caller must show `LOCAL_SHOPPING_NOTICE`, retain the immutable source plan/model binding, and add the returned purchase to the rendered scene separately. This adapter alone does not establish that the UI or headset flow has passed.

Run its regression checks with `npx tsx --test spatial/tests/test-local-shopping.mjs`. All 19 cases passed during the October 18 integration work. They cover immutable and frozen 28-item source preservation, multiple colliding IDs/evidence, catalog filtering, finite/on-floor points, fresh placement, repeated-confirm revision races, independent purchases, removed or changed catalog records, unknown price/stock/budget semantics, budget refusal, subtotal removal, locked/owned/seating removal guards and tolerance of preexisting scan overlap failures. Targeted ESLint also passed. These tests do not substitute for physical Quest input, display or frame-rate checks.

## Private Scan Access From Quest

The current clean model is on the Mac, outside the repository. Files selected in a Mac browser do not automatically exist in the headset browser.

For a USB development session, the intended path is Android Debug Bridge port forwarding (`adb reverse tcp:3017 tcp:3017`) and the Quest browser opening `http://localhost:3017/room`. This keeps the origin local and avoids a public upload. The earlier spatial viewer documents this path; actual authorization, browser support and performance still require the physical headset. An insecure LAN address such as `http://192.168.x.x:3017` is not an equivalent WebXR secure context.

A bounded local asset route can serve the existing private result without moving it into `public/`: configure one directory server-side, expose only fixed allow-listed request/GLB filenames, send `Cache-Control: no-store`, and keep the route disabled by default in production. Browser input must not choose arbitrary filesystem paths. Run the same import/hash/semantic checks on fetched files as on manually selected files. Raw photos, native source bundles and Blender sources need not be served to walk through the room.

For LAN use without USB, a trusted HTTPS origin is required. A public deployment additionally needs private asset storage and project-level authorization. Do not embed provider credentials or a reconstruction service token in a headset URL or client bundle.

## Untracked Reconstruction Service

`reconstruction/service/` and `reconstruction/tests/test_service.py` were already untracked when this audit started. Preserve this work. The FastAPI service wraps the geometry, RoomPlan, mobile capture and address pipelines with SQLite job records, bounded workers and allow-listed artifact downloads.

It is not currently wired to Next.js, the plan store or this private existing output directory. It serves artifacts only from its own submitted jobs, has no existing-result import, and its geometry/RoomPlan submission paths do not accept the detailed photo bundle plus clean visual-design profile used for the current room. Using it just to share the completed GLB would add job plumbing and risk generating a different result.

Its bearer token is server-only; a future Next adapter should own authorization and proxy the allow-listed results. This audit did not run or deploy the untracked service and does not establish that it is production ready.

## Acceptance Evidence Still Needed

- Walk the actual imported clean room, with wall/furniture collision and a safe spawn, rather than a fixture replacement.
- Select the same stable item IDs in orbit, first person and VR.
- Aim at floor, filter observed products, preview a fitting item at real dimensions, add/remove it and update the purchase subtotal without changing owned furniture or source geometry.
- Distinguish local previews from server-accepted mutations, and saved product observations from live checks.
- Enter and exit immersive VR on the physical Quest 3S; verify correct floor height, controller selection, snap turn/teleport behavior and usable frame rate.
- Confirm that the headset can fetch the private clean GLB through the chosen local transport without exposing source photos or credentials.

At the audit baseline, existing Quest evidence is desktop emulator verification for `/spatial`, not a successful physical Quest test for this scanned `/room` environment.

## Software Integration Verification

The new `/room` implementation now consumes the actual private clean model for orbit, first-person exploration and the WebXR renderer, with local catalog shopping through shared backend fit/rule functions. Desktop browser checks verified WASD movement, a fitting $99.99 observed catalog chair, 28→29 items on confirmation, correct basket subtotal, refusal of another overlapping placement, Next.js Activity navigation away/back preserving both scene and basket, and removal restoring 28 items and a zero subtotal. A 390px viewport has no horizontal overflow and the on-screen pointer movement pad works. This is viewport/pointer emulation, not a physical iPhone touch test.

A separate simulation ran 3,600 movement frames against the actual private scan and all 28 source furniture obstacles; every frame remained finite and on clear supported floor. This does not measure headset FPS. The configured development bridge served the exact private scene JSON and GLB over authenticated localhost; production/unconfigured/unauthenticated/foreign-origin/symlink paths are covered by negative tests. No private scan or token is committed.

The remaining acceptance work is the physical Quest checklist and a later explicit server project/asset registration path for shared live research, voice and checkout. This local preview does not claim those operations. `npm run quest:open` provides the prepared USB launch path when the headset returns.
