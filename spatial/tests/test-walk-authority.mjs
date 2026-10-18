import assert from "node:assert/strict";
import test from "node:test";
import { acceptWalkPlan, canPreserveWalkUndo, checkedWalkShoppingSpot, walkModelIdentity } from "../room/walk-authority.ts";
import { makeWorkspaceDemo } from "../room/workspace-fixture.ts";
import { createWalkRevisionTracker } from "../room/walk-revision.ts";

function captured() {
  const plan = makeWorkspaceDemo();
  const item = plan.items[0];
  item.origin = "existing_owned"; item.productId = null; item.assetUrl = null;
  item.dimensions = [1.5, .8, 1];
  return plan;
}

test("server registration can change project ID while retaining immutable source geometry and furniture", () => {
  const source = captured(), next = structuredClone(source), original = structuredClone(source);
  next.projectId = "project_registered"; next.revision += 7;
  next.items[0].stored = true; next.items[0].locked = false;
  next.items[0].position = [2, 0, 2];
  const accepted = acceptWalkPlan(source, next, source);
  assert.deepEqual(accepted, next);
  accepted.items[0].position[0] += 1;
  assert.notDeepEqual(accepted, next);
  assert.deepEqual(source, original);
});

test("reconciliation rejects a different shell before state can be applied", () => {
  const source = captured(), next = structuredClone(source);
  next.geometry.rooms[0].floorPolygon[0] = [123, 123];
  assert.throws(() => acceptWalkPlan(source, next, source), /geometry/);
  const finishes = structuredClone(source);
  finishes.appearance = { schemaVersion: "room-appearance/1.0", reviewRequired: true, scope: "unknown", sources: [], surfaces: [], notes: [] };
  assert.throws(() => acceptWalkPlan(source, finishes, source), /finishes/);
});

test("stable captured IDs cannot be reassigned to unrelated dimensions, product identity or category", () => {
  const source = captured();
  for (const patch of [{ dimensions: [9, 1, 1] }, { origin: "proposed_purchase" }, { category: "bed" }, { assetUrl: "/other.glb" }]) {
    const next = structuredClone(source); Object.assign(next.items[0], patch);
    assert.throws(() => acceptWalkPlan(source, next, source), /captured furniture/);
  }
});

test("removed or stored source furniture does not require rewriting the immutable source", () => {
  const source = captured(), next = structuredClone(source);
  next.items.splice(0, 1);
  assert.equal(acceptWalkPlan(source, next, source).items.length, source.items.length - 1);
  assert.equal(source.items.length, next.items.length + 1);
});

test("rejects malformed canonical revisions, duplicate items and missing product links", () => {
  const source = captured();
  for (const revision of [-1, Infinity, .5]) assert.throws(() => acceptWalkPlan(source, { ...source, revision }), /revision/);
  const duplicate = structuredClone(source); duplicate.items.push(structuredClone(duplicate.items[0]));
  assert.throws(() => acceptWalkPlan(source, duplicate), /identity/);
  const unknown = structuredClone(source); unknown.items[0].productId = "missing";
  assert.throws(() => acceptWalkPlan(source, unknown), /identity/);
});

test("rejects invalid furniture and product coordinates before mesh transforms see NaN", () => {
  const source = captured();
  for (const position of [[NaN, 0, 1], [1, Infinity, 1], [1, 1]]) {
    const next = structuredClone(source); next.items[0].position = position;
    assert.throws(() => acceptWalkPlan(source, next), /pose/);
  }
  const next = structuredClone(source);
  next.products = [{ id: "bad", dimensions: [Infinity, 1, 1], price: null }];
  assert.throws(() => acceptWalkPlan(source, next), /product dimensions/);
});

test("unchanged model identity survives changes to canonical pose, price, label, lock or storage", () => {
  const plan = captured(), item = plan.items[0], before = walkModelIdentity(plan, item);
  const changed = { ...item, label: "new name", locked: !item.locked, stored: true, rotationY: 1, position: [2, 0, 3] };
  assert.equal(walkModelIdentity(plan, changed), before);
  assert.notEqual(walkModelIdentity(plan, { ...changed, dimensions: [1, 1, 1] }), before);
  assert.notEqual(walkModelIdentity(plan, { ...changed, assetUrl: "/new.glb" }), before);
});

