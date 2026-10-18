import assert from "node:assert/strict";
import { test } from "node:test";
import { demoPlan, realCatalog } from "@/backend/fixtures/demo-room";
import { getTadaimaRooms } from "@/spatial/fixtures/roomsCatalog";
import { RoomPlanSchema } from "./schema";
import { normalizeRegisteredPlan, reconcileRoomSnapshot } from "./sync";

const base = () => normalizeRegisteredPlan(structuredClone(demoPlan), "proj_room_00000000000000000000000000000001", realCatalog);

test("all nine website rooms can register without dropping wall-mounted or table-top objects", () => {
  for (const room of getTadaimaRooms()) {
    const parsed = RoomPlanSchema.parse(room.plan);
    const registered = normalizeRegisteredPlan(parsed, "proj_room_00000000000000000000000000000001", realCatalog);
    assert.equal(registered.items.length, room.plan.items.length);
    assert.equal(registered.revision, room.plan.revision + 1);
    assert.ok(realCatalog.every((product) => registered.products.some((entry) => entry.id === product.id)));
    assert.deepEqual(registered.geometry, room.plan.geometry);
  }
});
test("registration overwrites imported catalog prices with trusted observations", () => {
  const input = structuredClone(demoPlan);
  input.products[0].price = { amountMinor: 1, currency: "USD" };
  const plan = normalizeRegisteredPlan(input, "proj_room_00000000000000000000000000000001", realCatalog);
  assert.deepEqual(plan.products[0], realCatalog[0]);
});
test("unknown initial product observations are fixtures and never masquerade as live catalog", () => {
  const input = structuredClone(demoPlan);
  input.products.push({ ...input.products[0], id: "client_forged_product", fixture: false });
  const registered = normalizeRegisteredPlan(input, "proj_room_00000000000000000000000000000001", realCatalog);
  assert.equal(registered.products.find((product) => product.id === "client_forged_product")!.fixture, true);
});
test("sync accepts no-op and storage with the canonical products retained", () => {
  const plan = base(), snapshot = structuredClone(plan);
  snapshot.products = [];
  snapshot.evidence = [];
  snapshot.items.find((item) => item.id === "item_armchair")!.stored = true;
  const result = reconcileRoomSnapshot(plan, snapshot);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.plan.products, plan.products);
  assert.deepEqual(result.plan.evidence, plan.evidence);
});
test("sync rejects source geometry, appearance and evidence forgery", () => {
  const plan = base();
  for (const mutate of [
    (draft: typeof plan) => { draft.geometry.rooms[0].height = 9; },
    (draft: typeof plan) => { draft.evidence[0].claim = "fake"; },
    (draft: typeof plan) => { draft.products[0].price = { amountMinor: 1, currency: "USD" }; },
    (draft: typeof plan) => { draft.projectId = "proj_demo"; },
  ]) {
    const draft = structuredClone(plan); mutate(draft);
    assert.throws(() => reconcileRoomSnapshot(plan, draft));
  }
});
test("sync rejects forged dimensions, new owned objects and deleted owned furniture", () => {
  const plan = base();
  for (const mutate of [
    (draft: typeof plan) => { draft.items.find((item) => item.origin === "existing_owned")!.dimensions = [0.1, 0.1, 0.1]; },
    (draft: typeof plan) => { draft.items.push({ ...draft.items[0], id: "forged_owned" }); },
    (draft: typeof plan) => { draft.items = draft.items.filter((item) => item.origin !== "existing_owned"); },
  ]) { const draft = structuredClone(plan); mutate(draft); assert.throws(() => reconcileRoomSnapshot(plan, draft)); }
});
test("locked moves refuse, explicit unlocking plus storage succeeds", () => {
  const plan = base(), moved = structuredClone(plan);
  moved.items[0].position = [2, 0, 2];
  assert.equal(reconcileRoomSnapshot(plan, moved).blocked, true);
  const stored = structuredClone(plan);
  stored.items[0].locked = false;
  stored.items[0].stored = true;
  assert.equal(reconcileRoomSnapshot(plan, stored).blocked, false);
});
test("preexisting capture overlaps do not freeze a no-op, but do not license new pairs", () => {
  const plan = base();
  plan.constraints.minimumSeats = null;
  plan.items.forEach((item) => { item.locked = false; });
  plan.items = plan.items.slice(0, 3);
  plan.items[0].position = [1, 0, 1];
  plan.items[1].position = [1, 0, 1];
  plan.items[2].position = [4, 0, 3];
  assert.equal(reconcileRoomSnapshot(plan, structuredClone(plan)).blocked, false);
  const snapshot = structuredClone(plan);
  snapshot.items[2].position = [1, 0, 1];
  assert.equal(reconcileRoomSnapshot(plan, snapshot).blocked, true);
});
test("model-derived collision parts are derived data: they may arrive or change on owned pieces", () => {
  const plan = base();
  const snapshot = structuredClone(plan);
  const owned = snapshot.items.find((item) => item.origin === "existing_owned")!;
  owned.collision = [[0, 0.2, 0, 0.5, 0.4, 0.5]];
  const first = reconcileRoomSnapshot(plan, snapshot);
  assert.equal(first.blocked, false);
  assert.deepEqual(first.plan.items.find((item) => item.id === owned.id)!.collision, owned.collision);
  const again = structuredClone(first.plan);
  again.items.find((item) => item.id === owned.id)!.collision = [[0, 0.3, 0, 0.4, 0.6, 0.4], [0, 0.05, 0, 0.1, 0.1, 0.1]];
  assert.equal(reconcileRoomSnapshot(first.plan, again).blocked, false);
  const cleared = structuredClone(first.plan);
  delete cleared.items.find((item) => item.id === owned.id)!.collision;
  assert.equal(reconcileRoomSnapshot(first.plan, cleared).blocked, false);
  assert.equal(RoomPlanSchema.safeParse(snapshot).success, true);
});
test("new collision parts on unmoved pieces never block, but moving deeper into them does", () => {
  const plan = base();
  plan.constraints.minimumSeats = null;
  plan.items.forEach((item) => { item.locked = false; });
  plan.items = plan.items.slice(0, 2).map((item) => ({ ...item, dimensions: [0.5, 0.8, 0.5] as [number, number, number] }));
  plan.items[0].category = "chair";
  plan.items[1].category = "table";
  // the chair is tucked under the table (fine by footprint rules)...
  plan.items[0].position = [2, 0, 2];
  plan.items[1].position = [2, 0, 2.1];
  // ...but its newly known backrest pokes through the tabletop: a no-op sync stays accepted
  const shaped = structuredClone(plan);
  shaped.items[0].collision = [[0, 0.4, 0, 0.5, 0.8, 0.5]];
  shaped.items[1].collision = [[0, 0.75, 0, 0.5, 0.05, 0.5]];
  assert.equal(reconcileRoomSnapshot(plan, shaped).blocked, false);
  // pushing the table further onto the chair is refused
  const crowded = structuredClone(shaped);
  crowded.items[1].position = [2, 0, 2.05];
  assert.equal(reconcileRoomSnapshot(plan, crowded).blocked, true);
});
test("HTTP schemas reject excessive arrays, infinite geometry, foreign room ids and arbitrary assets", () => {
  for (const mutate of [
    (draft: typeof demoPlan) => { draft.items[0].position = [Infinity, 0, 1]; },
    (draft: typeof demoPlan) => { draft.items[0].roomId = "unknown"; },
    (draft: typeof demoPlan) => { draft.items[0].assetUrl = "https://example.com/model.glb"; },
    (draft: typeof demoPlan) => { draft.products = Array.from({ length: 1025 }, () => draft.products[0]); },
  ]) { const draft = structuredClone(demoPlan); mutate(draft); assert.equal(RoomPlanSchema.safeParse(draft).success, false); }
});
