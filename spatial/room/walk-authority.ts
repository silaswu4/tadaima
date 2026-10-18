import type { FloorSpot, PlacedItem, RoomPlan, Vector3Meters } from "../../backend/contracts";

const finiteVector = (value: readonly number[] | null, positive = false) => value === null ||
  (Array.isArray(value) && value.length === 3 && value.every((n) => Number.isFinite(n) && (!positive || n > 0)));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A server project may have a new ID, but cannot silently replace the loaded room shell
 * or borrow a captured mesh for a different item. This is independent of source GLB binding. */
export function acceptWalkPlan(current: RoomPlan, incoming: RoomPlan, source?: RoomPlan | null): RoomPlan {
  if (incoming.schemaVersion !== "0.2" || typeof incoming.projectId !== "string" || !incoming.projectId.trim() ||
    !Number.isSafeInteger(incoming.revision) || incoming.revision < 0) throw new Error("The server returned an invalid room identity or revision.");
  if (!equal(current.geometry, incoming.geometry)) throw new Error("The server plan does not match this room's measured geometry. Reopen the room before continuing.");
  if (!equal(current.appearance, incoming.appearance)) throw new Error("The server plan changed the loaded room finishes. Reopen the room before continuing.");
  if (!Array.isArray(incoming.items) || !Array.isArray(incoming.products) || incoming.items.length > 1000 || incoming.products.length > 2000) throw new Error("The server returned an invalid room inventory.");
  const roomIds = new Set(incoming.geometry.rooms.map((room) => room.id));
  const productIds = new Set<string>(), itemIds = new Set<string>();
  for (const product of incoming.products) {
    if (!product.id || productIds.has(product.id) || !finiteVector(product.dimensions, true) ||
      (product.price && (!Number.isSafeInteger(product.price.amountMinor) || product.price.amountMinor < 0))) throw new Error("The server returned invalid product dimensions, price or duplicate IDs.");
    productIds.add(product.id);
  }
  const sourceItems = new Map(source?.items.map((item) => [item.id, item]) ?? []);
  for (const item of incoming.items) {
    if (!item.id || itemIds.has(item.id) || !roomIds.has(item.roomId) || !item.position || !finiteVector(item.position) ||
      !Number.isFinite(item.rotationY) || !finiteVector(item.dimensions, true) ||
      (item.productId && !productIds.has(item.productId))) throw new Error("The server returned an invalid furniture pose, dimensions or identity.");
    itemIds.add(item.id);
    const captured = sourceItems.get(item.id);
    if (captured && (item.origin !== captured.origin || item.productId !== captured.productId || item.category !== captured.category ||
      item.assetUrl !== captured.assetUrl || !equal(item.dimensions, captured.dimensions))) throw new Error("The server changed the identity or measured size of a captured furniture model.");
  }
  return structuredClone(incoming);
}

/** Pose, locks, price and labels can update without downloading/building a model again. */
export function walkModelIdentity(plan: RoomPlan, item: PlacedItem): string {
  const size = (item.productId ? plan.products.find((product) => product.id === item.productId)?.dimensions : null) ?? item.dimensions;
  return JSON.stringify([item.id, item.category, item.origin, item.productId, item.assetUrl, size]);
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, ordered(entry)]));
  return value;
}

/** An acknowledgement of the same accepted local edit must not erase its undo.
 * New catalog observations are harmless; remote layout, constraint or existing
 * product changes invalidate the older operations and their detached roots. */
export function canPreserveWalkUndo(current: RoomPlan, incoming: RoomPlan): boolean {
  const items = (plan: RoomPlan) => ordered(plan.items.map((item) => ({ ...item,
    stored: item.stored ?? false, evidenceIds: item.evidenceIds ?? [],
  })).sort((a, b) => a.id.localeCompare(b.id)));
  if (!equal(items(current), items(incoming)) || !equal(ordered(current.constraints), ordered(incoming.constraints))) return false;
  const products = new Map(incoming.products.map((product) => [product.id, product]));
  return current.products.every((product) => equal(ordered(product), ordered(products.get(product.id))));
}

function inside([x, , z]: Vector3Meters, polygon: readonly (readonly [number, number])[]) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, az] = polygon[i], [bx, bz] = polygon[j];
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) result = !result;
  }
  return result;
}

/** Never relabel an outside/NaN point as the first room. Candidates are ordered by
 * visibility: a real floor hit, then the viewer, then a checked navigation spawn. */
export function checkedWalkShoppingSpot(plan: RoomPlan, candidates: readonly Vector3Meters[]): FloorSpot | null {
  for (const point of candidates) {
    if (!point.every(Number.isFinite)) continue;
    const room = plan.geometry.rooms.find((entry) => inside(point, entry.floorPolygon));
    if (room) return { roomId: room.id, position: [point[0], 0, point[2]] };
  }
  return null;
}
