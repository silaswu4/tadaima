# Proposed data model and contracts

**Status:** A recommended application data model. A small browser-safe subset exists in [`backend/contracts.ts`](../backend/contracts.ts). Reconstruction now has [runtime geometry validation and generation](../reconstruction/README.md), a [manifest contract](../reconstruction/contracts.ts), and a Node adapter. That is not a complete implementation of the shopping model, API, or persistence layer. Coordinate changes through the [team boundaries](team-ownership.md).

## Conventions

- Canonical geometry uses **meters**, right-handed coordinates, `+Y` up, and floor-plane coordinates `[x, z]`. Store radians for rotations. State the front direction of each imported asset explicitly; the current procedural parts use `+Z`.
- Store money as integer minor units plus ISO currency. Do not use floating-point dollars for totals. Stablecoin amounts use the selected mint's actual decimal precision, a network, and a mint address, not an assumed ticker alone.
- IDs are stable across revisions. Human labels may change. A product, product variant, placed item, and model asset have different IDs.
- Timestamps use UTC ISO 8601. Rendering can localize them.
- Unknown is explicit: use a status or `null`, not zero, empty text, or fabricated certainty.
- Evidence is attached at the claim level. One source can support width while leaving depth unknown.
- Set a `schemaVersion`; version the generator and asset pipeline separately.

