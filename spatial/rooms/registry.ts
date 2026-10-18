import type { RoomPlan } from "../../backend/contracts";
import { MAX_ROOM_IMPORT_BYTES, parseRoomImport } from "../room/import-room";
import { validatePlan } from "../room/plan";
import type { CapturedRoomBinding } from "../room/textured-model";

const DATABASE = "tadaima-private-rooms";
const STORE = "rooms";
const DRAFT_STORE = "catalog-drafts";
/** Bump when demo rooms change shape (v2: pieces are the shopper's own and unlocked), so old drafts are ignored. */
const DRAFT_VERSION = 3;
const draftKey = (id: string) => `${id}@v${DRAFT_VERSION}`;
const CHANGE_EVENT = "tadaima:rooms-changed";
const CHANNEL = "tadaima-private-rooms";
const MAX_EDITED_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();

/** Private, browser-owned data. sourceJson and its binding never change when a plan is edited. */
export type RoomRecord = {
  id: string;
  label: string;
  sourceJson: string;
  sourcePlan: RoomPlan;
  binding: CapturedRoomBinding;
  model?: ArrayBuffer;
  editedPlan: RoomPlan;
  updatedAt: string;
};
export type RoomSummary = Omit<RoomRecord, "sourceJson" | "model"> & { hasModel: boolean };
type StoredRoom = Omit<RoomRecord, "model"> & { version: 1; modelBlob?: Blob };

function fail(message: string): never { throw new Error(`Private room: ${message}`); }
function clone<T>(value: T): T { return structuredClone(value); }
function orderedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, orderedJson(entry)]));
  return value;
}
function jsonEqual(a: unknown, b: unknown) { return JSON.stringify(orderedJson(a)) === JSON.stringify(orderedJson(b)); }

export async function roomSourceIdentity(sourceJson: string): Promise<{ id: string; plan: RoomPlan; binding: CapturedRoomBinding }> {
  const plan = parseRoomImport(sourceJson);
  if (!globalThis.crypto?.subtle) fail("open Tadaima on HTTPS or localhost to import a scan.");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(sourceJson))), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id: `local-scan-${hash}`, plan, binding: { jobId: JSON.parse(sourceJson).jobId, inputSha256: hash } };
}

/** Keep the measured source immutable while allowing furniture moves, storage and new purchases. */
export function validateEditedRoom(source: RoomPlan, candidate: RoomPlan): RoomPlan {
  let serialized: string;
  try { serialized = JSON.stringify(candidate); } catch { return fail("the edited plan cannot be saved."); }
  if (!serialized || encoder.encode(serialized).byteLength > MAX_EDITED_BYTES) fail("the edited plan exceeds 4 MiB.");
  const plan = JSON.parse(serialized) as RoomPlan;
  if (plan.projectId !== source.projectId || !Number.isSafeInteger(plan.revision) || plan.revision < source.revision
    || !jsonEqual(plan.geometry, source.geometry) || !jsonEqual(plan.appearance, source.appearance)) fail("edits must keep this scan’s identity, measured room and finishes.");
  if (!Array.isArray(plan.items) || !Array.isArray(plan.products) || !Array.isArray(plan.evidence)
    || plan.items.length > 512 || plan.products.length > 1024 || plan.evidence.length > 4096 || !plan.constraints
    || !Number.isFinite(plan.constraints.clearance) || plan.constraints.clearance < 0) fail("the edited plan has invalid data.");
  const originals = new Map(source.items.map((item) => [item.id, item]));
  const evidence = new Map(plan.evidence.map((entry) => [entry.id, entry]));
  if (evidence.size !== plan.evidence.length || source.evidence.some((entry) => !jsonEqual(entry, evidence.get(entry.id)))) fail("source observations cannot be changed.");
  for (const item of plan.items) {
    if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.id)
      || typeof item.label !== "string" || typeof item.locked !== "boolean" || (item.stored !== undefined && typeof item.stored !== "boolean")
      || !Array.isArray(item.position) || item.position.length !== 3 || !item.position.every((axis) => Number.isFinite(axis) && Math.abs(axis) <= 10000)
      || !Number.isFinite(item.rotationY) || (item.dimensions !== null && (!Array.isArray(item.dimensions) || item.dimensions.length !== 3
        || !item.dimensions.every((axis) => Number.isFinite(axis) && axis > 0 && axis <= 1000)))) fail("a furniture transform or size is invalid.");
    const original = originals.get(item.id);
    if (original) {
      // Compare only immutable fields. stored is a product edit, never a new source observation.
      const fixed = (value: typeof item) => Object.fromEntries(Object.entries(value).filter(([key]) => !["position", "rotationY", "roomId", "locked", "stored"].includes(key)));
      if (!jsonEqual(fixed(original), fixed(item))) fail("captured furniture dimensions and source IDs cannot be changed.");
    } else if (item.origin !== "proposed_purchase") fail("new furniture must be a shopping proposal.");
  }
  try {
    const errors = validatePlan(plan).filter((issue) => issue.severity === "error");
    if (errors.length) fail(errors[0].message);
  } catch (cause) { return fail(cause instanceof Error ? cause.message : "the edited plan is invalid."); }
  return plan;
}

