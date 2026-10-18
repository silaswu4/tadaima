import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { roomSourceIdentity, validateEditedRoom, validateRoomModelBinding, validateRoomDraft, getRoomDraft, saveRoomDraft, getRoom, importRoom, saveEditedPlan, importLocalCapture, bootstrapLocalCapture, listRooms } from "../rooms/registry.ts";
import { prepareLocalShoppingPlan, searchLocalProducts, commitLocalProduct } from "../room/local-shopping.ts";
import { validateLocalTexturedGlb } from "../room/textured-model.ts";
import { getTadaimaRooms, hydrateCatalogRoom, PUBLISHED_SCAN_ID } from "../fixtures/roomsCatalog.ts";

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
  let completedWrites = 0;
  const db = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name) { stores.set(name, new Map()); },
    close() {},
    transaction(name, mode) {
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
        timer = setTimeout(() => { if (mode === "readwrite") completedWrites++; transaction.oncomplete?.(); }, 0);
        return result;
      }
      return transaction;
    },
  };
  return { stores, db, get completedWrites() { return completedWrites; }, factory: { open(name, version) {
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
    // drafts are stored under a versioned key so a demo-room change drops stale drafts
  assert.deepEqual([...adapter.stores.get("catalog-drafts").keys()], ["same-project-room-a@v3", "same-project-room-b@v3"]);

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
  } finally { adapter.db.onversionchange?.(); if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; }
});