test("product size changes rebuild models while price updates alone do not", () => {
  const plan = captured(), item = plan.items[0];
  item.productId = "product"; plan.products = [{ id: "product", dimensions: [1, 2, 3], price: { amountMinor: 100, currency: "USD" } }];
  const before = walkModelIdentity(plan, item);
  plan.products[0].price.amountMinor = 200;
  assert.equal(walkModelIdentity(plan, item), before);
  plan.products[0].dimensions = [2, 2, 3];
  assert.notEqual(walkModelIdentity(plan, item), before);
});

test("authoritative revision reset makes the next local edit advance from the server snapshot", () => {
  const plan = captured(); plan.revision = 40;
  const accepted = acceptWalkPlan(plan, { ...plan, revision: 3 });
  const tracker = createWalkRevisionTracker(accepted);
  assert.equal(tracker.accept(structuredClone(accepted)), 3);
  accepted.items[0].locked = !accepted.items[0].locked;
  assert.equal(tracker.accept(accepted), 4);
});

test("shopping spot rejects NaN, outside and concave holes, then uses the first checked in-room fallback", () => {
  const plan = captured();
  plan.geometry.rooms = [{ id: "concave", floorPolygon: [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]] }];
  assert.deepEqual(checkedWalkShoppingSpot(plan, [[NaN, 0, 1], [3, 0, 3], [-1, 0, 0], [.5, 5, 3]]), {
    roomId: "concave", position: [.5, 0, 3],
  });
  assert.equal(checkedWalkShoppingSpot(plan, [[3, 0, 3], [10, 0, 10]]), null);
});


test("canonical acknowledgements preserve move, lock and store undo across revision/project/catalog updates", () => {
  for (const edit of [
    (plan) => { plan.items[0].position = [2, 0, 3]; plan.items[0].rotationY = .7; },
    (plan) => { plan.items[0].locked = !plan.items[0].locked; },
    (plan) => { plan.items[0].stored = true; },
  ]) {
    const current = captured(); edit(current);
    const echoed = structuredClone(current);
    echoed.projectId = "server_project"; echoed.revision = 100;
    echoed.items.reverse();
    echoed.products.push({ id: "new-research", dimensions: [1, 1, 1], price: { amountMinor: 5000, currency: "USD" } });
    for (const item of echoed.items) { item.stored ??= false; item.evidenceIds ??= []; }
    assert.equal(canPreserveWalkUndo(current, echoed), true);
    // An undo can still target the same accepted stable ID after acknowledgement.
    assert.ok(echoed.items.some((item) => item.id === current.items[0].id));
  }
});

test("remote edits and canonical additions invalidate undo instead of reverting newer server work", () => {
  const current = captured();
  for (const edit of [
    (plan) => { plan.items[0].position = [3, 0, 4]; },
    (plan) => { plan.items[0].stored = true; },
    (plan) => { plan.items[0].locked = !plan.items[0].locked; },
    (plan) => { plan.items.pop(); },
    (plan) => { plan.items.push({ ...plan.items[0], id: "server-addition" }); },
    (plan) => { plan.constraints.clearance += .1; },
  ]) {
    const remote = structuredClone(current); edit(remote);
    assert.equal(canPreserveWalkUndo(current, remote), false);
  }
});

test("changes to existing product facts invalidate undo while catalog-only additions retain it", () => {
  const current = captured();
  current.products = [{ id: "previous", dimensions: [1, 1, 1], price: { amountMinor: 100, currency: "USD" } }];
  const added = structuredClone(current);
  added.products.push({ id: "new", dimensions: [1, 1, 1], price: null });
  assert.equal(canPreserveWalkUndo(current, added), true);
  added.products[0].dimensions[0] = 2;
  assert.equal(canPreserveWalkUndo(current, added), false);
  const priceChanged = structuredClone(current); priceChanged.products[0].price.amountMinor = 200;
  assert.equal(canPreserveWalkUndo(current, priceChanged), false);
});
