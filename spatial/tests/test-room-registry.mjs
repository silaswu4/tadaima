import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { roomSourceIdentity, validateEditedRoom, validateRoomModelBinding, validateRoomDraft, getRoomDraft, saveRoomDraft, getRoom, importRoom, saveEditedPlan, importLocalCapture, bootstrapLocalCapture, listRooms } from "../rooms/registry.ts";
import { prepareLocalShoppingPlan, searchLocalProducts, commitLocalProduct } from "../room/local-shopping.ts";
import { getTadaimaRooms } from "../fixtures/roomsCatalog.ts";

function fixture() {
  const raw = JSON.parse(readFileSync(new URL("../../reconstruction/fixtures/living-room.request.json", import.meta.url), "utf8"));
  raw.items = [{ id: "chair", roomId: "living-room", label: "Captured chair", origin: "existing_owned", productId: null, assetUrl: null,
    position: [1, 0, 1], rotationY: 0, dimensions: [.5, .9, .5], locked: false, evidenceIds: ["synthetic-reference"] }];
  return JSON.stringify(raw, null, 2) + "\n";
}

test("private room identity binds exact original bytes and uses a demo-safe namespace", async () => {
  const source = fixture(), identity = await roomSourceIdentity(source);
  const hash = createHash("sha256").update(source).digest("hex");
  assert.equal(identity.id, `local-scan-${hash}`);
  assert.equal(identity.binding.inputSha256, hash);
  assert.equal(identity.binding.jobId, "demo-shell-001");
  assert.equal(identity.plan.projectId, "synthetic-living-room");
  assert.notEqual((await roomSourceIdentity(source.trim())).id, identity.id, "whitespace changes exact source binding");
});