export function validateRoomModelBinding(raw: Record<string, unknown>, plan: RoomPlan, binding: CapturedRoomBinding) {
  const scenes = raw.scenes as { extras?: Record<string, unknown> }[] | undefined;
  const metadata = scenes?.[0]?.extras;
  if (!metadata || metadata.projectId !== plan.projectId || metadata.inputRevision !== String(plan.revision)
    || metadata.jobId !== binding.jobId || (metadata.sourceRequestSha256 !== binding.inputSha256 && metadata.inputSha256 !== binding.inputSha256)) {
    fail("the GLB belongs to a different scan or revision. Choose the matching reconstruction JSON and GLB.");
  }
}

/** Preflight forbids remote assets; semantic checks inspect every loaded room entity and measured pose. */
export async function validateRoomModel(model: ArrayBuffer, plan: RoomPlan, binding: CapturedRoomBinding): Promise<void> {
  const [{ validateLocalTexturedGlb, bindTexturedRoom }, { GLTFLoader }, { applyBakedIndirect }] = await Promise.all([
    import("../room/textured-model"), import("three/examples/jsm/loaders/GLTFLoader.js"), import("../room/baked-indirect"),
  ]);
  validateRoomModelBinding(validateLocalTexturedGlb(model), plan, binding);
  const gltf = await new GLTFLoader().parseAsync(model, "");
  // The binder reparents entities. Record resources before binding so cleanup also covers failures midway through.
  const geometries = new Set<import("three").BufferGeometry>(), materials = new Set<import("three").Material>();
  const textures = new Set<import("three").Texture>();
  gltf.scene.traverse((node) => {
    const mesh = node as import("three").Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value && typeof value === "object" && "isTexture" in value && value.isTexture) textures.add(value as import("three").Texture);
    }
  });
  try { applyBakedIndirect(gltf.scene); bindTexturedRoom(gltf.scene, plan, binding); }
  finally {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) {
      texture.dispose();
      if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) texture.image.close();
    }
  }
}

let databasePromise: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Private room storage is unavailable in this browser."));
  if (!databasePromise) databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
      if (!request.result.objectStoreNames.contains(DRAFT_STORE)) request.result.createObjectStore(DRAFT_STORE, { keyPath: "id" });
    };
    request.onerror = () => reject(new Error("Private room storage could not be opened. Check this browser’s storage settings."));
    request.onblocked = () => { abandoned = true; reject(new Error("Close older Tadaima tabs, then try again.")); };
    request.onsuccess = () => {
      if (abandoned) { request.result.close(); return; }
      request.result.onversionchange = () => { request.result.close(); databasePromise = undefined; };
      resolve(request.result);
    };
  }).catch((cause) => { databasePromise = undefined; throw cause; });
  return databasePromise;
}
function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(new Error("The room could not be saved. Browser storage may be full or unavailable."));
  });
}
function changed() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
  if (typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel(CHANNEL); channel.postMessage("changed"); channel.close(); }
}
export function subscribeRooms(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL) : null;
  if (channel) channel.onmessage = () => callback();
  return () => { window.removeEventListener(CHANGE_EVENT, callback); channel?.close(); };
}