The glTF specification defines meters and a right-handed coordinate system; Blender exports must be checked against those conventions. [glTF coordinate system and units](https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/Specification.adoc#34-coordinate-system-and-units).

## Core records

| Record | Minimum responsibility |
| --- | --- |
| `Project` | Owner/access, current room-plan revision, input method, private source references |
| `Evidence` | Origin, observation, retrieval time, claim scope, source URL or private asset, verification status |
| `RoomPlan` | Geometry, constraints, placed items, product references, revision, cost summary |
| `ProductVariant` | Exact merchant product/variant, dimensions, offers, availability, evidence |
| `Asset` | Renderable model, provenance/license, visual fidelity, local bounds, unit conversion |
| `PlanProposal` | Base revision, requested intent, item/constraint changes, cost diff, validator results |
| `Job` | Async state, input revision, stage, attempts, output references, recovery information |
| `CartReview` | Per-merchant observed cart, exact variants/quantities, costs, unknowns, expiry/recheck state |
| `Approval` | Actor, permitted action, reviewed plan/cart digest, time, invalidation conditions |

## Evidence and dimensional provenance

Address evidence should declare one of `exact_unit`, `apartment_type`, `building_generic`, or `unknown`. An apartment-type plan is not exact-unit evidence even if the street address matches. Preserve conflicting plans as candidates instead of merging them.

For each dimensional claim, distinguish `measured`, `source_dimension`, and `inferred`. Record user confirmation separately: confirming that a plan looks right does not turn an inferred dimension into a physical measurement. Optional uncertainty can be an interval supported by a method; do not invent a numeric confidence percentage.

Recommended evidence fields:

```json
{
  "id": "evidence_demo_wall",
  "kind": "user_measurement",
  "sourceUrl": null,
  "privateAssetId": null,
  "claim": "Living room back wall length",
  "value": 4.2,
  "unit": "m",
  "dimensionStatus": "measured",
  "unitMatchScope": "unknown",
  "observedAt": "2026-10-17T19:00:00Z",
  "confirmedByUserAt": "2026-10-17T19:01:00Z"
}
```

All IDs, timestamps, and values in examples here are synthetic. No example represents a real home, retailer offer, or completed operation.

## Geometry

A room shell should have a closed floor polygon, wall segments with stable IDs, and openings referenced to their parent wall. For a simple first room, wall height and thickness can be consistent defaults, but defaults must remain labeled. Complex apartments need shared boundary rules instead of overlapping independent walls.

The implemented shell worker currently treats wall segments and room floor polygons as **centerline boundaries**, with half the wall thickness on each side. Net interior clearance is smaller. Upstream capture/plan extraction must convert measured clear dimensions deliberately; downstream fit checks must account for actual wall solids. See [the concrete geometry semantics](../reconstruction/README.md#geometry-contract).

Recommended geometry fields:

- `rooms`: ID, label, floor polygon `[x,z]`, height, and evidence references.
- `walls`: ID, start/end, thickness, height, parent room references, evidence references.
- `openings`: ID, wall ID, distance from wall start, width, height, sill height, kind, and door swing when known.
- `fixedFixtures`: ID, type, metric bounds/transform, room ID, evidence references.
- `referenceAssets`: scan/photo/plan references that are not editable furniture.

For a first rectangular room, the minimum shape can be:

```json
{
  "schemaVersion": "0.1-proposed",
  "id": "plan_demo",
  "revision": 1,
  "units": "m",
  "coordinateSystem": "right-handed-y-up",
  "rooms": [
    {
      "id": "living",
      "label": "Living room",
      "floorPolygon": [[0, 0], [4.2, 0], [4.2, 3.5], [0, 3.5]],
      "height": 2.7,
      "evidenceIds": ["evidence_demo_wall"],
      "geometryStatus": "partially_confirmed"
    }
  ],
  "items": [],
  "constraints": {
    "currency": "USD",
    "budgetMinor": 250000,
    "minimumSeats": 4,
    "lockedItemIds": [],
    "clearanceRules": []
  }
}
```

This example intentionally does not establish all dimensions. Before a fit claim, validation must resolve the dimensions relevant to that placement. A polygon should not imply that every edge is measured merely because one evidence reference exists.

## Product versus model versus placed item

`ProductVariant` should identify a merchant, canonical source URL, merchant SKU/variant identifier when visible, material/color/size, dimensions with axis meanings, assembly state if relevant, and per-field evidence. A display label such as “blue sofa” is insufficient for checkout.

`Offer` should include currency, listed item price, quantity, observed stock status, delivery region assumptions, shipping/tax/assembly observations, retrieval time, and source/session references. Delivery estimates need the information they depend on. Exact private addresses must not leak into public offer fixtures.

`Asset` should include source/license, exact or approximate visual fidelity, actual known SKU match, dimensions used for generation, pivot/orientation, generator version, and artifact references. Asset appearance can be approximate while dimension bounds are grounded. Label those two claims separately.

`PlacedItem` should contain:

- Stable ID, label, room ID, transform in meters/radians.
- Product variant and asset references, or a clear `existing_owned` origin.
- Physical width/depth/height and evidence; these are independent of an arbitrary GLB's bounding box.
- Lock state, seat count or functional attributes where relevant.
- Placement status and validator results.
- Optional future disposition `keep`, `sell`, `replace`, only if the resale feature is selected.

Do not non-uniformly shrink retailer geometry to make a rejected item appear to fit. Conversion from known model units into meters is legitimate; changing physical SKU dimensions is not.

## Constraints and validation results

Hard constraints include maximum budget, locked item identity and placement where requested, room boundaries, fixed fixture exclusion, door swing clearance, and minimum functional capacity. Style, preferred retailer, and color are usually soft preferences unless the user explicitly makes them mandatory.

Validation results should have a rule ID, affected entity IDs, severity, explanation, and evidence of the calculation. Use `pass`, `fail`, or `unknown`. Missing opening widths cannot produce a passing delivery-path result.

For the first implementation, a conservative oriented footprint test and explicit clearance zones are more useful than claiming full physics. Separate room fit, circulation clearance, assembly feasibility, and delivery-path feasibility.

## Cost accounting

Keep distinct values for known item subtotal, known shipping/tax/assembly, unknown charges, estimated total where appropriate, and final merchant-observed payable total. All totals carry the plan revision and price-observation timestamps.

For a future sell-to-upgrade option, distinguish asking prices, projected proceeds, escrowed buyer funds, released/settled proceeds, and spendable balance. Only actually released funds become spendable. Never subtract hypothetical resale revenue from a displayed cash requirement as though it has already arrived.

## Proposal, approval, and cart contracts

A proposal references `baseRevision` and contains explicit additions/removals/replacements/transforms, preserved locks, constraint changes, evidence updates, and before/after cost. Applying it requires a matching current revision and successful required validations.

A cart review is per merchant, with actual observed line items/variants/quantities, checkout/cart references, known costs, unknown costs, current status, and last check time. `prepared` means the cart was verified; it does not mean payment, order placement, or fulfillment.

An approval records the exact action and reviewed state. Product variant changes, basket changes, price changes requiring review, stale cart state, or a different recipient invalidate the relevant approval. A signed transaction, spending allowance, merchant cart approval, and room-plan approval are separate records.

## Asset and job output manifest

Store artifact IDs and access-controlled URLs or storage keys, content hashes, media type, byte size, input plan revision, source evidence IDs, generator version, and completion time. Keep `.blend` as editable source and GLB as runtime output. Never regenerate a room from an unlabeled GLB and silently treat it as the original confirmed plan.

Tests should cover schema rejection, unit conversion, stale revisions, locked items, impossible geometry, exact variant identity, money arithmetic, unknown costs, and idempotent cart retries. The [demo validation plan](demo-and-validation.md) covers user-visible checks.