test("private room identity rejects invalid or oversized source before storage", async () => {
  await assert.rejects(roomSourceIdentity("{}"), /Room file/);
  await assert.rejects(roomSourceIdentity(" ".repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
});

test("edited room preserves original source and allows a stored or moved captured piece", async () => {
  const { plan } = await roomSourceIdentity(fixture()), candidate = structuredClone(plan);
  candidate.revision++;
  candidate.items[0].position = [2, 0, 1.2]; candidate.items[0].rotationY = 1.2;
  candidate.items[0].locked = true; candidate.items[0].stored = true;
  const saved = validateEditedRoom(plan, candidate);
  assert.equal(saved.items[0].stored, true);
  assert.deepEqual(saved.items[0].position, [2, 0, 1.2]);
  assert.deepEqual(plan.items[0].position, [1, 0, 1]);
  assert.notEqual(saved, candidate, "caller mutation cannot alter the validated snapshot");
});

test("edited room allows removing furniture without changing its immutable reconstruction source", async () => {
  const { plan } = await roomSourceIdentity(fixture()), candidate = structuredClone(plan);
  candidate.items = []; candidate.revision++;
  assert.equal(validateEditedRoom(plan, candidate).items.length, 0);
  assert.equal(plan.items.length, 1);
});

test("captured furniture can move between measured rooms without changing source geometry or identity", async () => {
  const request = JSON.parse(fixture());
  request.geometry.rooms.push({ ...structuredClone(request.geometry.rooms[0]), id: "next-room", label: "Next measured room",
    floorPolygon: [[4.2, 0], [8.4, 0], [8.4, 3.5], [4.2, 3.5]] });
  const { plan } = await roomSourceIdentity(JSON.stringify(request));
  const moved = structuredClone(plan); moved.revision++;
  moved.items[0].roomId = "next-room"; moved.items[0].position = [6, 0, 1.5];
  const saved = validateEditedRoom(plan, moved);
  assert.equal(saved.items[0].id, plan.items[0].id);
  assert.equal(saved.items[0].roomId, "next-room");
  assert.deepEqual(saved.geometry, plan.geometry);
  assert.equal(plan.items[0].roomId, "living-room");
  moved.items[0].roomId = "invented-room";
  assert.throws(() => validateEditedRoom(plan, moved), /unknown room/);
});

test("captured room accepts a real local shopping proposal while preserving every measured source item", async () => {
  const { plan } = await roomSourceIdentity(fixture()), shopping = prepareLocalShoppingPlan(plan), spot = { position: [3, 0, 2.3] };
  const offer = searchLocalProducts(shopping, { category: "chair", spot }).find((entry) => entry.fits && entry.product.availability === "available");
  assert.ok(offer, "saved catalog contains a chair that fits the synthetic open spot");
  const result = commitLocalProduct(shopping, offer.product.id, spot, shopping.revision);
  assert.equal(result.ok, true);
  const saved = validateEditedRoom(plan, result.plan);
  assert.equal(saved.items.length, 2);
  assert.deepEqual(saved.items[0], plan.items[0]);
  assert.equal(saved.items[1].origin, "proposed_purchase");
  assert.equal(saved.items[1].productId, offer.product.id);
});

for (const [name, change] of Object.entries({
  "different project": p => { p.projectId = "another"; },
  "old revision": p => { p.revision--; },
  "fractional revision": p => { p.revision += .5; },
  "source geometry alteration": p => { p.geometry.rooms[0].height += .1; },
  "source dimensions alteration": p => { p.items[0].dimensions[0] += .1; },
  "captured ID forgery": p => { p.items[0].id = "other-chair"; },
  "source evidence alteration": p => { p.evidence[0].claim = "new claim"; },
  "source evidence deletion": p => { p.evidence = []; },
  "invalid transform": p => { p.items[0].position[0] = Infinity; },
  "negative dimensions": p => { p.items[0].dimensions[0] = -1; },
  "duplicate item IDs": p => { p.items.push(structuredClone(p.items[0])); },
  "new owned furniture": p => { p.items.push({ ...p.items[0], id: "invented" }); },
  "invalid stored state": p => { p.items[0].stored = "yes"; },
  "missing constraints": p => { delete p.constraints; },
  "negative clearance": p => { p.constraints.clearance = -1; },
})) test(`private room edits reject ${name}`, async () => {
  const { plan } = await roomSourceIdentity(fixture()), candidate = structuredClone(plan);
  change(candidate);
  assert.throws(() => validateEditedRoom(plan, candidate), /Private room/);
});

test("room GLB must bind the exact original source job, project, revision and SHA", async () => {
  const { plan, binding } = await roomSourceIdentity(fixture());
  const metadata = { projectId: plan.projectId, inputRevision: String(plan.revision), jobId: binding.jobId, inputSha256: binding.inputSha256 };
  validateRoomModelBinding({ scenes: [{ extras: metadata }] }, plan, binding);
  validateRoomModelBinding({ scenes: [{ extras: { ...metadata, inputSha256: "different", sourceRequestSha256: binding.inputSha256 } }] }, plan, binding);
  for (const key of ["projectId", "inputRevision", "jobId", "inputSha256"]) {
    assert.throws(() => validateRoomModelBinding({ scenes: [{ extras: { ...metadata, [key]: "wrong" } }] }, plan, binding), /different scan or revision/);
  }
  assert.throws(() => validateRoomModelBinding({ scenes: [] }, plan, binding), /different scan or revision/);
});

test("invalid local capability fails before any fetch", async () => {
  const previous = globalThis.fetch; let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not fetch"); };
  try { await assert.rejects(importLocalCapture("not-a-token"), /invalid/); assert.equal(called, false); }
  finally { globalThis.fetch = previous; }
});

test("local preview requests are fixed same-origin routes with a private bearer header", async () => {
  const previous = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return new Response("missing", { status: 404 }); };
  try {
    await assert.rejects(importLocalCapture("a".repeat(64)), /unavailable/);
    assert.deepEqual(requests.map(r => r.url), ["/api/local-capture/scene", "/api/local-capture/model"]);
    for (const request of requests) {
      assert.equal(request.options.headers.authorization, `Bearer ${"a".repeat(64)}`);
      assert.equal(request.options.cache, "no-store");
      assert.equal(request.options.redirect, "error");
      assert.equal(request.url.includes("a".repeat(64)), false);
    }
  } finally { globalThis.fetch = previous; }
});

test("oversized local streaming response is bounded before JSON or GLB parsing", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 200, headers: { "content-length": String(65 * 1024 * 1024) } });
  try { await assert.rejects(importLocalCapture("b".repeat(64)), /file size/); }
  finally { globalThis.fetch = previous; }
});

