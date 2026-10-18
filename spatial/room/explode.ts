import * as THREE from "three";

/** World-axis bounds after the item's original rotation and scale are applied. */
export type InventoryItem = {
  id: string;
  size: readonly [number, number, number];
  /** World-space box center minus world-space Object3D root position. */
  centerOffset: readonly [number, number, number];
};

export type InventoryLayoutOptions = {
  /** Clear space between inventory boxes and between inventory and the room. */
  gap?: number;
  /** World Y of inventory item bottoms; defaults to roomBounds.min.y. */
  floorY?: number;
};

export type InventoryLayout = {
  /** World-space root positions, keyed by the caller's stable item IDs. */
  positions: Map<string, THREE.Vector3>;
  /** Union of inventory target boxes only; empty when there are no items. */
  bounds: THREE.Box3;
};

export type ExplodeEntry = { id: string; object: THREE.Object3D };

export type ExplodeOptions = InventoryLayoutOptions & {
  durationMs?: number;
  reducedMotion?: boolean;
};

export type ExplodeController = {
  /** Requested mode, including while the positions are still transitioning. */
  readonly isExploded: boolean;
  readonly transitioning: boolean;
  readonly roomBounds: THREE.Box3;
  readonly inventoryBounds: THREE.Box3;
  setExploded(value: boolean, nowMs: number): void;
  /** Sample an animation frame; returns whether another frame is needed. */
  update(nowMs: number): boolean;
  /** Room plus current item boxes, anticipating inventory targets on explode. */
  getDisplayBounds(): THREE.Box3;
  /** Restore original transforms. Scene assets/materials remain caller-owned. */
  dispose(): void;
};

const MAX_ITEMS = 1000;
const MAX_COORDINATE = 1e9;
const MAX_DIMENSION = 1e6;

function finite(value: number, label: string, magnitude = MAX_COORDINATE) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > magnitude) {
    throw new Error(`${label} must be a bounded finite number`);
  }
  return value;
}

function identifier(id: string) {
  if (typeof id !== "string" || !id.trim() || id.length > 256) {
    throw new Error("Inventory item IDs must be nonempty strings of at most 256 characters");
  }
}

function roomBox(box: THREE.Box3) {
  if (!(box instanceof THREE.Box3) || box.isEmpty()) {
    throw new Error("Inventory layout requires nonempty room bounds");
  }
  for (const [index, value] of [...box.min.toArray(), ...box.max.toArray()].entries()) {
    finite(value, `Room bounds[${index}]`);
  }
  if (box.max.x <= box.min.x || box.max.z <= box.min.z) {
    throw new Error("Room bounds must have a positive X/Z footprint");
  }
  return box.clone();
}

function vector(value: readonly number[], label: string, positive: boolean) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`${label} requires three numbers`);
  }
  const values = value.map((component, index) => {
    finite(component, `${label}[${index}]`, MAX_DIMENSION);
    if (positive && component <= 0) throw new Error(`${label} dimensions must be positive`);
    return component;
  });
  return new THREE.Vector3(values[0], values[1], values[2]);
}

/**
 * Lay out full-size items on a size-aware grid beyond the room's +X boundary.
 * Caller order is preserved. Each column reserves its widest rotated box;
 * each row reserves its deepest box. No model is resized or reoriented.
 */
export function makeInventoryLayout(
  items: readonly InventoryItem[],
  roomBounds: THREE.Box3,
  options: InventoryLayoutOptions = {},
): InventoryLayout {
  const room = roomBox(roomBounds);
  if (!Array.isArray(items) || items.length > MAX_ITEMS) {
    throw new Error(`Inventory layout supports at most ${MAX_ITEMS} items`);
  }
  const gap = finite(options.gap ?? 0.8, "Inventory gap", MAX_DIMENSION);
  if (gap <= 0) throw new Error("Inventory gap must be positive");
  const floorY = finite(options.floorY ?? room.min.y, "Inventory floor Y");
  const seen = new Set<string>();
  const validated = items.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid inventory item");
    identifier(item.id);
    if (seen.has(item.id)) throw new Error(`Duplicate inventory item ID: ${item.id}`);
    seen.add(item.id);
    return {
      id: item.id,
      size: vector(item.size, `Item ${item.id} size`, true),
      centerOffset: vector(item.centerOffset, `Item ${item.id} centerOffset`, false),
    };
  });
  const positions = new Map<string, THREE.Vector3>();
  const bounds = new THREE.Box3();
  if (!validated.length) return { positions, bounds };
  const columns = Math.ceil(Math.sqrt(validated.length));
  const rows = Math.ceil(validated.length / columns);
  const widths = Array<number>(columns).fill(0);
  const depths = Array<number>(rows).fill(0);
  validated.forEach((item, index) => {
    widths[index % columns] = Math.max(widths[index % columns], item.size.x);
    depths[Math.floor(index / columns)] = Math.max(depths[Math.floor(index / columns)], item.size.z);
  });
  const xCenters: number[] = [];
  let xEdge = room.max.x + gap;
  for (const width of widths) {
    xCenters.push(xEdge + width / 2);
    xEdge += width + gap;
  }
  const zCenters: number[] = [];
  const totalDepth = depths.reduce((sum, depth) => sum + depth, 0) + gap * (rows - 1);
  let zEdge = room.getCenter(new THREE.Vector3()).z - totalDepth / 2;
  for (const depth of depths) {
    zCenters.push(zEdge + depth / 2);
    zEdge += depth + gap;
  }
  validated.forEach((item, index) => {
    const center = new THREE.Vector3(
      xCenters[index % columns],
      floorY + item.size.y / 2,
      zCenters[Math.floor(index / columns)],
    );
    const target = center.clone().sub(item.centerOffset);
    target.toArray().forEach((value) => finite(value, `Item ${item.id} target`));
    positions.set(item.id, target);
    bounds.union(new THREE.Box3().setFromCenterAndSize(center, item.size));
  });
  return { positions, bounds };
}

