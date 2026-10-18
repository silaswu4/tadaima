import assert from "node:assert/strict";
import { test } from "node:test";
import { demoPlan } from "@/backend/fixtures/demo-room";
import { applyChanges, costOf, passes, validate } from "@/backend/plan/rules";

const status = (plan = demoPlan, base = demoPlan) => Object.fromEntries(validate(plan, base).map((r) => [r.rule, r.status]));

const id = (fragment: string) => demoPlan.products.find((p) => p.id.includes(fragment))!.id;

test("fixture plan passes every rule", () => {
  const r = validate(demoPlan, demoPlan);
  assert.ok(passes(r), JSON.stringify(r.filter((x) => x.status !== "pass"), null, 2));
  assert.equal(costOf(demoPlan).knownSubtotal.amountMinor, 139797);
});

test("$300+ cheaper with real IKEA swaps keeps 4 seats", () => {
  const next = applyChanges(demoPlan, [
    { kind: "replace", itemId: "item_armchair", productId: id("poaeng") },
    { kind: "replace", itemId: "item_coffee_table", productId: id("holmerud") },
  ]);
  const r = validate(next, demoPlan);
  assert.ok(passes(r), JSON.stringify(r.filter((x) => x.status !== "pass"), null, 2));
  assert.ok(costOf(demoPlan).knownSubtotal.amountMinor - costOf(next).knownSubtotal.amountMinor >= 30000);
});

test("dropping the armchair breaks seating", () => {
  assert.equal(status(applyChanges(demoPlan, [{ kind: "remove", itemId: "item_armchair" }])).seats, "fail");
});

test("touching a locked item fails", () => {
  assert.equal(status(applyChanges(demoPlan, [{ kind: "move", itemId: "item_sofa", position: [2.4, 0, 3.7], rotationY: Math.PI }])).locked_kept, "fail");
});

test("unknown dimensions never pass fit", () => {
  const s = status(applyChanges(demoPlan, [{ kind: "replace", itemId: "item_lamp", productId: id("isjakt") }]));
  assert.equal(s.dimensions_known, "unknown");
  assert.equal(s.no_overlap, "unknown");
});

test("unavailable product fails", () => {
  assert.equal(status(applyChanges(demoPlan, [{ kind: "replace", itemId: "item_rug", productId: id("tidtabell") }])).product_known, "fail");
});

test("sliding the armchair into the sofa is too tight", () => {
  assert.equal(status(applyChanges(demoPlan, [{ kind: "move", itemId: "item_armchair", position: [3.6, 0, 3.4], rotationY: -Math.PI / 2 }])).no_overlap, "fail");
});

test("pushing an item through a wall fails", () => {
  assert.equal(status(applyChanges(demoPlan, [{ kind: "move", itemId: "item_shelf", position: [4.5, 0, 0.05], rotationY: 0 }])).in_room, "fail");
});

test("over budget fails", () => {
  const next = applyChanges(demoPlan, [{ kind: "set_constraints", constraints: { budget: { amountMinor: 100000, currency: "USD" } } }]);
  assert.equal(status(next).budget, "fail");
});
