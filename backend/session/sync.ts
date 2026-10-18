import { isDeepStrictEqual } from "node:util";
import type { PlanChange, PlacedItem, RoomPlan, ValidationResult } from "@/backend/contracts";
import { blocking, collides, collisionFootprint, footprint, inside, NO_FOOTPRINT, validateChanges } from "@/backend/plan/rules";
import { itemFor, purchaseProblems } from "@/backend/shopping/spot";

const equal = isDeepStrictEqual;
const fixed = (item: PlacedItem) => Object.fromEntries(Object.entries(item).filter(([key]) => !["position", "rotationY", "roomId", "locked", "stored"].includes(key)));
export class InvalidRoomSync extends Error {}
function refuse(message: string): never { throw new InvalidRoomSync(message); }

/** Snapshot transport does not make catalog observations or captured dimensions client-authoritative. */
export function reconcileRoomSnapshot(base: RoomPlan, snapshot: RoomPlan): { plan: RoomPlan; validations: ValidationResult[]; blocked: boolean } {
  if (snapshot.projectId !== base.projectId) refuse("this snapshot belongs to another project");
  if (!equal(snapshot.geometry, base.geometry) || !equal(snapshot.appearance, base.appearance)) refuse("the captured room geometry and appearance cannot change through shopping");
  const products = new Map(base.products.map((product) => [product.id, product]));
  for (const product of snapshot.products) if (!equal(product, products.get(product.id))) refuse("product observations are server-owned; refresh the room before editing");
  const evidence = new Map(base.evidence.map((entry) => [entry.id, entry]));
  for (const entry of snapshot.evidence) if (!equal(entry, evidence.get(entry.id))) refuse("source observations cannot be changed");
  const next = { ...structuredClone(snapshot), revision: base.revision, products: structuredClone(base.products), evidence: structuredClone(base.evidence) };
  const changes: PlanChange[] = [];
  const originals = new Map(base.items.map((item) => [item.id, item]));
  for (const item of next.items) {
    const before = originals.get(item.id);
    if (before) {
      if (!equal(fixed(before), fixed(item))) {
        if (before.origin === "existing_owned") refuse("owned furniture keeps its physical identity; put it away before adding a replacement");
        const product = item.productId ? products.get(item.productId) : null;
        const canonical = product && itemFor(product, { roomId: item.roomId, position: item.position, rotationY: item.rotationY }, item.id);
        if (!canonical || !product || purchaseProblems(base, product).length > 0 || !equal(fixed(canonical), fixed(item))) refuse("furniture dimensions and product identity must match the server catalog");
        changes.push({ kind: "replace", itemId: item.id, productId: product!.id });
      }
      if (before.locked !== item.locked) changes.push({ kind: "lock", itemId: item.id, locked: item.locked });
      if (!!before.stored !== !!item.stored) changes.push(item.stored ? { kind: "store", itemId: item.id } : { kind: "take_out", itemId: item.id, position: item.position, rotationY: item.rotationY });
      else if (!equal(before.position, item.position) || before.rotationY !== item.rotationY || before.roomId !== item.roomId) changes.push({ kind: "move", itemId: item.id, position: item.position, rotationY: item.rotationY });
    } else {
      const product = item.productId ? products.get(item.productId) : null;
      const canonical = product && itemFor(product, { roomId: item.roomId, position: item.position, rotationY: item.rotationY }, item.id);
      if (item.origin !== "proposed_purchase" || !canonical || !product || purchaseProblems(base, product).length > 0 || !equal(fixed(canonical), fixed(item)) || Math.abs(item.position[1]) > 0.001) refuse("new furniture must use a server-known product and its measured dimensions");
      changes.push({ kind: "add", item });
    }
  }
  for (const before of base.items) if (!next.items.some((item) => item.id === before.id)) {
    if (before.origin === "existing_owned") refuse("owned furniture must be kept in inventory rather than deleted");
    changes.push({ kind: "remove", itemId: before.id });
  }
  if (!equal(base.constraints, next.constraints)) changes.push({ kind: "set_constraints", constraints: next.constraints });
  const validations = validateChanges(base, changes, next);
  const failures = blocking(base, changes, next, validations);
  // The shared aggregate overlap rule reports item IDs, not pairs. A scanned room
  // can already overlap, so compare changed pairs as well: an old A-B clash does
  // not license a new A-C clash just because all three IDs already appeared.
  const moved = next.items.filter((item) => {
    const before = originals.get(item.id);
    return !before || !equal(before.position, item.position) || before.rotationY !== item.rotationY || before.roomId !== item.roomId || !!before.stored !== !!item.stored || !equal(before.dimensions, item.dimensions);
  });
  const clashingPairs = (plan: RoomPlan) => {
    const pairs = new Map<string, number>();
    const solid = plan.items.filter((item) => !item.stored && item.dimensions && !NO_FOOTPRINT.has(item.category));
    for (let a = 0; a < solid.length; a++) for (let b = a + 1; b < solid.length; b++) {
      if (solid[a].roomId !== solid[b].roomId || !collides(solid[a], solid[b], plan.constraints.clearance / 2)) continue;
      const first = collisionFootprint(solid[a], plan.constraints.clearance / 2)!, second = collisionFootprint(solid[b], plan.constraints.clearance / 2)!;
      let penetration = Infinity;
      for (const quad of [first, second]) for (let edge = 0; edge < quad.length; edge++) {
        const p = quad[edge], q = quad[(edge + 1) % quad.length];
        const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const axis = [(p[1] - q[1]) / length, (q[0] - p[0]) / length];
        const project = (points: typeof first) => points.map((point) => point[0] * axis[0] + point[1] * axis[1]);
        const x = project(first), z = project(second);
        penetration = Math.min(penetration, Math.min(Math.max(...x), Math.max(...z)) - Math.max(Math.min(...x), Math.min(...z)));
      }
      pairs.set([solid[a].id, solid[b].id].sort().join("|"), penetration);
    }
    return pairs;
  };
  const oldPairs = clashingPairs(base);
  const newPairs = [...clashingPairs(next)].filter(([pair, depth]) => !oldPairs.has(pair) || depth > oldPairs.get(pair)! + 1e-6).map(([pair]) => pair);
  const outside = moved.filter((item) => !item.stored && item.dimensions && !footprint(item)!.every((point) => inside(point, next.geometry.rooms.find((room) => room.id === item.roomId)!.floorPolygon)));
  if (newPairs.length) failures.push({ rule: "no_overlap", status: "fail", itemIds: [...new Set(newPairs.flatMap((pair) => pair.split("|")))], message: "This edit adds a furniture overlap. Choose a free floor spot." });
  if (outside.length) failures.push({ rule: "in_room", status: "fail", itemIds: outside.map((item) => item.id), message: "Moved furniture must fit entirely inside its room." });
  return { plan: next, validations: failures.length ? [...validations.filter((entry) => entry.status !== "fail"), ...failures] : validations, blocked: failures.length > 0 };
}

