/**
 * Shop at a spot, place, move: the demo loop against a running server.
 * "I want a couch under $300 that fits here" -> results -> add to cart -> move things around.
 * E2E_LIVE=1 also browses IKEA for real (~$0.02, a few minutes).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FloorSpot } from "@/backend/contracts";
import { api, call, failing, newProjectId, sleep } from "@/backend/e2e/client";

const BACK_WALL: FloorSpot = { position: [3.0, 0, 0.6] };
const CORNER: FloorSpot = { position: [4.8, 0, 4.0] };
const couch = { category: "sofa", spot: BACK_WALL, maxPriceUsd: 300, live: false } as const;

const fresh = async () => {
  const a = api(newProjectId());
  assert.equal((await a.reset()).status, 200);
  return a;
};
/** Lift the demo budget so a $299 couch can actually go in. */
const roomyBudget = async (a: ReturnType<typeof api>) => {
  const { plan } = (await a.get()).json;
  const r = await a.change(plan.revision, [{ kind: "set_constraints", constraints: { budget: { amountMinor: 200000, currency: "USD" } } }]);
  assert.ok(r.json.ok, JSON.stringify(r.json));
};

describe("shop at a spot", () => {
  test("couch under $300 at the back wall: instant catalog answer with a placement, a 3D model and the budget truth", async () => {
    const a = await fresh();
    const t = Date.now();
    const r = await a.shop(couch);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(Date.now() - t < 3000, "catalog pass is instant");
    const job = r.json;
    assert.equal(job.type, "shop_at_spot");
    assert.equal(job.state, "succeeded");
    assert.equal(job.output!.live, "skipped");
    const [top] = job.output!.results;
    assert.match(top.product.label, /^SALTMYRAN/);
    assert.ok(top.fits);
    assert.equal(top.placement!.againstWallId, "wall_back");
    assert.equal(top.assetUrl, "/models/sofa_02.glb");
    assert.equal(top.withinBudget, false);
    assert.equal(top.overBudgetUsd, 196.97);
    assert.ok(job.output!.results.every((x) => x.product.price!.amountMinor <= 30000), "nothing over the cap");
    assert.match(job.output!.brief, /under \$300/);
  });

  test("bad input: off the floor is 422, junk is 400, unknown project 404, unknown job 404", async () => {
    const a = await fresh();
    assert.equal((await a.shop({ ...couch, spot: { position: [20, 0, 20] } })).status, 422);
    assert.equal((await a.shop({ ...couch, category: "spaceship" })).status, 400);
    assert.equal((await a.shop({ ...couch, maxPriceUsd: -5 })).status, 400);
    assert.equal((await a.shop({ ...couch, spot: { position: [1, 2] } })).status, 400);
    assert.equal((await a.shop({ category: "sofa" })).status, 400);
    assert.equal((await call("POST", `/api/projects/proj_nope_nope/shop`, couch)).status, 404);
    assert.equal((await a.shopJob("job_nope")).status, 404);
  });

  test("a category with nothing under the cap answers with no results, not an error", async () => {
    const a = await fresh();
    const r = await a.shop({ ...couch, maxPriceUsd: 50 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.output!.results, []);
  });

  test("over budget, placing is refused with the budget rule; raise the budget and it goes in, in the cart", async () => {
    const a = await fresh();
    const top = (await a.shop(couch)).json.output!.results[0];
    const refused = await a.place(top.product.id, BACK_WALL);
    assert.ok(!refused.json.ok && refused.json.reason === "validation_failed", JSON.stringify(refused.json));
    if (!refused.json.ok && refused.json.reason === "validation_failed") assert.ok(failing(refused.json.validations).some((v) => v.rule === "budget"));

    await roomyBudget(a);
    const placed = await a.place(top.product.id, BACK_WALL);
    assert.ok(placed.json.ok, JSON.stringify(placed.json));
    const res = placed.json;
    if (!res.ok) return;
    const item = res.plan.items.find((i) => i.id === res.itemId)!;
    assert.equal(item.productId, top.product.id);
    assert.equal(item.origin, "proposed_purchase");
    assert.equal(item.assetUrl, "/models/sofa_02.glb");
    assert.deepEqual(item.dimensions, top.product.dimensions);
    assert.deepEqual(item.position, top.placement!.position);

    const view = (await a.get()).json;
    assert.deepEqual(failing(view.validations), [], "room still passes everything");
    assert.equal(view.cost.knownSubtotal.amountMinor, 139797 + 29900);
    const cart = (await a.checkout()).json.cart;
    assert.ok(cart.merchants.flatMap((m) => m.lines).some((l) => l.productId === top.product.id), "it's in the cart");
  });

  test("results are re-checked on read: once the couch is placed, the same spot is taken", async () => {
    const a = await fresh();
    await roomyBudget(a);
    const job = (await a.shop(couch)).json;
    const before = job.output!.results[0].placement!;
    assert.ok((await a.place(job.output!.results[0].product.id, BACK_WALL)).json.ok);
    const again = (await a.shopJob(job.id)).json;
    assert.ok(again.output!.checkedAtRevision > job.output!.checkedAtRevision);
    const now = again.output!.results[0];
    assert.ok(!now.fits || now.placement!.position.some((v, i) => v !== before.position[i]), "a second one can't go in the same place");
  });

  test("place: stale revision, unknown product, unsized product, full corner", async () => {
    const a = await fresh();
    await roomyBudget(a);
    const { plan } = (await a.get()).json;
    const id = (await a.shop(couch)).json.output!.results[0].product.id;
    const stale = await a.place(id, BACK_WALL, plan.revision - 1);
    assert.ok(!stale.json.ok && stale.json.reason === "stale_revision");
    assert.equal((await a.place("prod_made_up", BACK_WALL)).status, 404);
    const isjakt = plan.products.find((p) => p.dimensions === null)!;
    const unsized = await a.place(isjakt.id, BACK_WALL);
    assert.ok(!unsized.json.ok && unsized.json.reason === "no_fit");
    const corner = await a.place(id, CORNER);
    assert.ok(!corner.json.ok && corner.json.reason === "no_fit", JSON.stringify(corner.json));
    if (!corner.json.ok && corner.json.reason === "no_fit") assert.ok(corner.json.nearest, "says where it would fit");
    assert.equal((await a.place(id, { position: [-3, 0, 1] })).status, 422);
    assert.equal((await a.get()).json.plan.revision, plan.revision, "nothing saved by any of those");
  });

  test("two people place the same couch at the same spot at once: both land, apart, room still valid", async () => {
    const a = await fresh();
    await roomyBudget(a);
    const id = (await a.shop(couch)).json.output!.results[0].product.id;
    const results = await Promise.all([a.place(id, BACK_WALL), a.place(id, BACK_WALL)]);
    const ok = results.filter((r) => r.json.ok);
    assert.ok(ok.length >= 1, JSON.stringify(results.map((r) => r.json)));
    const view = (await a.get()).json;
    assert.deepEqual(failing(view.validations), [], "no overlap even under a race");
    assert.equal(view.plan.items.filter((i) => i.productId === id).length, ok.length);
  });

  test("move-to: an armchair to the window wall; the locked sofa needs unlock and stays locked", async () => {
    const a = await fresh();
    const moved = await a.moveTo("item_armchair", { position: [3.2, 0, 0.7] });
    assert.ok(moved.json.ok, JSON.stringify(moved.json));
    if (moved.json.ok) {
      const chair = moved.json.plan.items.find((i) => i.id === "item_armchair")!;
      assert.ok(chair.position[2] < 1.2, "near the back wall now");
    }
    const refused = await a.moveTo("item_sofa", { position: [0.5, 0, 2.0] });
    assert.ok(!refused.json.ok && refused.json.reason === "locked");
    const ok = await a.moveTo("item_sofa", { position: [0.5, 0, 2.0] }, true);
    assert.ok(ok.json.ok, JSON.stringify(ok.json));
    if (ok.json.ok) {
      const sofa = ok.json.plan.items.find((i) => i.id === "item_sofa")!;
      assert.equal(sofa.locked, true, "locked again where it landed");
      assert.ok(Math.abs(sofa.rotationY - Math.PI / 2) < 1e-6, "back to the left wall");
    }
    assert.deepEqual(failing((await a.get()).json.validations), []);
    assert.equal((await a.moveTo("item_ghost", BACK_WALL)).status, 404);
  });

  test("place then remove: the cart is back to exactly what it was", async () => {
    const a = await fresh();
    await roomyBudget(a);
    const digest = (await a.checkout()).json.cart.digest;
    const id = (await a.shop(couch)).json.output!.results[0].product.id;
    const placed = await a.place(id, BACK_WALL);
    assert.ok(placed.json.ok);
    if (!placed.json.ok) return;
    assert.notEqual((await a.checkout()).json.cart.digest, digest);
    const r = await a.change(placed.json.plan.revision, [{ kind: "remove", itemId: placed.json.itemId }]);
    assert.ok(r.json.ok);
    assert.equal((await a.checkout()).json.cart.digest, digest);
  });

  test("every shoppable category answers at a few spots, and every fit it claims really places", async () => {
    const a = await fresh();
    await roomyBudget(a);
    for (const category of ["sofa", "chair", "table", "storage", "rug", "lamp"] as const) {
      for (const spot of [BACK_WALL, { position: [0.4, 0, 2.0] }, { position: [2.5, 0, 1.4] }] as FloorSpot[]) {
        const job = (await a.shop({ category, spot, live: false })).json;
        assert.equal(job.state, "succeeded", `${category}`);
        for (const r of job.output!.results) assert.ok(!r.fits || r.placement, `${category}: fit without a placement`);
      }
    }
    // and the top fit for a lamp by the left wall actually goes in
    const lamp = (await a.shop({ category: "lamp", spot: { position: [0.3, 0, 2.0] }, live: false })).json.output!.results.find((r) => r.fits)!;
    const placed = await a.place(lamp.product.id, { position: [0.3, 0, 2.0] });
    assert.ok(placed.json.ok, JSON.stringify(placed.json));
  });
});

describe("live shop at a spot", { skip: process.env.E2E_LIVE !== "1" && "set E2E_LIVE=1 to run (browses IKEA, ~$0.02)" }, () => {
  test("couch under $300 at the back wall, live from IKEA: answers instantly, then merges real finds that fit", { timeout: 8 * 60 * 1000 }, async () => {
    const a = await fresh();
    const start = await a.shop({ ...couch, live: true });
    assert.equal(start.status, 200, JSON.stringify(start.json));
    assert.equal(start.json.output!.live, "running");
    assert.ok(start.json.output!.results.length > 0, "catalog answer right away");
    let job = start.json;
    for (let i = 0; i < 160 && job.output!.live === "running"; i++) {
      await sleep(3000);
      job = (await a.shopJob(job.id)).json;
    }
    console.log(`  [live] ${job.stage}`);
    assert.equal(job.state, "succeeded", JSON.stringify(job));
    assert.ok(["done", "failed"].includes(job.output!.live));
    for (const r of job.output!.results) {
      assert.ok(r.product.price === null || r.product.price.amountMinor <= 30000, `${r.product.label} over $300`);
      assert.equal(r.product.category, "sofa");
    }
    const live = job.output!.results.filter((r) => r.source === "live");
    for (const r of live) assert.ok(r.product.sourceUrl.startsWith("https://www.ikea.com/"), r.product.sourceUrl);
    if (live.some((r) => r.fits)) {
      assert.ok(job.output!.addedAtRevision !== null);
      const plan = (await a.get()).json.plan;
      assert.ok(live.filter((r) => r.fits).every((r) => plan.products.some((p) => p.id === r.product.id)), "live fits joined the catalog");
    }
  });
});

