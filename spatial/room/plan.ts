import type { PlacedItem, PointXZ, RoomPlan, Vector3Meters } from "@/backend/contracts";

// pure plan helpers for the viewer: validation, revision diffs, footprints.
// no three.js and no runtime imports, so node can test this file directly.

export type IssueSeverity = "error" | "warning";

export interface PlanIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  /** Stable ID of the room, wall, opening, item, or product the issue is about. */
  entityId: string | null;
}

export type ItemChange =
  | { kind: "added"; id: string; item: PlacedItem }
  | { kind: "removed"; id: string; item: PlacedItem }
  | {
      kind: "changed";
      id: string;
      item: PlacedItem;
      before: PlacedItem;
      moved: boolean;
      rotated: boolean;
      replaced: boolean;
      lockChanged: boolean;
      resized: boolean;
    };

export interface PlanDiff {
  fromRevision: number;
  toRevision: number;
  changes: ItemChange[];
}

/** Where a size shown in the viewer came from. Mesh bounds are never a product size. */
export type DimensionSource =
  | { kind: "product"; size: Vector3Meters; productId: string; status: string }
  | { kind: "item"; size: Vector3Meters; status: string }
  | { kind: "unknown" };

const MOVE_EPSILON = 0.01; // 1 cm
const TURN_EPSILON = (0.5 * Math.PI) / 180; // half a degree

const finite = (...values: number[]) => values.every((v) => Number.isFinite(v));

export function polygonArea(polygon: readonly PointXZ[]) {
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x0, z0] = polygon[i];
    const [x1, z1] = polygon[(i + 1) % polygon.length];
    sum += x0 * z1 - x1 * z0;
  }
  return sum / 2;
}

export function polygonCentroid(polygon: readonly PointXZ[]): PointXZ {
  const area = polygonArea(polygon);
  if (Math.abs(area) < 1e-9) {
    const n = polygon.length || 1;
    return [polygon.reduce((s, p) => s + p[0], 0) / n, polygon.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x0, z0] = polygon[i];
    const [x1, z1] = polygon[(i + 1) % polygon.length];
    const cross = x0 * z1 - x1 * z0;
    cx += (x0 + x1) * cross;
    cz += (z0 + z1) * cross;
  }
  return [cx / (6 * area), cz / (6 * area)];
}