/** Build initial catalog-backed furniture without trusting prices from an imported draft. */
export function normalizeRegisteredPlan(input: RoomPlan, projectId: string, catalog: RoomPlan["products"], catalogEvidence: RoomPlan["evidence"] = []): RoomPlan {
  const trustedIds = new Set(catalog.map((product) => product.id));
  const mergedCatalog = [...catalog, ...input.products.filter((product) => !trustedIds.has(product.id)).map((product) => ({ ...structuredClone(product), fixture: true }))];
  const products = new Map(mergedCatalog.map((product) => [product.id, product]));
  const items = input.items.map((item) => {
    if (item.origin === "existing_owned") return structuredClone(item);
    const product = item.productId ? products.get(item.productId) : null;
    if (!product) refuse(`the imported purchase “${item.label}” is not in the server catalog; remove it or research it again`);
    return { ...itemFor(product, { roomId: item.roomId, position: item.position, rotationY: item.rotationY }, item.id), locked: item.locked, ...(item.stored !== undefined ? { stored: item.stored } : {}) };
  });
  const observations = new Map(input.evidence.map((entry) => [entry.id, entry]));
  for (const entry of catalogEvidence) observations.set(entry.id, entry);
  return { ...structuredClone(input), projectId, revision: input.revision + 1, items, products: structuredClone(mergedCatalog), evidence: structuredClone([...observations.values()]) };
}
