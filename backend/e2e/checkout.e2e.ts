/**
 * Checkout rules end to end. The payment path needs Stripe test keys on the
 * server; without them those tests skip themselves (503).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { api, newProjectId } from "@/backend/e2e/client";

const fresh = async () => {
  const a = api(newProjectId());
  await a.reset();
  return a;
};

describe("cart and recheck", () => {
  test("cart mirrors the plan's purchases and starts blocked", async () => {
    const a = await fresh();
    const { status, json } = await a.checkout();
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.cart.subtotal.amountMinor, 139797);
    assert.deepEqual(json.cart.merchants.map((g) => g.merchant), ["IKEA"]);
    assert.equal(json.cart.merchants[0].lines.length, 5);
    assert.ok(json.blockers.some((b) => b.includes("recheck")));
    assert.equal(json.mandate, null);
  });

  test("live recheck verifies every IKEA line", { timeout: 60_000 }, async () => {
    const a = await fresh();
    const { json } = await a.recheck();
    assert.ok(json.recheck, JSON.stringify(json));
    assert.equal(json.recheck!.lines.length, 5);
    for (const l of json.recheck!.lines) assert.ok(["ok", "price_changed"].includes(l.status), `${l.label}: ${l.status} ${l.note}`);
    assert.equal(json.recheck!.cartDigest, json.cart.digest, "recheck matches the cart as it now stands");
    assert.ok(!json.blockers.some((b) => b.includes("recheck")));
  });

  test("changing the room changes the cart digest and voids the recheck", { timeout: 60_000 }, async () => {
    const a = await fresh();
    const before = (await a.recheck()).json;
    const lamp = before.cart.merchants[0].lines.find((l) => l.label.includes("SIMRISHAMN"))!;
    const plan = (await a.get()).json.plan;
    const other = plan.products.find((p) => p.category === "lamp" && p.id !== lamp.productId && p.dimensions && p.availability === "available")!;
    const r = await a.change(plan.revision, [{ kind: "replace", itemId: "item_lamp", productId: other.id }]);
    assert.ok(r.json.ok, JSON.stringify(r.json));
    const after = (await a.checkout()).json;
    assert.notEqual(after.cart.digest, before.cart.digest);
    assert.equal(after.recheck, null);
  });
});

describe("refusals without approval", () => {
  test("the agent can't pay with nothing approved", async () => {
    const a = await fresh();
    const r = await a.execute();
    assert.equal(r.status, 409);
    assert.match(r.json.error!, /approv/);
  });

  test("approving a cart you weren't shown is refused", async () => {
    const a = await fresh();
    const r = await a.approve("not-the-digest", "pm_whatever");
    assert.equal(r.status, 409);
    assert.match(r.json.error!, /changed/);
  });
});

describe("paying (stripe test mode)", () => {
  test("recheck, connect test Visa, approve, agent pays once, then can't pay again", { timeout: 90_000 }, async (t) => {
    const a = await fresh();
    const card = await a.testCard();
    if (card.status === 503) return t.skip(`payments not configured: ${card.json.error}`);
    assert.equal(card.status, 200, JSON.stringify(card.json));
    assert.equal(card.json.last4, "4242");

    const view = (await a.recheck()).json;
    assert.deepEqual(view.blockers, [], JSON.stringify(view.blockers));
    const m = await a.approve(view.cart.digest, card.json.id);
    assert.equal(m.status, 200, JSON.stringify(m.json));
    assert.equal(m.json.maxAmount.amountMinor, view.cart.subtotal.amountMinor);

    const order = await a.execute();
    assert.equal(order.status, 200, JSON.stringify(order.json));
    assert.equal(order.json.payment.status, "succeeded");
    assert.ok(order.json.payment.paymentIntentId.startsWith("pi_"));
    assert.equal(order.json.testMode, true);
    assert.ok(order.json.merchantOrders.every((o) => o.status === "simulated"));

    const again = await a.execute();
    assert.equal(again.status, 409, "mandate is single use");
    assert.equal((await a.checkout()).json.orders.length, 1);
  });

  test("a cart change after approval blocks the agent", { timeout: 90_000 }, async (t) => {
    const a = await fresh();
    const card = await a.testCard();
    if (card.status === 503) return t.skip("payments not configured");
    const view = (await a.recheck()).json;
    assert.equal((await a.approve(view.cart.digest, card.json.id)).status, 200);

    const plan = (await a.get()).json.plan;
    const cheaper = plan.products.find((p) => p.id.includes("tagarp"))!;
    assert.ok((await a.change(plan.revision, [{ kind: "replace", itemId: "item_lamp", productId: cheaper.id }])).json.ok);

    const r = await a.execute();
    assert.equal(r.status, 409);
    assert.match(r.json.error!, /changed after it was approved/);
    assert.equal((await a.checkout()).json.orders.length, 0, "nothing charged");
  });
});