export function pointInPolygon([x, z]: PointXZ, polygon: readonly PointXZ[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

const cross = (o: PointXZ, a: PointXZ, b: PointXZ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function segmentsCross(a: PointXZ, b: PointXZ, c: PointXZ, d: PointXZ) {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** True when two non-adjacent edges cross. Touching endpoints are not counted. */
export function selfIntersects(polygon: readonly PointXZ[]) {
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(polygon[i], polygon[(i + 1) % n], polygon[j], polygon[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * Corners of an item's footprint on the floor, from its plan position, rotation,
 * and a width/depth. Local +X is width and local +Z is depth (front faces +Z).
 */
export function footprint(position: Vector3Meters, rotationY: number, width: number, depth: number): PointXZ[] {
  const c = Math.cos(rotationY);
  const s = Math.sin(rotationY);
  const hw = width / 2;
  const hd = depth / 2;
  const local: PointXZ[] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  // three.js rotation about +Y: x' = x cos + z sin, z' = -x sin + z cos
  return local.map(([x, z]) => [position[0] + x * c + z * s, position[2] - x * s + z * c]);
}

export function footprintInside(corners: readonly PointXZ[], polygon: readonly PointXZ[]) {
  if (!corners.every((p) => pointInPolygon(p, polygon))) return false;
  for (let i = 0; i < corners.length; i++) {
    for (let j = 0; j < polygon.length; j++) {
      if (segmentsCross(corners[i], corners[(i + 1) % corners.length], polygon[j], polygon[(j + 1) % polygon.length])) {
        return false;
      }
    }
  }
  return true;
}

export function wallLength(wall: { start: PointXZ; end: PointXZ }) {
  return Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
}

/** The best known physical size for an item. Product evidence wins over the item record. */
export function dimensionSource(plan: RoomPlan, item: PlacedItem): DimensionSource {
  const product = item.productId ? plan.products.find((p) => p.id === item.productId) : undefined;
  if (product?.dimensions) {
    const statuses = product.evidenceIds
      .map((id) => plan.evidence.find((e) => e.id === id)?.dimensionStatus)
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
    return {
      kind: "product",
      size: product.dimensions,
      productId: product.id,
      status: statuses.length ? [...new Set(statuses)].join(", ") : "no dimension evidence",
    };
  }
  if (item.dimensions) {
    return {
      kind: "item",
      size: item.dimensions,
      status: item.origin === "existing_owned" ? "owned item, no evidence attached" : "item record, no product evidence",
    };
  }
  return { kind: "unknown" };
}

function validVector(v: unknown, length: number) {
  return Array.isArray(v) && v.length === length && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * Structural checks the viewer needs before it draws a plan. These do not replace
 * the backend's validators; they make missing or broken geometry visible.
 */
export function validatePlan(plan: RoomPlan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const add = (severity: IssueSeverity, code: string, message: string, entityId: string | null = null) =>
    issues.push({ severity, code, message, entityId });

  if (plan.schemaVersion !== "0.1-scaffold") {
    add("error", "schema_version", `Unsupported schema version "${String(plan.schemaVersion)}".`);
  }
  const geometry = plan.geometry;
  if (!geometry) {
    add("error", "geometry_missing", "The plan has no room geometry.");
    return issues;
  }
  if (geometry.units !== "m") add("error", "units", `Geometry units must be meters, got "${String(geometry.units)}".`);
  if (geometry.coordinateSystem !== "right-handed-y-up") {
    add("error", "coordinate_system", `Unsupported coordinate system "${String(geometry.coordinateSystem)}".`);
  }

  const evidenceIds = new Set(plan.evidence.map((e) => e.id));
  const checkEvidence = (ids: string[], entityId: string, what: string) => {
    if (!ids.length) add("warning", "evidence_none", `${what} has no evidence attached.`, entityId);
    for (const id of ids) {
      if (!evidenceIds.has(id)) add("warning", "evidence_missing", `${what} cites missing evidence "${id}".`, entityId);
    }
  };

  const roomIds = new Set<string>();
  if (!geometry.rooms.length) add("error", "rooms_none", "The plan has no rooms.");
  for (const room of geometry.rooms) {
    if (roomIds.has(room.id)) add("error", "duplicate_id", `Duplicate room ID "${room.id}".`, room.id);
    roomIds.add(room.id);
    const poly = room.floorPolygon;
    if (poly.length < 3 || !poly.every((p) => validVector(p, 2))) {
      add("error", "room_polygon", `${room.label} needs at least three finite floor points.`, room.id);
      continue;
    }
    if (Math.abs(polygonArea(poly)) < 0.25) add("error", "room_area", `${room.label} has almost no floor area.`, room.id);
    if (selfIntersects(poly)) add("error", "room_self_intersecting", `${room.label} outline crosses itself.`, room.id);
    if (!(room.height > 0)) add("error", "room_height", `${room.label} has no valid ceiling height.`, room.id);
    checkEvidence(room.evidenceIds, room.id, room.label);
  }

  const walls = new Map(geometry.walls.map((w) => [w.id, w]));
  if (walls.size !== geometry.walls.length) add("error", "duplicate_id", "Two walls share an ID.");
  for (const wall of geometry.walls) {
    if (!validVector(wall.start, 2) || !validVector(wall.end, 2)) {
      add("error", "wall_points", `Wall "${wall.id}" has invalid end points.`, wall.id);
      continue;
    }
    if (wallLength(wall) < 0.05) add("error", "wall_length", `Wall "${wall.id}" is shorter than 5 cm.`, wall.id);
    if (!(wall.height > 0) || !(wall.thickness > 0)) {
      add("error", "wall_size", `Wall "${wall.id}" needs a positive height and thickness.`, wall.id);
    }
    checkEvidence(wall.evidenceIds, wall.id, `Wall "${wall.id}"`);
  }

  for (const opening of geometry.openings) {
    const wall = walls.get(opening.wallId);
    if (!wall) {
      add("error", "opening_wall", `Opening "${opening.id}" refers to missing wall "${opening.wallId}".`, opening.id);
      continue;
    }
    if (!finite(opening.offset, opening.width, opening.height, opening.sillHeight) || opening.width <= 0 || opening.height <= 0) {
      add("error", "opening_size", `Opening "${opening.id}" has invalid measurements.`, opening.id);
      continue;
    }
    if (opening.offset < 0 || opening.offset + opening.width > wallLength(wall) + 1e-6) {
      add("error", "opening_bounds", `Opening "${opening.id}" runs past the end of its wall.`, opening.id);
    }
    if (opening.sillHeight < 0 || opening.sillHeight + opening.height > wall.height + 1e-6) {
      add("error", "opening_height", `Opening "${opening.id}" is taller than its wall.`, opening.id);
    }
    checkEvidence(opening.evidenceIds, opening.id, `Opening "${opening.id}"`);
  }

  const productIds = new Set(plan.products.map((p) => p.id));
  for (const product of plan.products) {
    if (!product.dimensions) add("warning", "product_dimensions", `${product.label} has no established dimensions.`, product.id);
    else if (!product.dimensions.every((n) => n > 0)) add("error", "product_dimensions", `${product.label} has a zero or negative size.`, product.id);
    checkEvidence(product.evidenceIds, product.id, product.label);
  }

  const itemIds = new Set<string>();
  for (const item of plan.items) {
    if (itemIds.has(item.id)) add("error", "duplicate_id", `Duplicate item ID "${item.id}".`, item.id);
    itemIds.add(item.id);
    if (!roomIds.has(item.roomId)) add("error", "item_room", `${item.label} is in unknown room "${item.roomId}".`, item.id);
    if (!validVector(item.position, 3) || !Number.isFinite(item.rotationY)) {
      add("error", "item_transform", `${item.label} has an invalid position or rotation.`, item.id);
      continue;
    }
    if (item.productId && !productIds.has(item.productId)) {
      add("error", "item_product", `${item.label} refers to missing product "${item.productId}".`, item.id);
    }
    if (item.origin === "proposed_purchase" && !item.productId) {
      add("warning", "item_product_none", `${item.label} is a proposed purchase with no product.`, item.id);
    }
    if (item.dimensions && !item.dimensions.every((n) => n > 0)) {
      add("error", "item_dimensions", `${item.label} has a zero or negative size.`, item.id);
    }
    const dims = dimensionSource(plan, item);
    if (dims.kind === "unknown") add("warning", "item_dimensions_unknown", `${item.label} has no known physical size.`, item.id);
    if (!item.assetUrl && dims.kind === "unknown") {
      add("warning", "item_unrenderable", `${item.label} has no model and no size, so it is drawn as a marker.`, item.id);
    }
    const room = geometry.rooms.find((r) => r.id === item.roomId);
    if (room && room.floorPolygon.length >= 3) {
      if (dims.kind !== "unknown") {
        const corners = footprint(item.position, item.rotationY, dims.size[0], dims.size[2]);
        if (!footprintInside(corners, room.floorPolygon)) {
          add("warning", "item_outside_room", `${item.label} extends past the ${room.label.toLowerCase()} outline.`, item.id);
        }
      } else if (!pointInPolygon([item.position[0], item.position[2]], room.floorPolygon)) {
        add("warning", "item_outside_room", `${item.label} sits outside the ${room.label.toLowerCase()} outline.`, item.id);
      }
    }
  }

  return issues;
}

const sameVector = (a: Vector3Meters | null, b: Vector3Meters | null, epsilon: number) =>
  a === b || (!!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= epsilon));

const angleDelta = (a: number, b: number) => {
  const d = (((a - b) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  return Math.abs(d);
};

/** Item level differences between two revisions of the same plan. */
export function diffPlans(before: RoomPlan, after: RoomPlan): PlanDiff {
  const previous = new Map(before.items.map((i) => [i.id, i]));
  const changes: ItemChange[] = [];
  for (const item of after.items) {
    const old = previous.get(item.id);
    if (!old) {
      changes.push({ kind: "added", id: item.id, item });
      continue;
    }
    previous.delete(item.id);
    const moved = !sameVector(old.position, item.position, MOVE_EPSILON);
    const rotated = angleDelta(old.rotationY, item.rotationY) > TURN_EPSILON;
    const replaced = old.productId !== item.productId || old.assetUrl !== item.assetUrl;
    const lockChanged = old.locked !== item.locked;
    const resized = !sameVector(old.dimensions, item.dimensions, 0.005);
    if (moved || rotated || replaced || lockChanged || resized) {
      changes.push({ kind: "changed", id: item.id, item, before: old, moved, rotated, replaced, lockChanged, resized });
    }
  }
  for (const item of previous.values()) changes.push({ kind: "removed", id: item.id, item });
  return { fromRevision: before.revision, toRevision: after.revision, changes };
}

export function describeChange(change: ItemChange) {
  if (change.kind === "added") return "Added";
  if (change.kind === "removed") return "Removed";
  const parts: string[] = [];
  if (change.replaced) parts.push("replaced");
  if (change.moved) parts.push("moved");
  if (change.rotated) parts.push("turned");
  if (change.resized) parts.push("resized");
  if (change.lockChanged) parts.push(change.item.locked ? "locked" : "unlocked");
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