async function validateStored(record: StoredRoom): Promise<void> {
  if (record.version !== 1 || typeof record.sourceJson !== "string" || typeof record.label !== "string" || !record.label.trim()
    || record.label.length > 120 || !Number.isFinite(Date.parse(record.updatedAt))) fail("this saved room has invalid metadata.");
  const identity = await roomSourceIdentity(record.sourceJson);
  if (identity.id !== record.id || !jsonEqual(record.binding, identity.binding) || !jsonEqual(record.sourcePlan, identity.plan)
    || (record.modelBlob !== undefined && (!(record.modelBlob instanceof Blob) || record.modelBlob.size > MAX_MODEL_BYTES))) fail("this saved room no longer matches its original scan.");
  validateEditedRoom(identity.plan, record.editedPlan);
}
function summary(record: StoredRoom): RoomSummary {
  return { id: record.id, label: record.label, sourcePlan: clone(record.sourcePlan), binding: clone(record.binding),
    editedPlan: clone(record.editedPlan), updatedAt: record.updatedAt, hasModel: !!record.modelBlob };
}
async function materialize(record: StoredRoom): Promise<RoomRecord> {
  return { id: record.id, label: record.label, sourceJson: record.sourceJson, sourcePlan: clone(record.sourcePlan), binding: clone(record.binding),
    editedPlan: clone(record.editedPlan), updatedAt: record.updatedAt, ...(record.modelBlob ? { model: await record.modelBlob.arrayBuffer() } : {}) };
}
export async function listRooms(): Promise<RoomSummary[]> {
  const db = await database(), transaction = db.transaction(STORE, "readonly");
  // Blob handles are structured-cloned without reading every room's GLB into memory.
  const rooms = await requestValue(transaction.objectStore(STORE).getAll()) as StoredRoom[];
  await Promise.all(rooms.map(validateStored));
  return rooms.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary);
}
export async function getRoom(id: string): Promise<RoomRecord | null> {
  const record = await storedRoom(id);
  return record ? materialize(record) : null;
}
async function storedRoom(id: string): Promise<StoredRoom | null> {
  const db = await database(), transaction = db.transaction(STORE, "readonly");
  const record = await requestValue(transaction.objectStore(STORE).get(id)) as StoredRoom | undefined;
  if (!record) return null;
  await validateStored(record);
  return record;
}

export async function importRoom(sourceJson: string, model?: ArrayBuffer, label?: string, options: { replaceModel?: boolean } = {}): Promise<RoomRecord> {
  if (options.replaceModel && model === undefined) fail("choose a matching GLB to update this scan’s model.");
  const { id, plan, binding } = await roomSourceIdentity(sourceJson);
  const title = (label?.trim() || plan.geometry.rooms[0].label).slice(0, 120);
  if (model !== undefined) await validateRoomModel(model, plan, binding);
  const db = await database();
  const transaction = db.transaction(STORE, "readwrite"), done = completed(transaction), store = transaction.objectStore(STORE);
  const previous = await requestValue(store.get(id)) as StoredRoom | undefined;
  // A verified model upgrade changes only the asset, never the immutable scan or accepted shopping plan.
  // The read and write share a transaction so a concurrent furniture save cannot be replaced by an older snapshot.
  if (options.replaceModel && !previous) {
    transaction.abort(); await done.catch(() => {});
    return fail("this scan is not saved in this browser. Open it before updating its model.");
  }
  if (options.replaceModel && previous && (previous.sourceJson !== sourceJson || !jsonEqual(previous.sourcePlan, plan) || !jsonEqual(previous.binding, binding))) {
    transaction.abort(); await done.catch(() => {});
    return fail("the saved room no longer matches this verified scan. Its model was not updated.");
  }
  const record: StoredRoom = previous ? { ...previous, ...(model && (options.replaceModel || !previous.modelBlob) ? { modelBlob: new Blob([model], { type: "model/gltf-binary" }) } : {}) } : {
    version: 1, id, label: title, sourceJson, sourcePlan: clone(plan), binding,
    ...(model ? { modelBlob: new Blob([model], { type: "model/gltf-binary" }) } : {}), editedPlan: clone(plan), updatedAt: new Date().toISOString(),
  };
  store.put(record);
  await done;
  changed();
  return materialize(record);
}
export async function saveEditedPlan(id: string, candidate: RoomPlan): Promise<void> {
  // Validate before a readwrite transaction; crypto and GLB parsing must never keep an IndexedDB transaction open.
  const current = await storedRoom(id);
  if (!current) return fail("this room is no longer saved in this browser.");
  const plan = validateEditedRoom(current.sourcePlan, candidate);
  const db = await database(), transaction = db.transaction(STORE, "readwrite"), done = completed(transaction), store = transaction.objectStore(STORE);
  const previous = await requestValue(store.get(id)) as StoredRoom | undefined;
  if (!previous) { transaction.abort(); await done.catch(() => {}); return fail("this room was removed in another tab."); }
  if (plan.revision < previous.editedPlan.revision || (plan.revision === previous.editedPlan.revision && !jsonEqual(plan, previous.editedPlan))) {
    transaction.abort(); await done.catch(() => {}); return fail("a newer or conflicting edit is already saved. Reopen this room before editing.");
  }
  const record = { ...previous, editedPlan: plan, updatedAt: new Date().toISOString() };
  store.put(record); await done; changed();
}
export async function deleteRoom(id: string): Promise<void> {
  const db = await database(), transaction = db.transaction(STORE, "readwrite"), done = completed(transaction);
  transaction.objectStore(STORE).delete(id); await done; changed();
}

