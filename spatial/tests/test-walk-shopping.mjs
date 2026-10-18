import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { validateWalkProduct } from "../room/walk-shopping.ts";
const catalog = JSON.parse(readFileSync(new URL("../../backend/fixtures/real-catalog.json", import.meta.url), "utf8"));
const product = catalog.products.find((entry) => entry.dimensions && entry.price && entry.availability !== "unavailable");
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

test("product validation is pure and accepts a fitting observed product", () => {
  const plan = sourcePlan(), before = structuredClone(plan);
  validateWalkProduct(plan, product, [6, 0, 5], 0);
  assert.deepEqual(plan, before);
});
test("rejects unknown size, unavailable stock, overspending, off-floor and overlap", () => {
  const plan = sourcePlan();
  assert.throws(() => validateWalkProduct(plan, { ...product, dimensions: null }, [6, 0, 5], 0), /dimensions/);
  assert.throws(() => validateWalkProduct(plan, { ...product, availability: "unavailable" }, [6, 0, 5], 0), /unavailable/);
  plan.constraints.budget = { currency: product.price.currency, amountMinor: 1 };
  assert.throws(() => validateWalkProduct(plan, product, [6, 0, 5], 0), /cap|over/);
  plan.constraints.budget = null;
  assert.throws(() => validateWalkProduct(plan, product, [-10, 0, 5], 0), /floor|outside|room|walls/i);
  assert.throws(() => validateWalkProduct(plan, product, [1, 0, 1], 0), /tight|overlap/i);
});
test("validates swaps before any old item removal, respecting locked pieces and other obstacles", () => {
  const plan = sourcePlan(); plan.items[0].locked = false;
  const replacement = { ...product, dimensions: [1, .8, .6] };
  const before = structuredClone(plan);
  validateWalkProduct(plan, replacement, [1, .1, 1], .2, "owned");
  assert.deepEqual(plan, before);
  plan.items[0].locked = true;
  assert.throws(() => validateWalkProduct(plan, replacement, [1, .1, 1], .2, "owned"), /unlocked/);
  plan.items[0].locked = false;
  plan.items.push({ ...structuredClone(plan.items[0]), id: "neighbor", position: [2, .1, 1] });
  assert.throws(() => validateWalkProduct(plan, { ...replacement, dimensions: [4, 1, 2] }, [1, .1, 1], 0, "owned"), /tight|overlap|room/i);
  assert.equal(plan.items[0].id, "owned");
});
test("confirmation recheck catches a placement that became occupied after preview", () => {
  const plan = sourcePlan(); validateWalkProduct(plan, product, [6, 0, 5], 0);
  plan.items.push({ ...structuredClone(plan.items[0]), id: "moved", position: [6, 0, 5] });
  assert.throws(() => validateWalkProduct(plan, product, [6, 0, 5], 0), /tight|overlap/i);
});
