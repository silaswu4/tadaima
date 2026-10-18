import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProductCandidate, RoomPlan, ShopRequest, Vector3Meters } from "@/backend/contracts";
import { demoPlan } from "@/backend/fixtures/demo-room";
import { assetFor, assetTransform, LIBRARY } from "@/backend/shopping/assets";
import { catalogCandidates, evaluate, evaluateAll, maxWidthAtSpot, spotBrief } from "@/backend/shopping/spot";

const backWall = { position: [3.0, 0, 0.6] as Vector3Meters };
const couch = (over: Partial<ShopRequest> = {}): ShopRequest => ({ category: "sofa", spot: backWall, maxPriceUsd: 300, ...over });
const saltmyran = demoPlan.products.find((p) => p.label.startsWith("SALTMYRAN"))!;

describe("shopping a spot", () => {
  test("'a couch under $300 that fits here' finds SALTMYRAN at $299 and places it on the wall", () => {
    const [top, ...rest] = evaluateAll(demoPlan, catalogCandidates(demoPlan, couch()).map((product) => ({ product, source: "catalog" as const })), couch());
    assert.equal(top.product.id, saltmyran.id);
    assert.equal(rest.length, 0, "the $399 and $699 loveseats are over the cap");
    assert.ok(top.fits);
    assert.equal(top.placement?.againstWallId, "wall_back");
    assert.equal(top.assetUrl, "/models/sofa_02.glb");
  });

  test("a merchant filter only returns that retailer's observed catalog", () => {
    for (const merchant of ["IKEA", "Target"] as const) {
      const request: ShopRequest = { category: "chair", spot: backWall, merchant };
      const candidates = catalogCandidates(demoPlan, request);
      assert.ok(candidates.length > 0);
      assert.ok(candidates.every((product) => product.merchant === merchant));
    }
  });

  test("the cap is inclusive and exact", () => {
    assert.ok(catalogCandidates(demoPlan, couch({ maxPriceUsd: 299 })).some((p) => p.id === saltmyran.id));
    assert.ok(!catalogCandidates(demoPlan, couch({ maxPriceUsd: 298.99 })).some((p) => p.id === saltmyran.id));
    assert.equal(catalogCandidates(demoPlan, couch({ maxPriceUsd: null })).length, 3);
  });

  test("budget is reported, not hidden: $299 on top of $1,397.97 is $196.97 over $1,500", () => {
    const r = evaluate(demoPlan, saltmyran, couch(), "catalog");
    assert.equal(r.withinBudget, false);
    assert.equal(r.overBudgetUsd, 196.97);
    const roomy: RoomPlan = { ...demoPlan, constraints: { ...demoPlan.constraints, budget: { amountMinor: 200000, currency: "USD" } } };
    const ok = evaluate(roomy, saltmyran, couch(), "catalog");
    assert.equal(ok.withinBudget, true);
    assert.equal(ok.overBudgetUsd, null);
    const none: RoomPlan = { ...demoPlan, constraints: { ...demoPlan.constraints, budget: null } };
    assert.equal(evaluate(none, saltmyran, couch(), "catalog").withinBudget, null);
  });

  test("out of stock, unsized and unpriced products never count as fitting", () => {
    const base = saltmyran;
    const gone: ProductCandidate = { ...base, id: "x1", availability: "unavailable" };
    const unsized: ProductCandidate = { ...base, id: "x2", dimensions: null };
    const unpriced: ProductCandidate = { ...base, id: "x3", price: null };
    assert.equal(evaluate(demoPlan, gone, couch(), "live").fits, false);
    assert.equal(evaluate(demoPlan, unsized, couch(), "live").fits, false);
    const u = evaluate(demoPlan, unpriced, couch(), "live");
    assert.equal(u.fits, false);
    assert.ok(u.problems.some((p) => p.includes("No price")));
    assert.equal(u.withinBudget, null);
  });

  test("unknown stock, fixture data, invalid dimensions and foreign currency cannot be called fitting", () => {
    for (const bad of [
      { ...saltmyran, availability: "unknown" as const },
      { ...saltmyran, fixture: true },
      { ...saltmyran, dimensions: [0, 1, 1] as const },
      { ...saltmyran, price: { amountMinor: 29900, currency: "EUR" } },
      { ...saltmyran, price: { amountMinor: NaN, currency: "USD" } },
    ]) {
      const result = evaluate(demoPlan, bad, couch(), "live");
      assert.equal(result.fits, false);
      assert.ok(result.problems.length > 0);
    }
    const euroPlan = structuredClone(demoPlan);
    euroPlan.constraints.budget!.currency = "EUR";
    const euroProduct = { ...saltmyran, price: { amountMinor: 29900, currency: "EUR" } };
    assert.equal(evaluate(euroPlan, euroProduct, couch(), "live").fits, true);
  });

  test("ranking: fits first, then within budget, then the shopper's words, then price", () => {
    const roomy: RoomPlan = { ...demoPlan, constraints: { ...demoPlan.constraints, budget: { amountMinor: 190000, currency: "USD" } } };
    const sofas = catalogCandidates(roomy, couch({ maxPriceUsd: null }));
    const ranked = evaluateAll(roomy, sofas.map((product) => ({ product, source: "catalog" as const })), couch({ maxPriceUsd: null, request: "dark gray" }));
    // $1,397.97 + 399 is within $1,900, + 699 is not; GULLVALLA is "dark gray", SALTMYRAN isn't
    assert.deepEqual(
      ranked.map((r) => r.product.label.split(" ")[0]),
      ["GULLVALLA", "SALTMYRAN", "EKHOLMA"],
    );
  });

  test("the spot's width is measured: wide at the back wall, narrow in the corner by the armchair", () => {
    const w = maxWidthAtSpot(demoPlan, couch());
    assert.ok(w !== null && w > 1.47 && w < 2.6, `${w}`);
    // free corner is about 1.15 x 1.12 m after clearance, so a 1.47 m loveseat can't go there
    const corner = maxWidthAtSpot(demoPlan, couch({ spot: { position: [4.8, 0, 4.0] } }));
    assert.ok(corner !== null && corner > 0.9 && corner < 1.2, `${corner}`);
    assert.equal(maxWidthAtSpot(demoPlan, { category: "rug", spot: backWall }), null);
  });

  test("the brief carries the spot, the cap, the budget left and the shopper's words", () => {
    const b = spotBrief(demoPlan, couch({ request: "something cozy" }));
    assert.match(b.text, /at most \d+ cm/);
    assert.match(b.text, /under \$300/);
    assert.match(b.text, /\$102 left/);
    assert.match(b.text, /something cozy/);
    assert.match(b.text, /Your sofa/);
  });
});

