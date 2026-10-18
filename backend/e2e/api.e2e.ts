/**
 * End-to-end API suite against a running server. Each test gets its own
 * throwaway project. `E2E_LIVE=1` also runs the live Browser Use research test.
 *   npm run e2e                      (local, port 3009)
 *   E2E_BASE=https://... E2E_BYPASS=... npm run e2e
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { api, call, failing, newProjectId, sleep } from "@/backend/e2e/client";

const fresh = async () => {
  const id = newProjectId();
  const a = api(id);
  const r = await a.reset();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return a;
};

describe("reads", () => {
  test("unknown project is a 404", async () => {
    const r = await call("GET", "/api/projects/proj_nope_nope");
    assert.equal(r.status, 404);
  });

  test("fresh demo room is valid at revision 1", async () => {
    const a = await fresh();
    const { status, json } = await a.get();
    assert.equal(status, 200);
    assert.equal(json.plan.revision, 1);
    assert.equal(json.cost.knownSubtotal.amountMinor, 139797);
    assert.deepEqual(failing(json.validations), []);
    assert.ok(json.plan.products.length >= 30, "real catalog loaded");
    assert.ok(json.plan.products.every((p) => p.fixture === false), "catalog is real observations");
  });

  test("brief knows the space, money and seats at the armchair", async () => {
    const a = await fresh();
    const { status, json } = await a.brief("item_armchair");
    assert.equal(status, 200);
    assert.ok(json.space.maxWidthM! > 0.9 && json.space.maxWidthM! < 1.2);
    assert.equal(json.budget.maxPriceUsd, 501.03);
    assert.equal(json.seatsRequired, 1);
  });

  test("brief without itemId is a 400, unknown item is an error", async () => {
    const a = await fresh();
    assert.equal((await call("GET", `/api/projects/${newProjectId()}/brief`)).status, 400);
    assert.notEqual((await a.brief("item_ghost")).status, 200);
  });

  test("voice token is issued", async () => {
    const r = await call<{ token: string }>("GET", "/api/voice/token");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.token.length > 20);
  });
});

describe("direct changes", () => {
  test("lock toggle bumps the revision, and the old revision is then stale", async () => {
    const a = await fresh();
    const ok = await a.change(1, [{ kind: "lock", itemId: "item_armchair", locked: true }]);
    assert.equal(ok.status, 200);
    assert.ok(ok.json.ok && ok.json.plan.revision === 2);
    const stale = await a.change(1, [{ kind: "lock", itemId: "item_lamp", locked: true }]);
    assert.deepEqual(stale.json, { ok: false, reason: "stale_revision", currentRevision: 2 });
  });

  test("removing the locked sofa is refused for both lock and seats", async () => {
    const a = await fresh();
    const r = await a.change(1, [{ kind: "remove", itemId: "item_sofa" }]);
    assert.ok(!r.json.ok && r.json.reason === "validation_failed");
    const rules = r.json.reason === "validation_failed" ? failing(r.json.validations).map((v) => v.rule) : [];
    assert.ok(rules.includes("locked_kept") && rules.includes("seats"), rules.join());
    assert.equal((await a.get()).json.plan.revision, 1, "nothing saved");
  });

  test("unlocking in the same request allows moving the sofa", async () => {
    const a = await fresh();
    const r = await a.change(1, [
      { kind: "lock", itemId: "item_sofa", locked: false },
      { kind: "move", itemId: "item_sofa", position: [2.4, 0, 3.7], rotationY: Math.PI },
    ]);
    assert.ok(r.json.ok, JSON.stringify(r.json));
  });

  test("pushing the bookcase into the wall fails in_room", async () => {
    const a = await fresh();
    const r = await a.change(1, [{ kind: "move", itemId: "item_shelf", position: [4.5, 0, 0.05], rotationY: 0 }]);
    assert.ok(!r.json.ok && r.json.reason === "validation_failed" && failing(r.json.validations).some((v) => v.rule === "in_room"));
  });

  test("replacing with a product that doesn't exist is refused", async () => {
    const a = await fresh();
    const r = await a.change(1, [{ kind: "replace", itemId: "item_lamp", productId: "prod_made_up" }]);
    assert.equal(r.status, 200);
    assert.ok(!r.json.ok);
  });

  test("malformed bodies are 400s", async () => {
    const a = await fresh();
    assert.equal((await a.change(1, [{ kind: "teleport", itemId: "item_lamp" }])).status, 400);
    assert.equal((await a.change(1, [])).status, 400);
    assert.equal((await call("POST", `/api/projects/${newProjectId()}/changes`, { changes: [] })).status, 400);
    assert.equal((await a.propose("")).status, 400);
    assert.equal((await a.propose("x".repeat(600))).status, 400);
  });

  test("two devices applying against the same revision: exactly one wins", async () => {
    const a = await fresh();
    const results = await Promise.all(
      ["item_lamp", "item_rug", "item_shelf", "item_armchair"].map((itemId) => a.change(1, [{ kind: "lock", itemId, locked: true }])),
    );
    assert.equal(results.filter((r) => r.json.ok).length, 1, JSON.stringify(results.map((r) => r.json)));
    assert.equal((await a.get()).json.plan.revision, 2);
  });
});

describe("planner round trip", () => {
  test("the demo request: propose, apply, then re-apply is stale", async () => {
    const a = await fresh();
    const p = await a.propose("Keep my sofa and desk, make the room $300 cheaper, and keep seating for four.");
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.ok(p.json.changes.length > 0);
    assert.deepEqual(failing(p.json.validations), []);
    assert.ok(p.json.costBefore.knownSubtotal.amountMinor - p.json.costAfter.knownSubtotal.amountMinor >= 30000);
    const applied = await a.apply(p.json.id, 1);
    assert.ok(applied.json.ok, JSON.stringify(applied.json));
    const again = await a.apply(p.json.id, 1);
    assert.ok(!again.json.ok && again.json.reason === "stale_revision");
    const after = (await a.get()).json;
    assert.equal(after.plan.revision, 2);
    assert.equal(after.cost.knownSubtotal.amountMinor, p.json.costAfter.knownSubtotal.amountMinor);
  });

  test("an impossible request proposes nothing", async () => {
    const a = await fresh();
    const p = await a.propose("Make it $5000 cheaper and keep seating for four.");
    assert.equal(p.status, 200);
    assert.equal(p.json.changes.length, 0);
    assert.ok(p.json.summary.length > 10);
  });

  test("applying a proposal that doesn't exist is a 404", async () => {
    const a = await fresh();
    assert.equal((await a.apply("prop_nope", 1)).status, 404);
  });
});

describe("live research", { skip: process.env.E2E_LIVE !== "1" && "set E2E_LIVE=1 to run (browses IKEA, ~$0.02)" }, () => {
  test("room-aware armchair search returns fitting products and adds them to the plan", { timeout: 8 * 60 * 1000 }, async () => {
    const a = await fresh();
    const before = (await a.get()).json.plan.products.length;
    const start = await a.research("item_armchair", "under $200");
    assert.equal(start.status, 200, JSON.stringify(start.json));
    let job = start.json;
    for (let i = 0; i < 160 && (job.state === "queued" || job.state === "running"); i++) {
      await sleep(3000);
      job = (await a.job(job.id)).json;
    }
    assert.equal(job.state, "succeeded", JSON.stringify(job));
    const out = job.output!;
    assert.ok(out.results.length > 0);
    assert.ok(out.brief.includes("105 cm") || out.brief.includes("wide"));
    for (const r of out.results) {
      assert.ok(r.product.sourceUrl.startsWith("https://www.ikea.com/"), r.product.sourceUrl);
      assert.ok(r.product.price === null || r.product.price.amountMinor <= 50103, "respects money left");
    }
    const fits = out.results.filter((r) => r.fits);
    if (fits.length) {
      assert.ok(out.addedAtRevision !== null);
      const plan = (await a.get()).json.plan;
      assert.ok(fits.every((f) => plan.products.some((p) => p.id === f.product.id)));
      assert.ok(plan.products.length >= before);
    }
  });
});