test("concurrent React effect bootstrap imports share one local fetch and failures retain the capability", async () => {
  const previousFetch = globalThis.fetch, previousWindow = globalThis.window;
  const requests = [], token = "c".repeat(64);
  globalThis.window = { location: { hash: `#local-scan=${token}`, pathname: "/rooms", search: "" },
    sessionStorage: { getItem: () => null }, history: { replaceState: () => assert.fail("failed imports must not consume their link") } };
  globalThis.fetch = async (url) => { requests.push(url); return new Response("missing", { status: 404 }); };
  try {
    const result = await Promise.allSettled([bootstrapLocalCapture(), bootstrapLocalCapture()]);
    assert.ok(result.every(entry => entry.status === "rejected"));
    assert.equal(requests.length, 2, "one scene and one model request across two concurrent callers");
    assert.equal(globalThis.window.location.hash, `#local-scan=${token}`);
    await assert.rejects(bootstrapLocalCapture(), /unavailable/);
    assert.equal(requests.length, 4, "a later retry is allowed after the failed promise settles");
  } finally { globalThis.fetch = previousFetch; if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});

test("server render has no fallback storage or accidental network access", async () => {
  await assert.rejects(listRooms(), /storage is unavailable/);
});

test("catalog drafts validate and clone canonical plans separately from private source bindings", async () => {
  const { plan } = await roomSourceIdentity(fixture());
  const draft = validateRoomDraft(plan);
  assert.deepEqual(draft, plan); assert.notEqual(draft, plan);
  for (const change of [p => { p.schemaVersion = "fake"; }, p => { p.items[0].position[0] = NaN; }, p => { p.revision = -.1; },
    p => { p.items.push(structuredClone(p.items[0])); }, p => { p.geometry.rooms[0].height = 0; }]) {
    const invalid = structuredClone(plan); change(invalid);
    assert.throws(() => validateRoomDraft(invalid), /Private room/);
  }
});

test("catalog draft IDs cannot alias private scans or inject object-store paths", async () => {
  const { plan } = await roomSourceIdentity(fixture());
  for (const id of ["local-scan-example", "../living-room", "", "x".repeat(129)]) {
    await assert.rejects(getRoomDraft(id), /invalid catalog room ID/);
    await assert.rejects(saveRoomDraft(id, plan), /invalid catalog room ID/);
  }
});

for (const room of getTadaimaRooms()) test(`catalog room ${room.id} and its valid furniture edits pass persistence validation`, () => {
  assert.deepEqual(validateRoomDraft(room.plan), JSON.parse(JSON.stringify(room.plan)), "JSON storage normalizes -0 to 0");
  const edited = structuredClone(room.plan);
  const item = edited.items[0];
  item.locked = false; item.stored = true;
  item.position[0] += .01; item.rotationY += Math.PI / 4;
  edited.revision++;
  const saved = validateRoomDraft(edited);
  assert.equal(saved.items[0].stored, true);
  assert.deepEqual(saved.items[0].position, item.position);
  assert.deepEqual(saved.geometry, room.plan.geometry);
  assert.notDeepEqual(saved.items[0], room.plan.items[0]);
  assert.deepEqual(validateRoomDraft(JSON.parse(JSON.stringify(saved))), saved, "JSON reload preserves the valid snapshot");
});

/** Small deterministic storage adapter for registry unit tests, not a claim about browser IndexedDB behavior.
 * Native import/reload and GLB persistence are separately exercised in browser QA. */
function storageAdapter() {
  const stores = new Map([["rooms", new Map([["migration-sentinel", { privateScan: "retained" }]])]]);
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name) { stores.set(name, new Map()); },
    close() {},
    transaction(name) {
      const records = stores.get(name);
      assert.ok(records, `store ${name} must exist`);
      let timer;
      const transaction = {
        abort() { clearTimeout(timer); queueMicrotask(() => transaction.onabort?.()); },
        objectStore() { return {
          get: key => request(() => structuredClone(records.get(key))),
          put: value => request(() => { records.set(value.id, structuredClone(value)); return value.id; }),
          delete: key => request(() => records.delete(key)),
          getAll: () => request(() => [...records.values()].map(value => structuredClone(value))),
        }; },
      };
      function request(action) {
        const result = {};
        clearTimeout(timer);
        queueMicrotask(() => {
          try { result.result = action(); result.onsuccess?.(); }
          catch (cause) { result.error = cause; result.onerror?.(); transaction.onerror?.(); }
        });
        timer = setTimeout(() => transaction.oncomplete?.(), 0);
        return result;
      }
      return transaction;
    },
  };
  return { stores, factory: { open(name, version) {
    assert.equal(name, "tadaima-private-rooms"); assert.equal(version, 2);
    const request = { result: db };
    queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
    return request;
  } } };
}

