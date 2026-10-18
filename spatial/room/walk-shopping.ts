import type { PlanChange, PlacedItem, ProductCandidate, RoomPlan, Vector3Meters } from "../../backend/contracts";
import { applyChanges, blocking, validateChanges } from "../../backend/plan/rules";

/** Pure recheck shared by hover previews, confirmation, add and swap. No plan mutation. */
export function validateWalkProduct(plan: RoomPlan, product: ProductCandidate, position: Vector3Meters, rotationY: number, swapId?: string): void {
  if (!product.dimensions?.every((n) => Number.isFinite(n) && n > 0) || !product.price
    || !Number.isSafeInteger(product.price.amountMinor) || product.price.amountMinor < 0) throw new Error("This product needs recorded dimensions and a valid price before placement.");
  if (product.availability === "unavailable") throw new Error("This product is unavailable in the saved retailer observation.");
  if (![...position, rotationY].every(Number.isFinite)) throw new Error("Choose a finite floor position.");
  const old = swapId ? plan.items.find((item) => item.id === swapId && !item.stored) : null;
  if (swapId && (!old || old.locked)) throw new Error("Choose an unlocked piece in the room to replace.");
  const budget = plan.constraints.budget;
  if (budget && product.price.currency !== budget.currency) throw new Error("The product price currency does not match this room's budget.");
  let id = `walk-preview-${product.id}`;
  while (plan.items.some((item) => item.id === id)) id += "-next";
  const item: PlacedItem = { id, label: product.label, category: product.category, roomId: old?.roomId ?? plan.geometry.rooms[0].id,
    origin: "proposed_purchase", productId: product.id, assetUrl: null, dimensions: [...product.dimensions], position: [...position], rotationY, seats: product.seats, locked: false };
  const base = structuredClone(plan);
  base.products = [...base.products.filter((entry) => entry.id !== product.id), structuredClone(product)];
  const changes: PlanChange[] = [...(swapId ? [{ kind: "remove" as const, itemId: swapId }] : []), { kind: "add", item }];
  const next = applyChanges(base, changes);
  const failures = blocking(base, changes, next, validateChanges(base, changes, next));
  if (failures.length) throw new Error(failures.map((result) => result.message).join(" "));
}
