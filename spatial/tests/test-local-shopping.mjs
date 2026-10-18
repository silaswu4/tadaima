import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { prepareLocalShoppingPlan, searchLocalProducts, commitLocalProduct, removeLocalPurchase, localShoppingCost, LOCAL_SHOPPING_NOTICE } from "../room/local-shopping.ts";
import { parseRoomImport } from "../room/import-room.ts";
import { applyChanges, validate } from "../../backend/plan/rules.ts";

const catalog = JSON.parse(readFileSync(new URL("../../backend/fixtures/real-catalog.json", import.meta.url), "utf8"));
const spot = { position: [6, 0, 5], rotationY: 0 };

function sourcePlan() {
  return {
    schemaVersion: "0.2", projectId: "local-roomplan", revision: 0,
    geometry: { units: "m", coordinateSystem: "right-handed-y-up",
      rooms: [{ id: "room", label: "Scanned study", floorPolygon: [[0, 0], [12, 0], [12, 10], [0, 10]], height: 2.7, evidenceIds: ["scan"] }],
      walls: [
        { id: "back", start: [0, 0], end: [12, 0], height: 2.7, thickness: .1, evidenceIds: ["scan"] },
        { id: "right", start: [12, 0], end: [12, 10], height: 2.7, thickness: .1, evidenceIds: ["scan"] },
        { id: "front", start: [12, 10], end: [0, 10], height: 2.7, thickness: .1, evidenceIds: ["scan"] },
        { id: "left", start: [0, 10], end: [0, 0], height: 2.7, thickness: .1, evidenceIds: ["scan"] },
      ], openings: [] },
    evidence: [{ id: "scan", claim: "Measured scan", dimensionStatus: "measured", sourceUrl: null, privateAssetId: "private-scan", observedAt: "2026-10-18T11:24:07Z", confirmedByUserAt: null }],
    items: [{ id: "owned", roomId: "room", label: "Captured table", category: "other", origin: "existing_owned", productId: null, assetUrl: null,
      position: [1, .1, 1], rotationY: .2, dimensions: [1, .8, .6], seats: null, locked: true, evidenceIds: ["scan"] }],
    products: [], constraints: { budget: null, minimumSeats: null, clearance: .3 },
  };
}

test("prepare clones the source without changing identity, measured geometry, owned items, or evidence", () => {
  const source = sourcePlan(), before = structuredClone(source);
  const plan = prepareLocalShoppingPlan(source);
  assert.deepEqual(source, before);
  assert.notEqual(plan, source);
  assert.deepEqual(plan.geometry, source.geometry);
  assert.deepEqual(plan.items, source.items);
  assert.deepEqual(plan.evidence[0], source.evidence[0]);
  assert.equal(plan.projectId, source.projectId);
  assert.equal(plan.revision, source.revision);
  assert.equal(plan.products.length, 33);
  assert.deepEqual(prepareLocalShoppingPlan(plan), plan);
});

test("catalog ID collisions preserve source records and consistently remap evidence references", () => {
  const source = sourcePlan();
  source.evidence.push({ ...source.evidence[0], id: catalog.evidence[0].id, claim: "Unrelated captured evidence" });
  source.products.push({ ...catalog.products[0], label: "Unrelated product occupying the ID" });
  source.items[0].id = catalog.products[1].id;
  const before = structuredClone(source);
  const plan = prepareLocalShoppingPlan(source);
  assert.deepEqual(source, before);
  assert.deepEqual(plan.items, before.items);
  assert.deepEqual(plan.products[0], before.products[0]);
  assert.deepEqual(plan.evidence[1], before.evidence[1]);
  const imported = plan.products.find((p) => p.label === catalog.products[0].label);
  assert.notEqual(imported.id, catalog.products[0].id);
  assert.notEqual(imported.evidenceIds[0], catalog.evidence[0].id);
  assert.equal(plan.evidence.find((e) => e.id === imported.evidenceIds[0]).claim, catalog.evidence[0].claim);
  assert.notEqual(plan.products.find((p) => p.label === catalog.products[1].label).id, source.items[0].id);
  assert.deepEqual(prepareLocalShoppingPlan(plan), plan);
});

test("saved catalog search filters category, merchant, cap and returns at most six results without edits", () => {
  const plan = prepareLocalShoppingPlan(sourcePlan()), before = structuredClone(plan);
  const results = searchLocalProducts(plan, { category: "chair", spot, maxPriceUsd: 150, merchant: "IKEA", live: true });
  assert.ok(results.length > 0 && results.length <= 6);
  assert.ok(results.every((r) => r.source === "catalog" && r.product.category === "chair" && r.product.merchant === "IKEA" && r.product.price.amountMinor <= 15000));
  assert.ok(results.some((r) => r.fits && r.placement));
  assert.deepEqual(plan, before);
  assert.match(LOCAL_SHOPPING_NOTICE, /not been rechecked/);
  assert.match(LOCAL_SHOPPING_NOTICE, /preview basket/i);
});

