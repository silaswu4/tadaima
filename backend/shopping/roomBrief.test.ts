import assert from "node:assert/strict";
import { test } from "node:test";
import { demoPlan } from "@/backend/fixtures/demo-room";
import { applyChanges } from "@/backend/plan/rules";
import { fitCheck, shoppingBrief } from "@/backend/shopping/roomBrief";

test("brief measures the free space, money left and seats needed at the armchair", () => {
  const b = shoppingBrief(demoPlan, { itemId: "item_armchair" });
  assert.ok(b.space.maxWidthM! > 0.9 && b.space.maxWidthM! < 1.2, `width ${b.space.maxWidthM}`);
  assert.equal(b.seatsRequired, 1);
  // $1,500 cap minus everything except the $399 armchair being replaced
  assert.equal(b.budget.maxPriceUsd, 501.03);
  assert.match(b.text, /Your sofa/);
});

test("brief follows the live plan: a bigger budget means more to spend", () => {
  const richer = applyChanges(demoPlan, [{ kind: "set_constraints", constraints: { budget: { amountMinor: 250000, currency: "USD" } } }]);
  assert.equal(shoppingBrief(richer, { itemId: "item_armchair" }).budget.maxPriceUsd, 1501.03);
});

test("fit check accepts armchairs and rejects loveseats that crowd the sofa", () => {
  const seating = demoPlan.products.filter((p) => p.category === "chair" || p.category === "sofa");
  const results = fitCheck(demoPlan, "item_armchair", seating);
  assert.ok(results.filter((r) => r.product.category === "chair").every((r) => r.fits));
  assert.ok(results.filter((r) => r.product.category === "sofa").every((r) => !r.fits));
});

test("brief for an empty spot uses a probe", () => {
  const b = shoppingBrief(demoPlan, { category: "table", position: [1.0, 0, 1.4] });
  assert.equal(b.replacingItemId, null);
  assert.ok(b.space.maxWidthM! > 1);
});