/** A real, embedded synthetic GLB: full semantic validation and the actual GLTFLoader run without images or network. */
async function modelFixture(source, revisionLabel = "original", bindingChange = {}, materialMetadata = {}) {
  const { plan, binding } = await roomSourceIdentity(source);
  const buffers = [], bufferViews = [], accessors = [], meshes = [], nodes = [];
  let byteOffset = 0;
  function box(min, max, position, extras, yaw = 0) {
    const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
    const triangles = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
    const data = Buffer.alloc(triangles.length * 12);
    triangles.forEach((corner, vertex) => corners[corner].forEach((axis, component) => data.writeFloatLE(axis ? max[component] : min[component], vertex * 12 + component * 4)));
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length }); buffers.push(data); byteOffset += data.length;
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: triangles.length, type: "VEC3", min, max });
    meshes.push({ primitives: [{ attributes: { POSITION: accessors.length - 1 }, material: 0 }] });
    nodes.push({ mesh: meshes.length - 1, translation: position, rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], extras });
  }
  const room = plan.geometry.rooms[0], xs = room.floorPolygon.map(p => p[0]), zs = room.floorPolygon.map(p => p[1]);
  box([Math.min(...xs), -.08, Math.min(...zs)], [Math.max(...xs), 0, Math.max(...zs)], [0, 0, 0], { entityId: room.id, role: "room_floor", appearanceStatus: "photo_projected" });
  for (const wall of plan.geometry.walls) {
    const dx = wall.end[0] - wall.start[0], dz = wall.end[1] - wall.start[1];
    box([0, 0, -wall.thickness / 2], [Math.hypot(dx, dz), wall.height, wall.thickness / 2], [wall.start[0], 0, wall.start[1]], { entityId: wall.id, role: "wall" }, -Math.atan2(dz, dx));
  }
  for (const item of plan.items) {
    const [w, h, d] = item.dimensions;
    box([-w / 2, 0, -d / 2], [w / 2, h, d / 2], item.position, { entityId: item.id, role: "existing_furniture", appearanceStatus: "photo_projected" });
  }
  const binary = Buffer.concat(buffers);
  const raw = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i), extras: { projectId: plan.projectId, inputRevision: String(plan.revision), jobId: binding.jobId, inputSha256: binding.inputSha256, modelRevision: revisionLabel, ...bindingChange } }],
    nodes, meshes, accessors, bufferViews, buffers: [{ byteLength: binary.length }], materials: [{ extras: materialMetadata, pbrMetallicRoughness: { baseColorFactor: [.5, .4, .3, 1], metallicFactor: 0, roughnessFactor: .8 } }] };
  const text = Buffer.from(JSON.stringify(raw)), padded = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 32)]);
  const bytes = Buffer.alloc(28 + padded.length + binary.length);
  bytes.writeUInt32LE(0x46546C67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(padded.length, 12); bytes.writeUInt32LE(0x4E4F534A, 16); padded.copy(bytes, 20);
  bytes.writeUInt32LE(binary.length, 20 + padded.length); bytes.writeUInt32LE(0x004E4942, 24 + padded.length); binary.copy(bytes, 28 + padded.length);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function modelSource() {
  const raw = JSON.parse(fixture());
  raw.geometry.openings = [];
  return JSON.stringify(raw, null, 2) + "\n";
}

async function withRoomStorage(run) {
  const previous = globalThis.indexedDB, adapter = storageAdapter();
  const parseAsync = GLTFLoader.prototype.parseAsync;
  // tsx compiles the registry/binder through CJS while GLTFLoader is native ESM.
  // Normalize only the test loader result to the binder's Three.js class realm;
  // real GLB parsing, metadata checks and semantic geometry validation still run.
  const { ObjectLoader } = createRequire(import.meta.url)("three");
  GLTFLoader.prototype.parseAsync = async function (...args) {
    const gltf = await parseAsync.apply(this, args);
    return { ...gltf, scene: new ObjectLoader().parse(gltf.scene.toJSON()) };
  };
  globalThis.indexedDB = adapter.factory;
  try { await run(adapter); }
  finally { GLTFLoader.prototype.parseAsync = parseAsync; adapter.db.onversionchange?.(); if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; }
}

test("explicit verified model upgrade preserves source bytes, label, accepted furniture and basket revision", async () => withRoomStorage(async () => {
  const source = modelSource(), originalModel = await modelFixture(source), upgradedModel = await modelFixture(source, "baked-light");
  const original = await importRoom(source, originalModel, "Saved scan");
  const shopping = prepareLocalShoppingPlan(original.editedPlan), spot = { position: [3, 0, 2.3] };
  const offer = searchLocalProducts(shopping, { category: "chair", spot }).find(entry => entry.fits && entry.product.availability === "available");
  assert.ok(offer);
  const accepted = commitLocalProduct(shopping, offer.product.id, spot, shopping.revision);
  assert.equal(accepted.ok, true);
  accepted.plan.items[0].stored = true; accepted.plan.items[0].position = [2, 0, 1]; accepted.plan.items[0].locked = true;
  await saveEditedPlan(original.id, accepted.plan);
  const before = await getRoom(original.id);
  const updated = await importRoom(source, upgradedModel, "Do not rename", { replaceModel: true });
  assert.deepEqual(updated, { ...before, model: upgradedModel });
  assert.notDeepEqual(updated.model, original.model);
  assert.deepEqual(await getRoom(original.id), updated, "the replacement is durable");
  assert.equal(updated.sourceJson, source); assert.equal(updated.editedPlan.items.length, 2);
  assert.equal(updated.editedPlan.items[1].productId, offer.product.id);
}));

test("regular reimport preserves the existing model and accepted edits", async () => withRoomStorage(async () => {
  const source = modelSource(), originalModel = await modelFixture(source), newerModel = await modelFixture(source, "baked-light");
  const saved = await importRoom(source, originalModel, "Existing room");
  const edited = structuredClone(saved.editedPlan); edited.revision++; edited.items[0].stored = true;
  await saveEditedPlan(saved.id, edited);
  const before = await getRoom(saved.id);
  assert.deepEqual(await importRoom(source, newerModel, "Different label"), before);
}));

test("model upgrade rejects a mismatched GLB before writing the saved room", async () => withRoomStorage(async (adapter) => {
  const source = modelSource(), saved = await importRoom(source, await modelFixture(source));
  const before = structuredClone(adapter.stores.get("rooms").get(saved.id));
  await assert.rejects(importRoom(source, await modelFixture(source, "wrong", { jobId: "another-scan" }), undefined, { replaceModel: true }), /different scan or revision/);
  assert.deepEqual(adapter.stores.get("rooms").get(saved.id), before);
}));

test("model upgrade requires both a supplied GLB and an existing matching scan", async () => withRoomStorage(async (adapter) => {
  const source = modelSource();
  await assert.rejects(importRoom(source, undefined, undefined, { replaceModel: true }), /choose a matching GLB/);
  await assert.rejects(importRoom(source, await modelFixture(source), undefined, { replaceModel: true }), /not saved/);
  assert.deepEqual([...adapter.stores.get("rooms").keys()], ["migration-sentinel"], "neither failure writes a new room");
}));

test("malformed baked lighting is rejected before replacing a verified room model", async () => withRoomStorage(async (adapter) => {
  const source = modelSource(), saved = await importRoom(source, await modelFixture(source));
  const before = structuredClone(adapter.stores.get("rooms").get(saved.id));
  await assert.rejects(importRoom(source, await modelFixture(source, "wrong-profile", {}, { tadaimaIndirectLightmap: "untrusted-profile" }), undefined, { replaceModel: true }), /Unsupported baked room lighting profile/);
  await assert.rejects(importRoom(source, await modelFixture(source, "wrong-scale", {}, { tadaimaIndirectLightmap: "cycles-diffuse-indirect-v1", tadaimaIndirectScale: -1 }), undefined, { replaceModel: true }), /invalid intensity scale/);
  await assert.rejects(importRoom(source, await modelFixture(source, "missing-uv-and-texture", {}, { tadaimaIndirectLightmap: "cycles-diffuse-indirect-v1" }), undefined, { replaceModel: true }), /Baked room lighting needs/);
  assert.deepEqual(adapter.stores.get("rooms").get(saved.id), before, "failed lighting validation leaves the saved room untouched");
}));

test("authenticated local bootstrap upgrades an existing model without losing source, edits, basket or revision", async () => withRoomStorage(async (adapter) => {
  const previousFetch = globalThis.fetch, previousWindow = globalThis.window;
  const source = modelSource(), token = "d".repeat(64);
  let deliveredModel = await modelFixture(source), requiredWrites = 1, consumed = 0, storedToken = token;
  const location = { hash: `#local-scan=${token}&keep=room`, pathname: "/rooms", search: "?view=walk" };
  globalThis.window = { location, dispatchEvent() {},
    sessionStorage: { getItem: () => storedToken, removeItem: () => { storedToken = null; } },
    history: { replaceState(_state, _title, url) {
      assert.ok(adapter.completedWrites >= requiredWrites, "the capability is consumed only after the room transaction completes");
      consumed++; assert.equal(url, "/rooms?view=walk#keep=room"); location.hash = "#keep=room";
    } },
  };
  globalThis.fetch = async (url) => url.endsWith("/scene") ? new Response(source) : new Response(deliveredModel);
  try {
    const first = await bootstrapLocalCapture();
    assert.deepEqual(first.model, deliveredModel); assert.equal(consumed, 1); assert.equal(storedToken, null);
    const shopping = prepareLocalShoppingPlan(first.editedPlan), spot = { position: [3, 0, 2.3] };
    const offer = searchLocalProducts(shopping, { category: "chair", spot }).find(entry => entry.fits && entry.product.availability === "available");
    assert.ok(offer);
    const accepted = commitLocalProduct(shopping, offer.product.id, spot, shopping.revision);
    assert.equal(accepted.ok, true); accepted.plan.items[0].stored = true; accepted.plan.items[0].locked = true;
    await saveEditedPlan(first.id, accepted.plan);
    const before = await getRoom(first.id);
    deliveredModel = await modelFixture(source, "latest-hybrid-bake");
    location.hash = `#local-scan=${token}&keep=room`; storedToken = token; requiredWrites = adapter.completedWrites + 1;
    const upgraded = await bootstrapLocalCapture();
    assert.deepEqual(upgraded, { ...before, model: deliveredModel });
    assert.deepEqual(await getRoom(first.id), upgraded);
    assert.equal(upgraded.editedPlan.items[1].productId, offer.product.id);
    assert.equal(consumed, 2); assert.equal(storedToken, null); assert.equal(location.hash, "#keep=room");
  } finally { globalThis.fetch = previousFetch; if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
}));

test("local bootstrap rejects a different model binding without replacing a saved room or consuming the capability", async () => withRoomStorage(async (adapter) => {
  const previousFetch = globalThis.fetch, previousWindow = globalThis.window;
  const source = modelSource(), token = "e".repeat(64);
  const saved = await importRoom(source, await modelFixture(source));
  const before = await getRoom(saved.id), beforeWrites = adapter.completedWrites;
  const wrongModel = await modelFixture(source, "wrong-input", { inputSha256: "0".repeat(64) });
  globalThis.window = { location: { hash: `#local-scan=${token}`, pathname: "/rooms", search: "" }, dispatchEvent() {},
    sessionStorage: { getItem: () => token, removeItem: () => assert.fail("a failed update cannot consume the capability") },
    history: { replaceState: () => assert.fail("a failed update cannot consume the URL capability") },
  };
  globalThis.fetch = async (url) => url.endsWith("/scene") ? new Response(source) : new Response(wrongModel);
  try {
    await assert.rejects(bootstrapLocalCapture(), /different scan or revision/);
    assert.deepEqual(await getRoom(saved.id), before);
    assert.equal(adapter.completedWrites, beforeWrites);
    assert.equal(globalThis.window.location.hash, `#local-scan=${token}`);
  } finally { globalThis.fetch = previousFetch; if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
}));

// Schema parsing / HTTP transport may reorder keys without changing source facts.
test("server JSON key ordering does not invalidate immutable scan furniture", async () => {
  const { plan } = await roomSourceIdentity(fixture());
  const reorder = (value) => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reorder(entry)])) : value;
  const snapshot = reorder(structuredClone(plan)); snapshot.revision++;
  assert.doesNotThrow(() => validateEditedRoom(plan, snapshot));
  snapshot.items[0].dimensions[0] += .1;
  assert.throws(() => validateEditedRoom(plan, snapshot), /dimensions and source IDs/);
});