test("invalid and off-floor points never produce fitting results or successful commits", () => {
  const plan = prepareLocalShoppingPlan(sourcePlan());
  for (const position of [[NaN, 0, 1], [1, Infinity, 1]]) {
    assert.deepEqual(searchLocalProducts(plan, { category: "chair", spot: { position } }), []);
    assert.equal(commitLocalProduct(plan, catalog.products[0].id, { position }, plan.revision).ok, false);
  }
  const outside = { position: [80, 0, 80] };
  assert.ok(searchLocalProducts(plan, { category: "chair", spot: outside }).every((r) => !r.fits));
  assert.equal(commitLocalProduct(plan, catalog.products[0].id, outside, plan.revision).ok, false);
});

test("commit recomputes fit, adds only a purchase, increments local revision and derives subtotal", () => {
  const plan = prepareLocalShoppingPlan(sourcePlan()), before = structuredClone(plan);
  const chosen = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits);
  const result = commitLocalProduct(plan, chosen.product.id, spot, plan.revision);
  assert.equal(result.ok, true);
  assert.equal(result.plan.revision, plan.revision + 1);
  assert.deepEqual(plan, before);
  assert.deepEqual(result.plan.items.slice(0, plan.items.length), plan.items);
  assert.deepEqual(result.plan.geometry, plan.geometry);
  const added = result.plan.items.at(-1);
  assert.equal(added.productId, chosen.product.id);
  assert.equal(added.origin, "proposed_purchase");
  assert.deepEqual(added.dimensions, chosen.product.dimensions);
  assert.equal(localShoppingCost(result.plan).knownSubtotal.amountMinor, chosen.product.price.amountMinor);
  assert.equal(localShoppingCost(result.plan).feesKnown, false);
  const removed = applyChanges(result.plan, [{ kind: "remove", itemId: added.id }]);
  assert.equal(localShoppingCost(removed).knownSubtotal.amountMinor, 0);
});

test("stale revisions, changed floor occupancy, missing products and exceeded budgets are refused", () => {
  const plan = prepareLocalShoppingPlan(sourcePlan());
  const chosen = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits);
  assert.deepEqual(commitLocalProduct(plan, chosen.product.id, spot, 99), { ok: false, reason: "stale_revision", currentRevision: 0 });
  assert.equal(commitLocalProduct(plan, "does-not-exist", spot, 0).ok, false);
  const crowded = structuredClone(plan);
  crowded.items.push({ ...crowded.items[0], id: "new-obstacle", position: [6, 0, 5], dimensions: [4, 1, 4] });
  assert.equal(commitLocalProduct(crowded, chosen.product.id, spot, 0).ok, false);
  const capped = structuredClone(plan);
  capped.constraints.budget = { currency: "USD", amountMinor: 1 };
  assert.equal(searchLocalProducts(capped, { category: "chair", spot })[0].withinBudget, false);
  const overBudget = commitLocalProduct(capped, chosen.product.id, spot, 0);
  assert.equal(overBudget.ok, false);
  assert.ok(overBudget.validations.some((v) => v.rule === "budget" && v.status === "fail"));
});

test("preexisting scan overlaps do not freeze unrelated valid additions", () => {
  const source = sourcePlan();
  source.items.push({ ...structuredClone(source.items[0]), id: "scan-overlap" });
  const plan = prepareLocalShoppingPlan(source);
  const chosen = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits);
  assert.equal(commitLocalProduct(plan, chosen.product.id, spot, plan.revision).ok, true);
});

test("actual reconstruction request importer can feed catalog preview without source reclassification", () => {
  const request = JSON.parse(readFileSync(new URL("../../reconstruction/fixtures/living-room.request.json", import.meta.url), "utf8"));
  const source = parseRoomImport(JSON.stringify(request));
  const plan = prepareLocalShoppingPlan(source);
  assert.deepEqual(plan.items, source.items);
  assert.deepEqual(plan.geometry, source.geometry);
  assert.ok(plan.products.length > 0);
});

test("a repeated confirm is stale, and retry at the current revision rechecks occupied space", () => {
  const plan = prepareLocalShoppingPlan(sourcePlan()), before = structuredClone(plan);
  const chosen = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits);
  const first = commitLocalProduct(plan, chosen.product.id, spot, 0);
  assert.equal(first.ok, true);
  const accepted = structuredClone(first.plan);
  assert.deepEqual(commitLocalProduct(first.plan, chosen.product.id, spot, 0), { ok: false, reason: "stale_revision", currentRevision: 1 });
  const retry = commitLocalProduct(first.plan, chosen.product.id, spot, 1);
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "validation_failed");
  assert.deepEqual(first.plan, accepted);
  assert.deepEqual(plan, before);
  assert.equal(first.plan.items.filter((item) => item.origin === "proposed_purchase").length, 1);
});