function catalogId(id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || id.startsWith("local-scan-")) fail("invalid catalog room ID.");
}
/** Catalog drafts are isolated from private source-bound scans and from every other catalog room. */
export function validateRoomDraft(candidate: RoomPlan): RoomPlan {
  let source: string;
  try {
    source = JSON.stringify(candidate, (_key, value) => {
      if (typeof value === "number" && !Number.isFinite(value)) fail("the room draft contains a nonfinite number.");
      return value;
    });
  } catch { return fail("the room draft cannot be saved."); }
  if (!source || encoder.encode(source).byteLength > MAX_EDITED_BYTES) fail("the room draft exceeds 4 MiB.");
  const plan = JSON.parse(source) as RoomPlan;
  if (plan.schemaVersion !== "0.2" || typeof plan.projectId !== "string" || !plan.projectId.trim() || !Number.isSafeInteger(plan.revision) || plan.revision < 0
    || !Array.isArray(plan.items) || !Array.isArray(plan.products) || !Array.isArray(plan.evidence)
    || plan.items.length > 512 || plan.products.length > 1024 || plan.evidence.length > 4096
    || !plan.constraints || !Number.isFinite(plan.constraints.clearance) || plan.constraints.clearance < 0) fail("the room draft has invalid data.");
  try {
    const errors = validatePlan(plan).filter((issue) => issue.severity === "error");
    if (errors.length) fail(errors[0].message);
  } catch (cause) { return fail(cause instanceof Error ? cause.message : "the room draft is invalid."); }
  return plan;
}
export async function getRoomDraft(id: string): Promise<RoomPlan | null> {
  catalogId(id);
  const db = await database(), transaction = db.transaction(DRAFT_STORE, "readonly");
  const draft = await requestValue(transaction.objectStore(DRAFT_STORE).get(draftKey(id))) as { id: string; plan: RoomPlan } | undefined;
  if (!draft) return null;
  if (draft.id !== draftKey(id)) return fail("this draft belongs to another room.");
  return validateRoomDraft(draft.plan);
}
export async function saveRoomDraft(id: string, candidate: RoomPlan): Promise<void> {
  catalogId(id);
  const plan = validateRoomDraft(candidate), db = await database();
  const transaction = db.transaction(DRAFT_STORE, "readwrite"), done = completed(transaction), store = transaction.objectStore(DRAFT_STORE);
  const previous = await requestValue(store.get(draftKey(id))) as { plan: RoomPlan } | undefined;
  if (previous && (previous.plan.projectId !== plan.projectId || previous.plan.revision > plan.revision
    || (previous.plan.revision === plan.revision && !jsonEqual(previous.plan, plan)))) {
    transaction.abort(); await done.catch(() => {}); return fail("a different or newer room draft is already saved. Reopen the room before editing.");
  }
  store.put({ id: draftKey(id), plan, updatedAt: new Date().toISOString() }); await done; changed();
}

