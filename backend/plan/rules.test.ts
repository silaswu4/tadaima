import assert from "node:assert/strict";
import { test } from "node:test";
import { demoPlan } from "@/backend/fixtures/demo-room";
import { applyChanges, costOf, passes, validate } from "@/backend/plan/rules";

const status = (plan = demoPlan, base = demoPlan) => Object.fromEntries(validate(plan, base).map((r) => [r.rule, r.status]));

test("fixture plan passes every rule", () => {
  const r = validate(demoPlan, demoPlan);
  assert.ok(passes(r), JSON.stringify(r.filter((x) => x.status !== "pass"), null, 2));
  assert.equal(costOf(demoPlan).knownSubtotal.amountMinor, 172500);
});

test("$300 cheaper by swapping the armchair keeps 4 seats", () => {
  const next = applyChanges(demoPlan, [{ kind: "replace", itemId: "item_armchair", productId: "prod_armchair_cane" }]);
  assert.ok(passes(validate(next, demoPlan)));
  assert.equal(costOf(demoPlan).knownSubtotal.amountMinor - costOf(next).knownSubtotal.amountMinor, 30000);
});

test("dropping the armchair breaks seating", () => {
  assert.equal(status(applyChanges(demoPlan, [{ kind: "remove", itemId: "item_armchair" }])).seats, "fail");
});

test("touching a locked item fails", () => {
  assert.equal(status(applyChanges(demoPlan, [{ kind: "move", itemId: "item_sofa", position: [2.4, 0, 3.7], rotationY: Math.PI }])).locked_kept, "fail");
});

test("unknown dimensions never pass fit", () => {
  const s = status(applyChanges(demoPlan, [{ kind: "replace", itemId: "item_armchair", productId: "prod_ottoman_mystery" }]));
  assert.equal(s.dimensions_known, "unknown");
  assert.equal(s.no_overlap, "unknown");
});

test("unavailable product fails", () => {
  assert.equal(status(applyChanges(demoPlan, [{ kind: "replace", itemId: "item_coffee_table", productId: "prod_table_marble" }])).product_known, "fail");
});

test("sliding the armchair into the sofa is too tight", () => {
  assert.equal(status(applyChanges(demoPlan, [{ kind: "move", itemId: "item_armchair", position: [3.6, 0, 3.4], rotationY: -Math.PI / 2 }])).no_overlap, "fail");
});

test("pushing an item through a wall fails", () => {
  assert.equal(status(applyChanges(demoPlan, [{ kind: "move", itemId: "item_shelf", position: [4.5, 0, 0.05], rotationY: 0 }])).in_room, "fail");
});

test("over budget fails", () => {
  const next = applyChanges(demoPlan, [{ kind: "replace", itemId: "item_armchair", productId: "prod_armchair_boucle" }, { kind: "set_constraints", constraints: { budget: { amountMinor: 150000, currency: "USD" } } }]);
  assert.equal(status(next).budget, "fail");
});