test("successive independent placements keep unique IDs, source ownership and cumulative cost", () => {
  const source = sourcePlan(), before = structuredClone(source);
  let plan = prepareLocalShoppingPlan(source);
  const pickedIds = [];
  let subtotal = 0;
  for (const position of [[4, 0, 3], [7, 0, 3], [9, 0, 7]]) {
    const currentSpot = { position, rotationY: 0 };
    const chosen = searchLocalProducts(plan, { category: "chair", spot: currentSpot }).find((r) => r.fits);
    assert.ok(chosen);
    const accepted = commitLocalProduct(plan, chosen.product.id, currentSpot, plan.revision);
    assert.equal(accepted.ok, true);
    plan = accepted.plan;
    pickedIds.push(plan.items.at(-1).id);
    subtotal += chosen.product.price.amountMinor;
    assert.deepEqual(plan.items[0], source.items[0]);
    assert.deepEqual(plan.geometry, source.geometry);
    assert.equal(localShoppingCost(plan).knownSubtotal.amountMinor, subtotal);
  }
  assert.equal(new Set(pickedIds).size, 3);
  assert.equal(plan.revision, 3);
  assert.deepEqual(source, before);
});

test("a result card cannot resurrect a removed catalog product or obsolete dimensions/price", () => {
  const plan = prepareLocalShoppingPlan(sourcePlan());
  const preview = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits);
  for (const change of [
    (p) => { p.products = p.products.filter((product) => product.id !== preview.product.id); },
    (p) => { p.products.find((product) => product.id === preview.product.id).price = null; },
    (p) => { p.products.find((product) => product.id === preview.product.id).dimensions = null; },
    (p) => { p.products.find((product) => product.id === preview.product.id).availability = "unavailable"; },
    (p) => { p.products.find((product) => product.id === preview.product.id).dimensions = [30, 1, 30]; },
  ]) {
    const changed = structuredClone(plan);
    change(changed);
    const before = structuredClone(changed);
    assert.equal(commitLocalProduct(changed, preview.product.id, spot, changed.revision).ok, false);
    assert.deepEqual(changed, before);
  }
  assert.equal(preview.fits, true);
});

test("changed observed price is used at commit and can newly fail the room budget", () => {
  const plan = prepareLocalShoppingPlan(sourcePlan());
  const preview = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits);
  const changed = structuredClone(plan);
  const product = changed.products.find((p) => p.id === preview.product.id);
  product.price.amountMinor += 2500;
  changed.constraints.budget = { currency: "USD", amountMinor: product.price.amountMinor - 1 };
  const refused = commitLocalProduct(changed, product.id, spot, changed.revision);
  assert.equal(refused.ok, false);
  assert.ok(refused.validations.some((v) => v.rule === "budget" && v.status === "fail"));
  changed.constraints.budget.amountMinor++;
  const accepted = commitLocalProduct(changed, product.id, spot, changed.revision);
  assert.equal(accepted.ok, true);
  assert.equal(localShoppingCost(accepted.plan).knownSubtotal.amountMinor, product.price.amountMinor);
  assert.notEqual(product.price.amountMinor, preview.product.price.amountMinor);
});

test("unknown stock remains unknown in catalog preview and canonical validation", () => {
  const plan = prepareLocalShoppingPlan(sourcePlan());
  const chosen = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits);
  plan.products = [structuredClone(chosen.product)];
  plan.products[0].availability = "unknown";
  const [result] = searchLocalProducts(plan, { category: "chair", spot });
  assert.equal(result.fits, true); // Geometry can fit without a stock claim.
  assert.equal(result.product.availability, "unknown");
  assert.ok(result.problems.some((message) => /Stock was not established/.test(message)));
  const accepted = commitLocalProduct(plan, chosen.product.id, spot, plan.revision);
  assert.equal(accepted.ok, true); // This is a local preview, never an order.
  assert.equal(validate(accepted.plan).find((v) => v.rule === "product_known").status, "unknown");
  assert.match(LOCAL_SHOPPING_NOTICE, /not been rechecked/);
});

test("an unknown budget stays unknown and stock/price updates do not mutate the source catalog", () => {
  const source = sourcePlan(), plan = prepareLocalShoppingPlan(source);
  const result = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits);
  assert.equal(result.withinBudget, null);
  assert.equal(result.overBudgetUsd, null);
  plan.products[0].price.amountMinor = 1;
  plan.products[0].availability = "unknown";
  const fresh = prepareLocalShoppingPlan(source);
  assert.deepEqual(fresh.products, catalog.products);
  assert.deepEqual(source.products, []);
});

