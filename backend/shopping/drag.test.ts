import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PlanChange, RoomPlan, Vector3Meters } from "@/backend/contracts";
import { cartOf } from "@/backend/checkout/cart";
import { demoPlan } from "@/backend/fixtures/demo-room";
import { applyChanges, blocking, costOf, validate, validateChanges } from "@/backend/plan/rules";
import { dragCheck, dropChange, inventory, turned } from "@/backend/shopping/drag";
import { placeAt } from "@/backend/shopping/placement";

const at = (x: number, z: number): Vector3Meters => [x, 0, z];
const lamp = demoPlan.items.find((i) => i.id === "item_lamp")!;
const chair = demoPlan.items.find((i) => i.id === "item_armchair")!;
/** What the server would do with these changes: blocked failures, empty means saved. */
const gate = (base: RoomPlan, changes: PlanChange[]) => {
  const next = applyChanges(base, changes);
  return { next, blocked: blocking(base, changes, next, validateChanges(base, changes, next)) };
};

describe("dragCheck", () => {
  test("holding a piece in open floor: fits, no snap, droppable", () => {
    const d = dragCheck(demoPlan, "item_lamp", at(1.0, 2.0), 0);
    assert.ok(d.fits && d.droppable && !d.snapped);
    assert.deepEqual(d.pose.position, [1, 0, 2]);
  });

  test("holding it against the sofa: red with the reason, snaps clear if close", () => {
    const d = dragCheck(demoPlan, "item_lamp", at(1.6, 3.4), 0);
    assert.equal(d.fits, false);
    assert.ok(d.problems.some((p) => /^Bumps into .*Your sofa/.test(p)), d.problems.join());
    if (d.droppable) {
      assert.ok(d.snapped);
      const g = gate(demoPlan, [dropChange(lamp, d.pose)]);
      assert.deepEqual(g.blocked, [], "a snapped pose really drops");
    }
  });

  test("deep inside another piece or through a wall: not droppable", () => {
    assert.equal(dragCheck(demoPlan, "item_lamp", at(2.5, 3.7), 0).droppable, false);
    const wall = dragCheck(demoPlan, "item_shelf", at(4.5, -0.3), 0);
    assert.equal(wall.droppable, false);
    assert.ok(wall.problems.length > 0);
  });

  test("never changes facing while held", () => {
    for (const [x, z] of [[1.6, 3.4], [3.0, 0.3], [4.6, 1.1]]) {
      const d = dragCheck(demoPlan, "item_armchair", at(x, z), Math.PI / 2);
      assert.equal(d.pose.rotationY, Math.PI / 2);
    }
  });

  test("a piece doesn't block itself: holding it where it is fits", () => {
    const d = dragCheck(demoPlan, "item_armchair", chair.position, chair.rotationY);
    assert.ok(d.fits);
  });

  test("every droppable pose on a sweep passes the server's gate", () => {
    let drops = 0;
    for (let x = 0; x <= 5; x += 0.35) {
      for (let z = 0; z <= 4.2; z += 0.35) {
        const d = dragCheck(demoPlan, "item_armchair", at(x, z), turned(chair.rotationY, Math.round(x + z)));
        if (!d.droppable) continue;
        drops++;
        assert.deepEqual(gate(demoPlan, [dropChange(chair, d.pose)]).blocked, [], `drop at ${x},${z}`);
      }
    }
    assert.ok(drops > 20, `${drops}`);
  });

  test("turned goes a quarter at a time and wraps", () => {
    assert.equal(turned(0), Math.PI / 2);
    assert.ok(Math.abs(turned(Math.PI, 1) - -Math.PI / 2) < 1e-9);
    assert.ok(Math.abs(turned(0, 4)) < 1e-9);
  });
});

