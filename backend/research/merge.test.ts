import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProductCandidate } from "@/backend/contracts";
import { mergeResults, stageLine } from "@/backend/research/merge";

const p = (id: string, usd: number | null, dims: [number, number, number] | null, merchant = "IKEA"): ProductCandidate => ({
  id,
  category: "sofa",
  merchant,
  sourceUrl: `https://example.com/${id}`,
  variantId: null,
  label: id,
  dimensions: dims,
  seats: 3,
  price: usd == null ? null : { amountMinor: usd * 100, currency: "USD" },
  availability: "available",
  imageUrl: null,
  observedAt: "2026-10-18T00:00:00Z",
  evidenceIds: [],
  fixture: false,
});

test("merges merchants, dedupes and sorts cheapest first with unknowns last", () => {
  const ikea = [p("a", 800, [2, 0.8, 0.9]), p("b", 500, [1.8, 0.8, 0.9]), p("nodims", 300, null)];
  const target = [p("c", 650, [2.1, 0.8, 0.95], "Target"), p("a", 800, [2, 0.8, 0.9]), p("noprice", null, [2, 0.8, 0.9], "Target")];
  assert.deepEqual(
    mergeResults([ikea, target]).map((x) => x.id),
    ["b", "c", "a", "nodims", "noprice"],
  );
});

test("drops what is known to be over a cap and keeps unknowns", () => {
  const list = [p("cheap", 400, [2.0, 0.8, 0.9]), p("pricey", 1200, [2.0, 0.8, 0.9]), p("wide", 500, [2.4, 0.8, 0.9]), p("deep", 500, [2.0, 0.8, 1.1]), p("unknown", null, null)];
  const out = mergeResults([list], { maxPriceUsd: 900, maxWidthM: 2.2, maxDepthM: 1.0 });
  assert.deepEqual(out.map((x) => x.id), ["cheap", "unknown"]);
});

test("price cap is inclusive", () => {
  assert.equal(mergeResults([[p("exact", 900, [2, 0.8, 0.9])]], { maxPriceUsd: 900 }).length, 1);
});

test("caps to limit per merchant", () => {
  const many = Array.from({ length: 8 }, (_, i) => p(`x${i}`, 100 + i, [1, 1, 1]));
  assert.equal(mergeResults([many], { limit: 3 }).length, 3);
  assert.equal(mergeResults([many, []], { limit: 3 }).length, 6);
});

test("stage line reads per merchant", () => {
  assert.equal(
    stageLine([
      { merchant: "IKEA", status: "done", found: 3, note: null },
      { merchant: "Target", status: "searching", found: 0, note: null },
      { merchant: "Walmart", status: "failed", found: 0, note: "captcha" },
    ]),
    "IKEA done, 3 found; Target searching; Walmart failed",
  );
});
