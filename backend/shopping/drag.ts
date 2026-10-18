import type { PlacedItem, PlanChange, RoomPlan, Vector3Meters } from "@/backend/contracts";
import { applyChanges, validate } from "@/backend/plan/rules";
import { placeAt } from "@/backend/shopping/placement";

/**
 * Hand-held furniture. While the shopper carries a piece (mouse, touch, or a
 * hand in the headset), the viewer calls `dragCheck` every frame with where the
 * piece is: it says whether it fits right there (green) or not (red, and why),
 * and the nearest pose within a hand's width that does fit, so the piece can
 * gently snap clear of walls and other furniture. Pure and browser-safe, no
 * network: it runs the same rules the server will check on drop.
 *
 * On release, send `dropChange(...)` through POST /changes (or roomClient.drop).
 */

export interface DragCheck {
  /** The exact pose fits. */
  fits: boolean;
  /** Where to show the piece: the exact pose if it fits, else the nearest pose that does, else the exact pose (red). */
  pose: { position: Vector3Meters; rotationY: number };
  /** The pose was moved to make it fit. */
  snapped: boolean;
  /** Dropping now would succeed (at `pose`). */
  droppable: boolean;
  /** Why the exact pose doesn't fit, in plain words. */
  problems: string[];
}

const SNAP_M = 0.25;

/** Where the shopper is holding the piece now. */
export function dragCheck(plan: RoomPlan, itemId: string, position: Vector3Meters, rotationY: number, opts: { snapM?: number } = {}): DragCheck {
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`no item ${itemId}`);
  const at: Vector3Meters = [position[0], 0, position[2]];
  const exact = placeAt(plan, item, { position: at, rotationY }, { ignoreItemId: itemId, maxShiftM: 0, fallback: false, keepFacing: true });
  if (exact.ok) return { fits: true, pose: { position: exact.placement.position, rotationY }, snapped: false, droppable: true, problems: [] };

  const problems = whyNot(plan, item, at, rotationY, exact.ok ? null : exact.message);
  const near = placeAt(plan, item, { position: at, rotationY }, { ignoreItemId: itemId, maxShiftM: opts.snapM ?? SNAP_M, stepM: 0.05, fallback: false, keepFacing: true });
  if (near.ok) return { fits: false, pose: { position: near.placement.position, rotationY }, snapped: true, droppable: true, problems };
  return { fits: false, pose: { position: at, rotationY }, snapped: false, droppable: false, problems };
}

/** The validator's own words for what's wrong with this pose. */
function whyNot(plan: RoomPlan, item: PlacedItem, position: Vector3Meters, rotationY: number, fallback: string | null) {
  const trial: RoomPlan = { ...plan, items: plan.items.map((i) => (i.id === item.id ? { ...i, position, rotationY, stored: false } : i)) };
  const msgs = validate(trial)
    .filter((v) => (v.rule === "in_room" || v.rule === "no_overlap") && v.status === "fail" && v.itemIds.includes(item.id))
    .map((v) => v.message);
  return msgs.length ? msgs : fallback ? [fallback] : [];
}

/** The change to save when the shopper lets go. A stored piece comes out of inventory. */
export function dropChange(item: Pick<PlacedItem, "id" | "stored">, pose: DragCheck["pose"]): PlanChange {
  return item.stored
    ? { kind: "take_out", itemId: item.id, position: pose.position, rotationY: pose.rotationY }
    : { kind: "move", itemId: item.id, position: pose.position, rotationY: pose.rotationY };
}

/** Quarter-turn helper for a "rotate" gesture or key. */
export const turned = (rotationY: number, quarters = 1) => {
  const r = (rotationY + (quarters * Math.PI) / 2) % (2 * Math.PI);
  return r > Math.PI ? r - 2 * Math.PI : r <= -Math.PI ? r + 2 * Math.PI : r;
};

/** What's in inventory, for the tray. */
export const inventory = (plan: RoomPlan) => plan.items.filter((i) => i.stored);

/** Preview the plan with a drop applied, e.g. to update totals while dragging out of inventory. */
export const withDrop = (plan: RoomPlan, item: Pick<PlacedItem, "id" | "stored">, pose: DragCheck["pose"]) => applyChanges(plan, [dropChange(item, pose)]);