describe("inventory", () => {
  const stored = applyChanges(demoPlan, [{ kind: "store", itemId: "item_lamp" }]);

  test("a stored purchase leaves the floor, the cost and the cart", () => {
    assert.deepEqual(inventory(stored).map((i) => i.id), ["item_lamp"]);
    assert.equal(costOf(stored).knownSubtotal.amountMinor, 139797 - 19999);
    assert.ok(!cartOf(stored).merchants.flatMap((m) => m.lines).some((l) => l.productId === lamp.productId));
    assert.notEqual(cartOf(stored).digest, cartOf(demoPlan).digest);
  });

  test("a stored piece takes no floor: something can go where it was", () => {
    const r = placeAt(stored, { category: "lamp", dimensions: [0.3, 1.5, 0.3] }, { position: lamp.position });
    assert.ok(r.ok && r.placement.distanceM === 0);
  });

  test("putting the armchair away isn't blocked by seats, and the seats check still reports it", () => {
    const { next, blocked } = gate(demoPlan, [{ kind: "store", itemId: "item_armchair" }]);
    assert.deepEqual(blocked, []);
    assert.equal(validate(next).find((v) => v.rule === "seats")?.status, "fail");
  });

  test("with seats already short, other edits still go through, but removing more seats doesn't", () => {
    const short = applyChanges(demoPlan, [{ kind: "store", itemId: "item_armchair" }]);
    assert.deepEqual(gate(short, [{ kind: "move", itemId: "item_lamp", position: at(0.4, 2.0), rotationY: 0 }]).blocked, []);
    const unlockAndRemove = gate(short, [{ kind: "lock", itemId: "item_sofa", locked: false }, { kind: "remove", itemId: "item_sofa" }]);
    assert.ok(unlockAndRemove.blocked.some((v) => v.rule === "seats"));
  });

  test("over budget already (a price went up): edits that don't add cost still go through, ones that add cost don't", () => {
    const pricey: RoomPlan = { ...demoPlan, constraints: { ...demoPlan.constraints, budget: { amountMinor: 100000, currency: "USD" } } };
    assert.deepEqual(gate(pricey, [{ kind: "move", itemId: "item_lamp", position: at(0.4, 2.0), rotationY: 0 }]).blocked, []);
    const cheaperRug = demoPlan.products.find((p) => p.category === "rug" && p.price!.amountMinor < 9999 && p.availability === "available")!;
    assert.deepEqual(gate(pricey, [{ kind: "replace", itemId: "item_rug", productId: cheaperRug.id }]).blocked, [], "cheaper is fine");
    const pricierRug = demoPlan.products.find((p) => p.category === "rug" && p.price!.amountMinor > 9999 && p.availability === "available")!;
    assert.ok(gate(pricey, [{ kind: "replace", itemId: "item_rug", productId: pricierRug.id }]).blocked.some((v) => v.rule === "budget"));
  });

  test("bringing it back: take_out puts it on the floor, back in the cart, and must fit", () => {
    const back = gate(stored, [{ kind: "take_out", itemId: "item_lamp", position: at(0.4, 2.0), rotationY: 0 }]);
    assert.deepEqual(back.blocked, []);
    assert.equal(back.next.items.find((i) => i.id === "item_lamp")!.stored, false);
    assert.equal(cartOf(back.next).digest, cartOf(demoPlan).digest, "same cart as before it was put away");
    const intoSofa = gate(stored, [{ kind: "take_out", itemId: "item_lamp", position: at(2.5, 3.7), rotationY: 0 }]);
    assert.ok(intoSofa.blocked.some((v) => v.rule === "no_overlap"));
  });

  test("a locked piece can't be put away without unlocking, and stays locked after", () => {
    assert.ok(gate(demoPlan, [{ kind: "store", itemId: "item_sofa" }]).blocked.some((v) => v.rule === "locked_kept"));
    const ok = gate(demoPlan, [
      { kind: "lock", itemId: "item_desk", locked: false },
      { kind: "store", itemId: "item_desk" },
      { kind: "lock", itemId: "item_desk", locked: true },
    ]);
    assert.deepEqual(ok.blocked, []);
    const desk = ok.next.items.find((i) => i.id === "item_desk")!;
    assert.ok(desk.stored && desk.locked);
  });

  test("double store and taking out something on the floor are refused", () => {
    assert.throws(() => applyChanges(stored, [{ kind: "store", itemId: "item_lamp" }]));
    assert.throws(() => applyChanges(demoPlan, [{ kind: "take_out", itemId: "item_lamp", position: at(1, 2), rotationY: 0 }]));
  });

  test("dragging a stored piece out makes a take_out", () => {
    const d = dragCheck(stored, "item_lamp", at(1, 2), 0);
    assert.ok(d.fits);
    assert.equal(dropChange(stored.items.find((i) => i.id === "item_lamp")!, d.pose).kind, "take_out");
  });
});