async function boundedResponse(response: Response, maximum: number,
  unavailable = "the private local scan link is unavailable. Check the Mac preview server."): Promise<ArrayBuffer> {
  if (!response.ok) fail(unavailable);
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum) fail("the local scan exceeds the supported file size.");
  if (!response.body) fail("the local scan response was empty.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); fail("the local scan exceeds the supported file size."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result.buffer;
}
export async function importLocalCapture(token: string): Promise<RoomRecord> {
  if (!/^[a-f0-9]{64}$/.test(token)) return fail("the private local scan link is invalid.");
  const bodies = await Promise.all((["scene", "model"] as const).map(async (asset) => boundedResponse(await fetch(`/api/local-capture/${asset}`, {
    headers: { authorization: `Bearer ${token}` }, cache: "no-store", credentials: "same-origin", redirect: "error",
  }), asset === "scene" ? MAX_ROOM_IMPORT_BYTES : MAX_MODEL_BYTES)));
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bodies[0]);
  const { id } = await roomSourceIdentity(source);
  // Opening an authenticated development preview explicitly requests its latest
  // verified model. Read only its Blob handle; do not load the older GLB again.
  const existing = await storedRoom(id);
  return importRoom(source, bodies[1], undefined, { replaceModel: !!existing });
}
/** A scan sent from TadaimaScan and rebuilt by the reconstruction service (see /api/scans). */
export async function importPhoneScan(scanId: string, options: { photoTextured: boolean; label?: string }): Promise<RoomRecord> {
  if (!/^[0-9a-f]{32}$/.test(scanId)) return fail("the phone scan id is invalid.");
  // Only photo-textured GLBs bind to the viewer; a layout-only scan opens with measured stand-ins.
  const assets = options.photoTextured ? (["scene", "model"] as const) : (["scene"] as const);
  const bodies = await Promise.all(assets.map(async (asset) => boundedResponse(
    await fetch(`/api/scans/${scanId}/${asset}`, { cache: "no-store", credentials: "same-origin", redirect: "error" }),
    asset === "scene" ? MAX_ROOM_IMPORT_BYTES : MAX_MODEL_BYTES,
    "the phone scan is not ready or the reconstruction service is unavailable.")));
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bodies[0]);
  const { id } = await roomSourceIdentity(source);
  // Re-sending the same scan refreshes its model instead of silently keeping the old one.
  const existing = await storedRoom(id);
  return importRoom(source, bodies[1], options.label, { replaceModel: !!existing && !!bodies[1] });
}
/** The temporary development capability is read once and never copied into a saved room or URL. */
let pendingBootstrap: { token: string; promise: Promise<RoomRecord> } | undefined;
export async function bootstrapLocalCapture(): Promise<RoomRecord | null> {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  let token = fragment.get("local-scan");
  try { token ||= window.sessionStorage.getItem("tadaima:local-scan"); } catch { /* Session storage is optional. */ }
  if (!token) return null;
  if (pendingBootstrap?.token === token) return pendingBootstrap.promise;
  const capability = token;
  const promise = importLocalCapture(capability).then((room) => {
    // A second link can arrive while import runs. Only consume the capability that actually completed.
    const current = new URLSearchParams(window.location.hash.slice(1));
    if (current.get("local-scan") === capability) {
      current.delete("local-scan");
      const rest = current.toString();
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + (rest ? `#${rest}` : ""));
    }
    try { if (window.sessionStorage.getItem("tadaima:local-scan") === capability) window.sessionStorage.removeItem("tadaima:local-scan"); }
    catch { /* The durable private room no longer needs a capability. */ }
    return room;
  }).finally(() => { if (pendingBootstrap?.promise === promise) pendingBootstrap = undefined; });
  pendingBootstrap = { token: capability, promise };
  return promise;
}
