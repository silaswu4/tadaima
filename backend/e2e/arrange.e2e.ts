/**
 * Hands-on rearranging against a running server: carry pieces around (drop
 * at a dragCheck pose), put them away in inventory, bring them back.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { api, failing, newProjectId } from "@/backend/e2e/client";
import { dragCheck, dropChange } from "@/backend/shopping/drag";

const fresh = async () => {
  const a = api(newProjectId());
  assert.equal((await a.reset()).status, 200);
  return a;
};

describe("arranging by hand", () => {
  test("carry the armchair: the pose dragCheck shows is the pose the server accepts", async () => {
    const a = await fresh();
    const { plan } = (await a.get()).json;
    const chair = plan.items.find((i) => i.id === "item_armchair")!;
    const d = dragCheck(plan, chair.id, [3.6, 0, 1.3], chair.rotationY);
    assert.ok(d.droppable, d.problems.join());
    const r = await a.change(plan.revision, [dropChange(chair, d.pose)]);
    assert.ok(r.json.ok, JSON.stringify(r.json));
    const moved = (await a.get()).json.plan.items.find((i) => i.id === chair.id)!;
    assert.deepEqual(moved.position, d.pose.position);
  });

  test("a drop the browser thinks is red is refused by the server too", async () => {
    const a = await fresh();
    const { plan } = (await a.get()).json;
    const d = dragCheck(plan, "item_lamp", [2.5, 0, 3.7], 0);
    assert.equal(d.droppable, false);
    const r = await a.change(plan.revision, [{ kind: "move", itemId: "item_lamp", position: [2.5, 0, 3.7], rotationY: 0 }]);
    assert.ok(!r.json.ok && r.json.reason === "validation_failed");
  });

  test("put the lamp away: off the floor, out of the cart; bring it back: in again", async () => {
    const a = await fresh();
    const before = (await a.checkout()).json.cart;
    const r = await a.store("item_lamp");
    assert.ok(r.json.ok, JSON.stringify(r.json));
    const after = (await a.checkout()).json.cart;
    assert.equal(after.subtotal.amountMinor, before.subtotal.amountMinor - 19999);
    const view = (await a.get()).json;
    assert.equal(view.plan.items.find((i) => i.id === "item_lamp")!.stored, true);
    assert.deepEqual(failing(view.validations), []);

    const again = await a.store("item_lamp");
    assert.ok(again.json.ok, "putting away twice is a no-op");
    assert.equal((await a.get()).json.plan.revision, view.plan.revision);

    const back = await a.moveTo("item_lamp", { position: [0.4, 0, 2.0] });
    assert.ok(back.json.ok, JSON.stringify(back.json));
    assert.equal((await a.checkout()).json.cart.digest, before.digest, "same cart as before");
  });

  test("put the armchair away: allowed, seats check reports 3 of 4, and the room is still editable", async () => {
    const a = await fresh();
    assert.ok((await a.store("item_armchair")).json.ok);
    const view = (await a.get()).json;
    assert.ok(failing(view.validations).some((v) => v.rule === "seats"));
    const moved = await a.change(view.plan.revision, [{ kind: "move", itemId: "item_lamp", position: [0.4, 0, 2.0], rotationY: 0 }]);
    assert.ok(moved.json.ok, "an unrelated move still goes through: " + JSON.stringify(moved.json));
  });

  test("locked sofa: refused without unlock, stays locked when put away with it, and comes back out locked", async () => {
    const a = await fresh();
    const refused = await a.store("item_sofa");
    assert.ok(!refused.json.ok && refused.json.reason === "locked");
    const ok = await a.store("item_sofa", true);
    assert.ok(ok.json.ok, JSON.stringify(ok.json));
    let sofa = (await a.get()).json.plan.items.find((i) => i.id === "item_sofa")!;
    assert.ok(sofa.stored && sofa.locked);
    const back = await a.moveTo("item_sofa", { position: [2.5, 0, 3.8] }, true);
    assert.ok(back.json.ok, JSON.stringify(back.json));
    sofa = (await a.get()).json.plan.items.find((i) => i.id === "item_sofa")!;
    assert.ok(!sofa.stored && sofa.locked);
  });

  test("raw store/take_out through /changes, and the bad cases", async () => {
    const a = await fresh();
    let { plan } = (await a.get()).json;
    assert.ok((await a.change(plan.revision, [{ kind: "store", itemId: "item_rug" }])).json.ok);
    ({ plan } = (await a.get()).json);
    const notStored = await a.change(plan.revision, [{ kind: "take_out", itemId: "item_lamp", position: [1, 0, 2], rotationY: 0 }]);
    assert.ok(!notStored.json.ok, "the lamp is on the floor already");
    const ok = await a.change(plan.revision, [{ kind: "take_out", itemId: "item_rug", position: [2.5, 0, 2.6], rotationY: Math.PI / 2 }]);
    assert.ok(ok.json.ok, JSON.stringify(ok.json));
    assert.equal((await a.store("item_ghost")).status, 404);
    assert.equal((await a.change(plan.revision, [{ kind: "store" }])).status, 400);
  });

  test("put away and carry at the same moment from two devices: exactly one wins, nothing is lost", async () => {
    const a = await fresh();
    const { plan } = (await a.get()).json;
    const [x, y] = await Promise.all([
      a.change(plan.revision, [{ kind: "store", itemId: "item_lamp" }]),
      a.change(plan.revision, [{ kind: "move", itemId: "item_lamp", position: [0.4, 0, 2.0], rotationY: 0 }]),
    ]);
    assert.equal([x, y].filter((r) => r.json.ok).length, 1);
    const view = (await a.get()).json;
    assert.equal(view.plan.revision, plan.revision + 1);
    assert.ok(view.plan.items.some((i) => i.id === "item_lamp"));
  });
});