test("catalog storage isolates two room IDs sharing one project and preserves private records on v2 upgrade", async () => {
  const previous = globalThis.indexedDB, adapter = storageAdapter();
  globalThis.indexedDB = adapter.factory;
  try {
    const { plan } = await roomSourceIdentity(fixture()), first = structuredClone(plan), second = structuredClone(plan);
    first.revision++; second.revision++;
    first.items[0].position = [1.2, 0, 1]; second.items[0].position = [2.2, 0, 2];
    await saveRoomDraft("same-project-room-a", first);
    await saveRoomDraft("same-project-room-b", second);
    await saveRoomDraft("same-project-room-a", structuredClone(first)); // exact idempotent retry
    const equalRevisionConflict = structuredClone(first); equalRevisionConflict.items[0].position[0] += .2;
    await assert.rejects(saveRoomDraft("same-project-room-a", equalRevisionConflict), /different or newer/);
    assert.equal(first.projectId, second.projectId);
    assert.deepEqual((await getRoomDraft("same-project-room-a")).items[0].position, [1.2, 0, 1]);
    assert.deepEqual((await getRoomDraft("same-project-room-b")).items[0].position, [2.2, 0, 2]);
    first.revision++; first.items[0].stored = true;
    await saveRoomDraft("same-project-room-a", first);
    assert.equal((await getRoomDraft("same-project-room-a")).items[0].stored, true);
    assert.equal((await getRoomDraft("same-project-room-b")).items[0].stored, undefined);
    assert.equal(await getRoomDraft("missing-catalog-room"), null);
    await assert.rejects(saveRoomDraft("same-project-room-a", plan), /newer room draft/);
    const wrongProject = structuredClone(first); wrongProject.projectId = "unrelated-project";
    await assert.rejects(saveRoomDraft("same-project-room-a", wrongProject), /different or newer/);
    assert.deepEqual(adapter.stores.get("rooms").get("migration-sentinel"), { privateScan: "retained" });
    assert.deepEqual([...adapter.stores.get("catalog-drafts").keys()], ["same-project-room-a", "same-project-room-b"]);

    const imported = await importRoom(fixture());
    await saveEditedPlan(imported.id, imported.editedPlan); // opening the identical source is harmless
    const conflict = structuredClone(imported.editedPlan); conflict.items[0].stored = true;
    await assert.rejects(saveEditedPlan(imported.id, conflict), /conflicting edit/);
    conflict.revision++;
    await saveEditedPlan(imported.id, conflict);
    await saveEditedPlan(imported.id, structuredClone(conflict)); // identical retry stays valid
    await assert.rejects(saveEditedPlan(imported.id, imported.editedPlan), /newer or conflicting edit/);
    const sameRevisionPrivateConflict = structuredClone(conflict); sameRevisionPrivateConflict.items[0].rotationY += .2;
    await assert.rejects(saveEditedPlan(imported.id, sameRevisionPrivateConflict), /conflicting edit/);
    const read = await getRoom(imported.id);
    assert.deepEqual(read.editedPlan, conflict);
    assert.equal(read.sourceJson, fixture());
    const reopened = await importRoom(fixture());
    assert.deepEqual(reopened.editedPlan, conflict, "opening the same original scan preserves its newer accepted plan");
    assert.deepEqual(reopened.sourcePlan, imported.sourcePlan);
  } finally { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; }
});