const publishedAsset = (name) => readFileSync(new URL(`../../public/demo/scanned-living-room/${name}`, import.meta.url));
test("published scan keeps the measured source, verified baked model and a distinct shared room ID", async () => {
  const source = publishedAsset("scene.json"), model = publishedAsset("scene.glb"), manifest = JSON.parse(publishedAsset("manifest.json"));
  assert.equal(createHash("sha256").update(source).digest("hex"), manifest.sourceSha256);
  assert.equal(createHash("sha256").update(model).digest("hex"), manifest.modelSha256);
  assert.equal(source.length, manifest.sourceBytes); assert.equal(model.length, manifest.modelBytes);
  const identity = await roomSourceIdentity(source.toString());
  assert.notEqual(identity.binding.inputSha256, manifest.originalSourceSha256, "sanitization has a separate identity");
  assert.equal(identity.plan.items.length, 28); assert.equal(identity.plan.geometry.walls.length, 12); assert.equal(identity.plan.geometry.openings.length, 4);
  assert.ok(identity.plan.evidence.every((entry) => entry.privateAssetId === null && entry.sourceUrl === null));
  assert.ok(identity.plan.items.every((item) => item.origin === "existing_owned" && item.productId === null));
  const room = getTadaimaRooms().find((entry) => entry.id === PUBLISHED_SCAN_ID);
  assert.equal(room.source, "tadaima-scan"); assert.deepEqual(room.plan, identity.plan);
  assert.ok(!room.id.startsWith("local-scan-"), "private room and accepted edits are not overwritten");
  const raw = validateLocalTexturedGlb(model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength));
  validateRoomModelBinding(raw, identity.plan, identity.binding);
  assert.ok(raw.materials.some((material) => material.extras?.tadaimaIndirectLightmap), "baked lighting is retained");
});

