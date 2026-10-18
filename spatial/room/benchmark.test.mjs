// node --test spatial/room/benchmark.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeScale } from "./benchmark.ts";

test("a model within 10 percent of its listed size matches", () => {
  assert.equal(judgeScale([1.81, 0.71, 0.82], [1.8, 0.7, 0.8]).scale, "matches");
});

test("a centimeter or millimeter export is called out as a unit error", () => {
  assert.equal(judgeScale([181, 71, 82], [1.81, 0.71, 0.82]).scale, "unit_error_likely");
  assert.equal(judgeScale([1810, 710, 820], [1.81, 0.71, 0.82]).scale, "unit_error_likely");
});

test("a model turned the wrong way differs without looking like a unit error", () => {
  const { scale, ratio } = judgeScale([0.6, 0.39, 1.2], [1.2, 0.39, 0.6]);
  assert.equal(scale, "differs");
  assert.deepEqual(ratio.map((r) => Math.round(r * 100)), [50, 100, 200]);
});

test("without a listed size only absurd bounds are flagged", () => {
  assert.equal(judgeScale([2.44, 0.68, 0.52], null).scale, "unchecked");
  assert.equal(judgeScale([244, 68, 52], null).scale, "implausible");
  assert.equal(judgeScale([0.005, 0.004, 0.003], null).scale, "implausible");
});
