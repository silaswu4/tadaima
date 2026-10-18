# In-room shopping integration

Updated October 18, 2026.

The website flow `/` → `/rooms` → `/rooms/[roomId]` connects the selected room to Matthew’s backend. The viewer, furniture search, placement confirmation and checkout use that room’s canonical server plan. They do not borrow the unrelated `proj_demo` basket.

## Local setup

Add credentials to the checkout’s ignored `.env.local`, then restart the development server. Keep values out of chat, source control, screenshots and browser code.

| Variable | Purpose | Without it |
| --- | --- | --- |
| `BROWSER_USE_API_KEY` | Browser Use Cloud searches retailer pages. | Observed catalog search still works; live browsing is visibly unavailable. |
| `STRIPE_SECRET_KEY` | Stripe **test** payments. Only `sk_test_` / `rk_test_` keys are accepted. | Test card connection and payment remain unavailable. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` or `STRIPE_PUBLISHABLE_KEY` | Optional publishable test key for the existing Stripe card setup interface. | The in-room test Visa shortcut only needs a configured test secret key. |
| `KV_REST_API_URL` and `KV_REST_API_TOKEN` | Upstash persistence for canonical plans, jobs, sessions and checkout state. | Development uses process memory; production refuses to run the store without persistence. |

Run the existing application from the repository root:

```bash
npm run dev -- --hostname 127.0.0.1 --port 3017
```

Use the same origin consistently. `localhost` and `127.0.0.1` have different cookie/browser storage contexts. Development storage resets when its server process restarts; browser room files and drafts can remain, but a lost in-memory payment record is not a durable receipt. Use persisted server storage for a shared or hosted demo.

The native scanner and private local capture bridge retain their separate setup in [Quest setup](quest-setup.md) and [website room flow](website-flow.md). Shopping does not require uploading the GLB, room photographs or native photo ZIP.

## Product flow

1. Choose a room from **Your rooms**, then **Step inside**. The room connects automatically. Connection failures show a retry action; they do not silently route shopping to a demo room.
2. Walk with WASD/arrow keys or touch controls. Use Dollhouse to select a clear floor spot, or shop at the current view’s spot. A selected existing piece can be swapped at its own position.
3. Open **Add furniture**. Choose a category, retailer, price cap and optional description. **Browse store live** becomes available when the server reports Browser Use capability.
4. Select **Search furniture**. Saved observations arrive first, with their real catalog prices and dimensions. Live searches continue in the background and report progress separately.
5. Preview a result at its product dimensions. The library model is an approximate representation of the product, not a claim that its shape or fabric exactly matches the merchant listing.
6. Explicitly **Confirm placement**. The server recomputes placement against the current plan, checks stock, dimensions, budget and fit, and saves a new revision. A stale preview is refused and the room refreshes.
7. Move, rotate, store, take out or undo furniture. Accepted edits synchronize with the same server room. Replacing an owned piece through the placement endpoint stores the original in inventory and adds a separate proposed purchase; it preserves the owned item’s identity and measured dimensions.
8. Open **Basket**. Lines come from active proposed purchases in this room, excluding owned and stored furniture. Review live price/stock and the separate Stripe test flow below.

Returning to the gallery, reopening the same room or refreshing resumes its server project while the browser session cookie remains valid. Other room IDs keep separate plans, baskets, approvals and orders.

## Session and source boundaries

`POST /api/room-sessions` registers a bounded metric `RoomPlan` and a browser room ID. It returns an opaque `proj_room_<random ID>` and sets an HttpOnly, SameSite=Strict browser cookie. Private project routes verify that cookie; mutations also require a matching Origin. A missing or different room session receives 404. Provider credentials stay on the server.

The server owns product observations, prices, product dimensions and revisions. Registration replaces matching catalog observations with the server’s trusted catalog. Unknown initial demo products remain explicitly marked fixtures; they cannot masquerade as live observations or pass checkout. Snapshot synchronization cannot overwrite captured geometry, appearance, evidence, owned dimensions or server product observations.

The original reconstruction plan and model binding remain separate from the canonical shopping project. Updating the server project ID or placing furniture does not rewrite the source JSON/hash or break its GLB provenance. Browser persistence maps accepted server edits back to the source room identity for the gallery.

Important modules:

| Boundary | Implementation |
| --- | --- |
| Session registration, authorization and resume | `backend/session/service.ts`, `app/api/room-sessions/` |
| Bounded JSON/schema and immutable source checks | `backend/session/body.ts`, `schema.ts`, `sync.ts` |
| Browser connection and serialized mutations | `spatial/rooms/use-room-shopping.ts` |
| Scene acceptance, revision and preview handling | `spatial/room/walk-authority.ts`, `walk-scene.ts` |
| Search jobs and placement | `backend/shopping/shop.ts`, `placement.ts`, `spot.ts` |
| Basket and test payment review | `spatial/components/RoomCheckout.tsx`, `backend/checkout/` |

## Search jobs and placement

`POST /api/projects/{id}/shop` accepts a category, floor spot, optional retailer, free-text request, USD price cap and `live` flag. Catalog observations are checked immediately at that spot. When live browsing is enabled, the existing Browser Use adapter researches the requested retailer and returns structured product evidence.

Poll `GET /api/projects/{id}/shop/{jobId}`. The job distinguishes `output.live` values:

- `skipped`: catalog-only search.
- `running`: live research is still progressing; initial catalog results remain usable.
- `done`: the live pass finished and merged its observations.
- `failed`: live research failed; the UI retains the catalog results and says that the live pass was unavailable.

The top-level job can be `succeeded` while `output.live` is `failed`, because the catalog search completed. Consumers must inspect the live-pass field and stage rather than announcing successful live research from the top-level state alone. Stopping browser polling does not cancel an already-running provider task.

Results expose product observations, fit problems, placement and catalog/live origin. Reads re-evaluate fit against the current room. A product without established dimensions or stock cannot claim to fit. Live results that fit can join the server catalog and advance its revision; the client refreshes before a subsequent edit.

`POST /api/projects/{id}/place` accepts `productId`, `spot`, optional `jobId`, `expectedRevision` and optional `replaceItemId`. The confirmed revision must still match. Replacement uses the original item’s spot, rejects locked or stored targets, and applies the inventory change plus new purchase in one plan revision. A rejected fit or mutation leaves the old piece intact.

## Checkout and honest completion

The basket is derived from the canonical plan on every read. Its digest includes merchant, product, variant, quantity, price and currency. Checkout refuses incompatible currencies rather than adding them together. It also refuses unknown products/prices, fixture-only products, unverified stock, expired or incomplete rechecks, an exceeded budget, missing cards and a cart already paid for.

1. **Recheck price and stock** reads supported retailer product pages. The current direct recheck supports IKEA. Missing stock/currency, an ambiguous offer, a blocked page or an unsupported retailer stays unverified and blocks approval. Changed observations update the room before approval.
2. **Connect Stripe test Visa** appears only with configured test payment capability. It attaches Stripe’s built-in test Visa; no real card number enters this interface.
3. **Approve this exact cart** sends the displayed digest and selected payment method. It authorizes that cart and amount at those merchants for 30 minutes. Approval never triggers payment automatically.
4. **Pay in test mode** is a separate explicit action. The server rechecks current requirements, atomically claims the mandate and exact cart, then sends the test charge with a per-mandate idempotency key.
5. The receipt identifies a Stripe test payment and **simulated retailer orders**. No furniture is ordered. Shipping and tax are not charged or represented as known.

A room revision or component/session change clears local approval. A changed cart needs a fresh server approval. A known declined test charge requires another explicit approval before retrying. If the Stripe response is uncertain, the cart remains blocked pending reconciliation; inspect its Stripe test dashboard result before any operator recovery. Do not delete the claim and blindly retry a charge.

Live furniture purchasing, merchant checkout automation and delivery fulfillment are not connected by this integration. A working search-and-placement demo can be shown without any provider keys; a live research/payment claim requires exercising the configured providers separately.

## Validation

Run checks from the repository root:

```bash
npm test
npm run test:spatial
npx tsc --noEmit
npm run lint
npm run build
E2E_BASE=http://127.0.0.1:3017 npx tsx --test backend/e2e/room-sessions.e2e.ts
```

The new checkout tests use isolated processes with server-only imports enabled. Payment success, decline, uncertain outcomes and simultaneous execution use stubbed Stripe resources while HTTP/HTTPS requests are rejected; those tests do not make actual Stripe calls. Session tests cover unauthorized reads/mutations, cross-origin refusal, per-room resume, stale revision races, bounded input and owned-furniture replacement.

For browser acceptance, enter the actual scanned room, search a saved retailer observation, preview and confirm one purchase, inspect its basket and reopen the room. Verify that the purchase persists, a different room has a different basket, an owned replacement remains in inventory and refused placement leaves the room unchanged. Then test provider-specific live research and Stripe test payment only after local configuration. Headset frame rate and controller comfort still require the physical Quest; automated XR checks do not establish them.