test("published model contains no source paths, raw photo links or EXIF and preserves geometry/pixel payloads", () => {
  const source = publishedAsset("scene.json"), model = publishedAsset("scene.glb"), manifest = JSON.parse(publishedAsset("manifest.json"));
  const jsonLength = model.readUInt32LE(12), raw = JSON.parse(model.subarray(20, 20 + jsonLength)), binary = model.subarray(28 + jsonLength);
  for (const metadata of [source.toString(), JSON.stringify(raw)]) assert.doesNotMatch(metadata, /\/Users\/|file:\/\/|\/private\/|\/var\/|https?:\/\/|photos\/|\.jpe?g/i);
  const imageViews = new Set(raw.images.map((image) => image.bufferView)), geometry = createHash("sha256"), pixels = createHash("sha256");
  for (const [index, view] of raw.bufferViews.entries()) {
    const data = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    if (!imageViews.has(index)) { geometry.update(data); continue; }
    assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    let position = 8;
    while (position + 12 <= data.length) {
      const length = data.readUInt32BE(position), kind = data.toString("ascii", position + 4, position + 8);
      assert.ok(!["eXIf", "tEXt", "zTXt", "iTXt"].includes(kind), "image metadata was removed");
      if (kind === "IDAT") pixels.update(data.subarray(position + 8, position + 8 + length));
      position += 12 + length;
    }
    assert.equal(position, data.length);
  }
  assert.equal(geometry.digest("hex"), manifest.geometryPayloadSha256);
  assert.equal(pixels.digest("hex"), manifest.imagePixelPayloadSha256);
});

test("published scan hydration shares one validated download and retries a failed download", async () => {
  const previous = globalThis.fetch, room = getTadaimaRooms().find((entry) => entry.id === PUBLISHED_SCAN_ID);
  const model = publishedAsset("scene.glb"); let calls = 0, fail = true;
  globalThis.fetch = async (url, options) => {
    calls++; assert.equal(url, "/demo/scanned-living-room/scene.glb"); assert.equal(options.credentials, "same-origin");
    return fail ? new Response("missing", { status: 404 }) : new Response(model);
  };
  try {
    const normal = getTadaimaRooms().find((entry) => entry.id !== PUBLISHED_SCAN_ID);
    assert.equal(await hydrateCatalogRoom(normal), normal); assert.equal(calls, 0);
    await assert.rejects(hydrateCatalogRoom(room), /could not download/); assert.equal(calls, 1);
    fail = false;
    const [a, b] = await Promise.all([hydrateCatalogRoom(room), hydrateCatalogRoom(room)]);
    assert.equal(calls, 2); assert.equal(a.reconstruction, b.reconstruction);
    assert.deepEqual(a.plan, room.plan); assert.deepEqual(a.reconstruction.plan, room.plan);
    assert.equal(a.reconstruction.texturedModel.byteLength, model.length);
  } finally { globalThis.fetch = previous; }
});