function clock(value: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Animation time must be finite, nonnegative milliseconds");
  }
  return value;
}

/**
 * Presentation-only object animation. It never edits a RoomPlan or PlacedItem.
 * All entries must be independent loaded roots, with automatic matrix updates.
 * Their parent transforms should remain stable during the controller's life.
 * Original local position/quaternion/scale are copied back exactly on restore.
 */
export function makeExplodeController(
  entries: readonly ExplodeEntry[],
  roomBounds: THREE.Box3,
  options: ExplodeOptions = {},
): ExplodeController {
  const room = roomBox(roomBounds);
  if (!Array.isArray(entries) || entries.length > MAX_ITEMS) {
    throw new Error(`Explode controller supports at most ${MAX_ITEMS} items`);
  }
  const duration = finite(options.durationMs ?? 750, "Animation duration", 60_000);
  if (duration < 0) throw new Error("Animation duration cannot be negative");
  if (options.reducedMotion !== undefined && typeof options.reducedMotion !== "boolean") {
    throw new Error("reducedMotion must be a boolean");
  }
  const reducedMotion = options.reducedMotion ?? false;
  const ids = new Set<string>();
  const roots = new Set<THREE.Object3D>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") throw new Error("Invalid explode entry");
    identifier(entry.id);
    if (ids.has(entry.id)) throw new Error(`Duplicate inventory item ID: ${entry.id}`);
    ids.add(entry.id);
    if (!(entry.object instanceof THREE.Object3D) || roots.has(entry.object)) {
      throw new Error("Explode entries require unique Object3D roots");
    }
    if (!entry.object.matrixAutoUpdate) throw new Error("Explode roots require automatic matrix updates");
    roots.add(entry.object);
  }
  for (const entry of entries) {
    for (let parent = entry.object.parent; parent; parent = parent.parent) {
      if (roots.has(parent)) throw new Error("Explode entries cannot be ancestors or descendants of one another");
    }
  }
  const original = entries.map(({ id, object }) => {
    for (const value of [...object.position.toArray(), ...object.quaternion.toArray(), ...object.scale.toArray()]) {
      finite(value, `Item ${id} transform`);
    }
    if (object.quaternion.lengthSq() <= Number.EPSILON) throw new Error(`Item ${id} has an invalid quaternion`);
    object.updateWorldMatrix(true, true);
    if (object.parent && Math.abs(object.parent.matrixWorld.determinant()) <= Number.EPSILON) {
      throw new Error(`Item ${id} has a singular parent transform`);
    }
    const box = new THREE.Box3().setFromObject(object, true);
    if (box.isEmpty()) throw new Error(`Item ${id} has no loaded geometry`);
    const worldPosition = object.getWorldPosition(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const centerOffset = box.getCenter(new THREE.Vector3()).sub(worldPosition);
    return {
      id, object,
      position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone(),
      size: size.toArray() as [number, number, number],
      centerOffset: centerOffset.toArray() as [number, number, number],
    };
  });
  const layout = makeInventoryLayout(original, room, options);
  let exploded = false;
  let animating = false;
  let disposed = false;
  let startTime = 0;
  let latestTime = 0;
  let starts = original.map((item) => item.position.clone());
  let targets = original.map((item) => item.position.clone());

  function stamp(nowMs: number) {
    latestTime = Math.max(latestTime, clock(nowMs));
    return latestTime;
  }

  function apply(positions: readonly THREE.Vector3[]) {
    original.forEach((item, index) => {
      item.object.position.copy(positions[index]);
      item.object.quaternion.copy(item.quaternion);
      item.object.scale.copy(item.scale);
      item.object.updateMatrix();
      item.object.updateWorldMatrix(true, true);
    });
  }

  function update(nowMs: number) {
    const now = stamp(nowMs);
    if (disposed || !animating) return false;
    const progress = duration === 0 ? 1 : Math.min(1, Math.max(0, (now - startTime) / duration));
    if (progress === 1) {
      apply(targets);
      animating = false;
      return false;
    }
    const eased = progress * progress * (3 - 2 * progress);
    apply(starts.map((start, index) => new THREE.Vector3().lerpVectors(start, targets[index], eased)));
    return true;
  }

  return {
    get isExploded() { return exploded; },
    get transitioning() { return animating; },
    get roomBounds() { return room.clone(); },
    get inventoryBounds() { return layout.bounds.clone(); },
    setExploded(value: boolean, nowMs: number) {
      if (disposed) throw new Error("Explode controller has been disposed");
      if (typeof value !== "boolean") throw new Error("Exploded mode must be a boolean");
      const now = stamp(nowMs);
      update(now);
      if (value === exploded) return;
      exploded = value;
      starts = original.map((item) => item.object.position.clone());
      targets = original.map((item) => {
        if (!value) return item.position.clone();
        const world = layout.positions.get(item.id)!.clone();
        item.object.parent?.updateWorldMatrix(true, false);
        return item.object.parent ? item.object.parent.worldToLocal(world) : world;
      });
      startTime = now;
      animating = !!original.length && !reducedMotion && duration > 0;
      if (!animating) apply(targets);
    },
    update,
    getDisplayBounds() {
      const bounds = room.clone();
      for (const item of original) {
        item.object.updateWorldMatrix(true, true);
        bounds.union(new THREE.Box3().setFromObject(item.object, true));
      }
      if (exploded) bounds.union(layout.bounds);
      return bounds;
    },
    dispose() {
      if (disposed) return;
      apply(original.map((item) => item.position));
      exploded = false;
      animating = false;
      disposed = true;
    },
  };
}
