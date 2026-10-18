import assert from "node:assert/strict";
import { test } from "node:test";
import { demoPlan } from "@/backend/fixtures/demo-room";

const base = process.env.E2E_BASE ?? "http://localhost:3009";
const origin = new URL(base).origin;
async function call(path: string, body?: unknown, cookie?: string, requestOrigin = origin) {
  return fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Origin: requestOrigin, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}), ...(process.env.E2E_BYPASS ? { "x-vercel-protection-bypass": process.env.E2E_BYPASS } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function register(plan = structuredClone(demoPlan)) {
  const roomId = `api-session-test-${crypto.randomUUID()}`;
  const response = await call("/api/room-sessions", { roomId, plan });
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const result = await response.json();
  assert.match(result.plan.projectId, /^proj_room_[a-f0-9]{32}$/);
  assert.equal(result.plan.revision, plan.revision + 1);
  return { ...result, cookie: cookie.split(";")[0], roomId };
}

test("private browser room sessions isolate all project routes, resume safely and compare revisions atomically", async () => {
  const session = await register();
  const prefix = `/api/projects/${session.plan.projectId}`;
  const routes: [string, unknown?][] = [[""], ["/brief"], ["/checkout"], ["/jobs/missing"], ["/shop/missing"], ["/changes", {}], ["/proposals", {}], ["/proposals/missing/apply", {}], ["/place", {}], ["/shop", {}], ["/research", {}], ["/items/missing/move-to", {}], ["/items/missing/store", {}], ["/reset", {}], ["/checkout/recheck", {}], ["/checkout/card", {}], ["/checkout/card/test", {}], ["/checkout/approve", {}], ["/checkout/execute", {}], ["/checkout/revoke", {}]];
  const statuses = await Promise.all(routes.map(async ([path, body]) => [path, (await call(prefix + path, body)).status]));
  assert.ok(statuses.every(([, status]) => status === 404), JSON.stringify(statuses));
  const other = await register();
  assert.equal((await call(prefix, undefined, other.cookie)).status, 404);
  assert.equal((await call(prefix, undefined, session.cookie)).status, 200);
  const revisedInput = structuredClone(demoPlan);
  revisedInput.geometry.rooms[0].height = 50;
  const resumedResponse = await call("/api/room-sessions", { roomId: session.roomId, plan: revisedInput }, session.cookie);
  const resumed = await resumedResponse.json();
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.plan.projectId, session.plan.projectId);
  assert.equal(resumed.plan.geometry.rooms[0].height, demoPlan.geometry.rooms[0].height);
  const snapshot = structuredClone(session.plan);
  snapshot.items.find((item: { id: string }) => item.id === "item_armchair").stored = true;
  const syncPath = `/api/room-sessions/${session.plan.projectId}/sync`;
  const syncBody = { expectedRevision: session.plan.revision, plan: snapshot };
  const results = await Promise.all([call(syncPath, syncBody, session.cookie), call(syncPath, syncBody, session.cookie)]).then((responses) => Promise.all(responses.map((response) => response.json())));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.reason === "stale_revision").length, 1);
  assert.equal((await call(syncPath, syncBody, session.cookie, "https://foreign.example")).status, 403);
  assert.equal((await call(syncPath, syncBody)).status, 404);
  const geometryForgery = structuredClone(results.find((result) => result.ok).plan);
  geometryForgery.geometry.rooms[0].height = 50;
  assert.equal((await call(syncPath, { expectedRevision: geometryForgery.revision, plan: geometryForgery }, session.cookie)).status, 422);
  assert.equal((await call("/api/room-sessions", { roomId: "too-large", plan: "x".repeat(2 * 1024 * 1024) })).status, 413);
});

test("replacement stores owned source furniture and atomically adds the actual product; locked and stale edits refuse", async () => {
  const plan = structuredClone(demoPlan);
  const owned = structuredClone(plan.items[0]);
  owned.locked = false;
  owned.position = [2, 0, 2];
  plan.items = [owned];
  plan.constraints = { budget: null, minimumSeats: null, clearance: 0.1 };
  const session = await register(plan);
  const prefix = `/api/projects/${session.plan.projectId}`;
  const product = session.plan.products.find((entry: { category: string; dimensions: unknown; availability: string }) => entry.category === "chair" && entry.dimensions && entry.availability === "available");
  assert.ok(product);
  const body = { productId: product.id, spot: { position: owned.position }, replaceItemId: owned.id, expectedRevision: session.plan.revision };
  for (const change of [{ kind: "remove", itemId: owned.id }, { kind: "replace", itemId: owned.id, productId: product.id }]) {
    const refused = await call(`${prefix}/changes`, { expectedRevision: session.plan.revision, changes: [change] }, session.cookie).then((response) => response.json());
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "validation_failed");
    assert.match(refused.validations[0].message, /source identity/);
  }
  const resultResponse = await call(`${prefix}/place`, body, session.cookie);
  const result = await resultResponse.json();
  assert.equal(result.ok, true, JSON.stringify(result));
  const old = result.plan.items.find((item: { id: string }) => item.id === owned.id);
  assert.equal(old.stored, true);
  assert.equal(old.origin, "existing_owned");
  assert.deepEqual(old.dimensions, owned.dimensions);
  const added = result.plan.items.find((item: { id: string }) => item.id === result.itemId);
  assert.equal(added.productId, product.id);
  assert.equal(added.origin, "proposed_purchase");
  assert.equal(result.plan.revision, plan.revision + 2);
  const stale = await call(`${prefix}/place`, body, session.cookie).then((response) => response.json());
  assert.equal(stale.reason, "stale_revision");
  const lockedPlan = structuredClone(plan);
  lockedPlan.items[0].locked = true;
  const lockedSession = await register(lockedPlan);
  const locked = await call(`/api/projects/${lockedSession.plan.projectId}/place`, { ...body, expectedRevision: lockedSession.plan.revision }, lockedSession.cookie).then((response) => response.json());
  assert.equal(locked.reason, "locked");
  const read = await call(`/api/projects/${lockedSession.plan.projectId}`, undefined, lockedSession.cookie).then((response) => response.json());
  assert.equal(read.plan.items.length, 1);
  assert.equal(read.plan.revision, lockedPlan.revision + 1);
});
