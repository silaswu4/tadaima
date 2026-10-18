import assert from "node:assert/strict";
import test from "node:test";
import { approvalDigest } from "./receipt";
import type { RoomPlan } from "../contracts";

const plan = (overrides: Partial<RoomPlan> = {}, price = 9999): RoomPlan => ({
  schemaVersion: "0.2", projectId: "proj_room_0123456789abcdef0123456789abcdef", revision: 7, geometry: { rooms: [], walls: [], openings: [] } as unknown as RoomPlan["geometry"],
  evidence: [], constraints: { budget: null, minimumSeats: null, clearance: .6 },
  products: [{ id: "sku:chair", price: { amountMinor: price, currency: "USD" } } as unknown as RoomPlan["products"][number]],
  items: [
    { id: "a", label: "Chair", origin: "proposed_purchase", productId: "sku:chair" },
    { id: "b", label: "Owned sofa", origin: "existing_owned", productId: null },
    { id: "c", label: "Stored lamp", origin: "proposed_purchase", productId: "sku:chair", stored: true },
  ] as unknown as RoomPlan["items"],
  ...overrides,
});

test("the approval hash covers exactly the basket the shopper sees, so any later edit is detectable", () => {
  const base = approvalDigest(plan());
  assert.equal(base.lines.length, 1, "owned and stored pieces are not purchases");
  assert.equal(base.totalMinor, 9999);
  assert.equal(approvalDigest(plan()).sha256, base.sha256, "deterministic for the same plan");
  assert.notEqual(approvalDigest(plan({}, 12999)).sha256, base.sha256, "a changed price changes the receipt");
  assert.notEqual(approvalDigest(plan({ revision: 8 })).sha256, base.sha256, "a different room revision changes the receipt");
});
