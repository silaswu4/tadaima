import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWalkInput } from "../room/walk-input.ts";

test("external movement axes are finite and clamped while preserving analog input", () => {
  assert.deepEqual(normalizeWalkInput({ forward: 20, right: -9 }), { forward: 1, right: -1 });
  assert.deepEqual(normalizeWalkInput({ forward: .4, right: -.25 }), { forward: .4, right: -.25 });
  assert.deepEqual(normalizeWalkInput({ forward: NaN, right: Infinity }), { forward: 0, right: 0 });
  assert.deepEqual(normalizeWalkInput(null), { forward: 0, right: 0 });
  assert.deepEqual(normalizeWalkInput({ forward: "1" }), { forward: 0, right: 0 });
});