describe("3D library", () => {
  test("every library model has a positive size and a GLB url", () => {
    for (const models of Object.values(LIBRARY)) for (const m of models) {
      assert.ok(m.size.every((v) => v > 0));
      assert.match(m.url, /^\/models\/.+\.glb$/);
    }
  });

  test("tall bookcases get the shelves, low wide storage gets the cabinet", () => {
    assert.equal((assetFor("storage", [0.9, 1.97, 0.37]) as { url: string }).url, "/models/wooden_display_shelves_01.glb");
    assert.equal((assetFor("storage", [1.8, 0.6, 0.45]) as { url: string }).url, "/models/modern_wooden_cabinet.glb");
    assert.equal((assetFor("table", [0.9, 0.45, 0.55]) as { url: string }).url, "/models/modern_coffee_table_01.glb");
    assert.equal((assetFor("table", [0.45, 0.55, 0.45]) as { url: string }).url, "/models/side_table_01.glb");
  });

  test("rugs, lamps and unknown kinds fall back to procedural shapes", () => {
    assert.deepEqual(assetFor("rug", [1.5, 0.01, 2]), { kind: "procedural", shape: "rug" });
    assert.deepEqual(assetFor("lamp", null), { kind: "procedural", shape: "lamp" });
    assert.deepEqual(assetFor("bed", [1.5, 0.5, 2]), { kind: "procedural", shape: "box" });
  });

  test("scaling a model to a product gives exactly the product's size", () => {
    const m = assetFor("sofa", saltmyran.dimensions);
    assert.equal(m.kind, "model");
    if (m.kind !== "model") return;
    const { scale } = assetTransform(m, saltmyran.dimensions);
    scale.forEach((s, i) => assert.ok(Math.abs(s * m.size[i] - saltmyran.dimensions![i]) < 1e-9));
  });
});
