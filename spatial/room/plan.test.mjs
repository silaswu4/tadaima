// node --test spatial/room/plan.test.mjs
// runs on node 24+ type stripping, so no test runner or build step is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffPlans,
  dimensionSource,
  footprint,
  footprintInside,
  pointInPolygon,
  polygonCentroid,
  selfIntersects,
  validatePlan,
} from "./plan.ts";
import { DEMO_PLAN_R1, DEMO_PLAN_R2 } from "../fixtures/demoRoom.ts";

const clone = (plan) => structuredClone(plan);
const codes = (issues, severity) => issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);

test("the fixture revisions have no structural errors", () => {
  assert.deepEqual(codes(validatePlan(DEMO_PLAN_R1), "error"), []);
  assert.deepEqual(codes(validatePlan(DEMO_PLAN_R2), "error"), []);
});

test("the fixture reports what it does not know", () => {
  const issues = validatePlan(DEMO_PLAN_R1);
  const unknown = issues.filter((i) => i.code === "item_dimensions_unknown").map((i) => i.entityId);
  assert.deepEqual(unknown.sort(), ["item_cabinet", "item_side_table"]);
  assert.ok(codes(issues).includes("product_dimensions"));
});

test("every fixture item stays inside the room in both revisions", () => {
  for (const plan of [DEMO_PLAN_R1, DEMO_PLAN_R2]) {
    assert.deepEqual(validatePlan(plan).filter((i) => i.code === "item_outside_room"), []);
  }
});

test("rejects non-metric units and a missing wall reference", () => {
  const plan = clone(DEMO_PLAN_R1);
  plan.geometry.units = "cm";
  plan.geometry.openings[0].wallId = "wall_nowhere";
  const errors = codes(validatePlan(plan), "error");
  assert.ok(errors.includes("units"));
  assert.ok(errors.includes("opening_wall"));
});

test("rejects an opening that runs past its wall", () => {
  const plan = clone(DEMO_PLAN_R1);
  plan.geometry.openings[0].offset = 4;
  assert.ok(codes(validatePlan(plan), "error").includes("opening_bounds"));
});

test("rejects a crossed floor outline", () => {
  const bowtie = [
    [0, 0],
    [4, 4],
    [4, 0],
    [0, 4],
  ];
  assert.equal(selfIntersects(bowtie), true);
  assert.equal(selfIntersects(DEMO_PLAN_R1.geometry.rooms[0].floorPolygon), false);
  const plan = clone(DEMO_PLAN_R1);
  plan.geometry.rooms[0].floorPolygon = bowtie;
  assert.ok(codes(validatePlan(plan), "error").includes("room_self_intersecting"));
});

test("flags duplicate item IDs, unknown rooms, and missing products", () => {
  const plan = clone(DEMO_PLAN_R1);
  plan.items.push({ ...plan.items[0] });
  plan.items[1].roomId = "room_nowhere";
  plan.items[2].productId = "prod_nowhere";
  const errors = codes(validatePlan(plan), "error");
  assert.ok(errors.includes("duplicate_id"));
  assert.ok(errors.includes("item_room"));
  assert.ok(errors.includes("item_product"));
});

test("flags an item pushed through a wall", () => {
  const plan = clone(DEMO_PLAN_R1);
  plan.items.find((i) => i.id === "item_sofa").position = [2.6, 0, 0.1];
  const outside = validatePlan(plan).filter((i) => i.code === "item_outside_room").map((i) => i.entityId);
  assert.deepEqual(outside, ["item_sofa"]);
});

test("product dimensions win over the item record and mesh bounds never appear", () => {
  const table = DEMO_PLAN_R1.items.find((i) => i.id === "item_coffee_table");
  const source = dimensionSource(DEMO_PLAN_R1, table);
  assert.equal(source.kind, "product");
  assert.deepEqual(source.size, [0.6, 0.39, 1.2]);
  assert.equal(source.status, "source_dimension");

  const sofa = DEMO_PLAN_R1.items.find((i) => i.id === "item_sofa");
  assert.equal(dimensionSource(DEMO_PLAN_R1, sofa).kind, "item");

  const cabinet = DEMO_PLAN_R1.items.find((i) => i.id === "item_cabinet");
  assert.equal(dimensionSource(DEMO_PLAN_R1, cabinet).kind, "unknown");
});

test("footprint follows three.js rotation about +Y", () => {
  const quarter = footprint([0, 0, 0], Math.PI / 2, 2, 1);
  // a 2 m wide, 1 m deep item turned a quarter turn is 1 m wide in x and 2 m in z
  const xs = quarter.map((p) => p[0]);
  const zs = quarter.map((p) => p[1]);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 1) < 1e-9);
  assert.ok(Math.abs(Math.max(...zs) - Math.min(...zs) - 2) < 1e-9);
  const room = DEMO_PLAN_R1.geometry.rooms[0].floorPolygon;
  assert.equal(footprintInside(footprint([2.6, 0, 2.2], 0, 2, 1), room), true);
  assert.equal(footprintInside(footprint([5.0, 0, 2.2], 0, 2, 1), room), false);
});

test("point in polygon and centroid on the sample room", () => {
  const room = DEMO_PLAN_R1.geometry.rooms[0].floorPolygon;
  assert.equal(pointInPolygon([1, 1], room), true);
  assert.equal(pointInPolygon([6, 1], room), false);
  const [cx, cz] = polygonCentroid(room);
  assert.ok(Math.abs(cx - 2.6) < 1e-9 && Math.abs(cz - 2.2) < 1e-9);
});

test("diff between the fixture revisions names each change", () => {
  const diff = diffPlans(DEMO_PLAN_R1, DEMO_PLAN_R2);
  assert.equal(diff.fromRevision, 1);
  assert.equal(diff.toRevision, 2);
  const byId = Object.fromEntries(diff.changes.map((c) => [c.id, c]));
  assert.equal(byId.item_side_table.kind, "removed");
  assert.equal(byId.item_coffee_table.kind, "changed");
  assert.equal(byId.item_coffee_table.replaced, true);
  assert.equal(byId.item_lounge_chair.moved, true);
  assert.equal(byId.item_lounge_chair.rotated, true);
  // the locked pieces are untouched
  assert.equal(byId.item_sofa, undefined);
  assert.equal(byId.item_desk, undefined);
});

test("diff ignores sub-centimeter jitter and full turns", () => {
  const plan = clone(DEMO_PLAN_R1);
  plan.revision = 2;
  const sofa = plan.items.find((i) => i.id === "item_sofa");
  sofa.position = [2.6 + 0.004, 0, 0.6];
  sofa.rotationY = Math.PI * 2;
  assert.deepEqual(diffPlans(DEMO_PLAN_R1, plan).changes, []);
});