test("frozen 28-item source and repeated evidence conflicts remain independent from shopping state", () => {
  const source = sourcePlan();
  source.items = Array.from({ length: 28 }, (_, index) => ({ ...structuredClone(source.items[0]), id: `scan-${index}` }));
  source.evidence.push({ ...source.evidence[0], id: catalog.evidence[0].id, claim: "Private evidence occupying the catalog ID" });
  source.evidence.push({ ...source.evidence[0], id: `local_catalog_1_${catalog.evidence[0].id}`, claim: "Another private collision" });
  source.products.push({ ...structuredClone(catalog.products[0]), label: "Private product occupying the catalog ID" });
  const before = structuredClone(source);
  const freeze = (value) => { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); return Object.freeze(value); };
  freeze(source);
  const plan = prepareLocalShoppingPlan(source);
  const imported = plan.products.find((p) => p.label === catalog.products[0].label);
  assert.equal(imported.evidenceIds[0], `local_catalog_2_${catalog.evidence[0].id}`);
  assert.deepEqual(plan.items, before.items);
  assert.deepEqual(plan.evidence.slice(0, source.evidence.length), before.evidence);
  assert.deepEqual(prepareLocalShoppingPlan(plan), plan);
  const selected = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits);
  assert.ok(selected);
  const accepted = commitLocalProduct(plan, selected.product.id, spot, 0);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.plan.items.slice(0, 28), before.items);
  assert.deepEqual(source, before);
});

test("a failed competing placement near source collisions does not block a free location", () => {
  const source = sourcePlan();
  source.items.push({ ...structuredClone(source.items[0]), id: "preexisting-overlap" });
  const plan = prepareLocalShoppingPlan(source);
  const chosen = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits);
  const failed = commitLocalProduct(plan, chosen.product.id, { position: [1, 0, 1], rotationY: 0 }, 0);
  assert.equal(failed.ok, false);
  const accepted = commitLocalProduct(plan, chosen.product.id, spot, 0);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.plan.items.slice(0, 2), source.items);
});

test("removing a local purchase reduces cost, frees its footprint and preserves the source", () => {
  const source = sourcePlan(), plan = prepareLocalShoppingPlan(source);
  const chosen = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits);
  const added = commitLocalProduct(plan, chosen.product.id, spot, 0);
  assert.equal(added.ok, true);
  const itemId = added.plan.items.at(-1).id, before = structuredClone(added.plan);
  const removed = removeLocalPurchase(added.plan, itemId, 1);
  assert.equal(removed.ok, true);
  assert.equal(removed.plan.revision, 2);
  assert.deepEqual(removed.plan.items, source.items);
  assert.equal(localShoppingCost(removed.plan).knownSubtotal.amountMinor, 0);
  assert.deepEqual(added.plan, before);
  assert.deepEqual(removed.plan.geometry, source.geometry);
  assert.deepEqual(removed.plan.evidence, added.plan.evidence);
  assert.equal(commitLocalProduct(removed.plan, chosen.product.id, spot, 2).ok, true);
});

test("basket removal refuses stale revisions, missing IDs, owned furniture and locked purchases", () => {
  const plan = prepareLocalShoppingPlan(sourcePlan()), before = structuredClone(plan);
  assert.deepEqual(removeLocalPurchase(plan, "owned", 9), { ok: false, reason: "stale_revision", currentRevision: 0 });
  assert.equal(removeLocalPurchase(plan, "owned", 0).ok, false);
  plan.items[0].locked = false;
  assert.equal(removeLocalPurchase(plan, "owned", 0).ok, false);
  plan.items[0].locked = true;
  assert.equal(removeLocalPurchase(plan, "missing", 0).ok, false);
  assert.deepEqual(plan, before);
  const chosen = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits);
  const added = commitLocalProduct(plan, chosen.product.id, spot, 0);
  assert.equal(added.ok, true);
  const purchase = added.plan.items.at(-1);
  purchase.locked = true;
  const locked = removeLocalPurchase(added.plan, purchase.id, 1);
  assert.equal(locked.ok, false);
  assert.ok(locked.validations.some((v) => v.rule === "locked_kept" && v.status === "fail"));
  assert.equal(added.plan.items.at(-1).id, purchase.id);
});

test("removal respects seating rules and cannot silently remove the required last seat", () => {
  const plan = prepareLocalShoppingPlan(sourcePlan());
  const chosen = searchLocalProducts(plan, { category: "chair", spot }).find((r) => r.fits && r.product.seats > 0);
  const added = commitLocalProduct(plan, chosen.product.id, spot, 0);
  assert.equal(added.ok, true);
  added.plan.constraints.minimumSeats = chosen.product.seats;
  const removed = removeLocalPurchase(added.plan, added.plan.items.at(-1).id, 1);
  assert.equal(removed.ok, false);
  assert.ok(removed.validations.some((v) => v.rule === "seats" && v.status === "fail"));
});
