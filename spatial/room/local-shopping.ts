import type { ApplyResult, Evidence, FloorSpot, PlanChange, ProductCandidate, RoomPlan, ShopRequest, ShopResult } from "../../backend/contracts";
import catalogJson from "../../backend/fixtures/real-catalog.json";
import { applyChanges, blocking, costOf, validateChanges } from "../../backend/plan/rules";
import { assetUrlFor } from "../../backend/shopping/assets";
import { placeAt } from "../../backend/shopping/placement";
import { catalogCandidates, itemFor, rank } from "../../backend/shopping/spot";

/** This module is deliberately local: no provider, project upload or payment calls. */
export const LOCAL_SHOPPING_NOTICE = "Local preview basket. Saved retailer prices and stock have not been rechecked. Models approximate the product category; shipping and tax are unknown.";
const catalog = catalogJson as unknown as { products: ProductCandidate[]; evidence: Evidence[] };
const FIT_OPTIONS = { maxShiftM: .4, stepM: .15, fallback: false } as const;

/** Preserve an existing record when a catalog ID happens to collide with it. */
function availableId<T extends { id: string }>(record: T, records: T[], reserved: Set<string>): string {
  for (let n = 0; ; n++) {
    const candidate = n ? `local_catalog_${n}_${record.id}` : record.id;
    const existing = records.find((entry) => entry.id === candidate);
    if (existing && JSON.stringify(existing) === JSON.stringify({ ...record, id: candidate })) return candidate;
    if (!existing && !reserved.has(candidate)) return candidate;
  }
}

/** Keep the immutable reconstruction plan separate from this shopping snapshot. */
export function prepareLocalShoppingPlan(plan: RoomPlan): RoomPlan {
  const next = structuredClone(plan);
  const entityIds = new Set([...next.geometry.rooms, ...next.geometry.walls, ...next.geometry.openings, ...next.items].map((entry) => entry.id));
  const evidenceIds = new Map<string, string>();
  for (const source of catalog.evidence) {
    const id = availableId(source, next.evidence, entityIds);
    evidenceIds.set(source.id, id);
    if (!next.evidence.some((entry) => entry.id === id)) next.evidence.push({ ...structuredClone(source), id });
  }
  for (const source of catalog.products) {
    const product = { ...structuredClone(source), evidenceIds: source.evidenceIds.map((id) => evidenceIds.get(id) ?? id) };
    const id = availableId(product, next.products, entityIds);
    if (!next.products.some((entry) => entry.id === id)) next.products.push({ ...product, id });
  }
  return next;
}

function validSpot(spot: FloorSpot): boolean {
  return Array.isArray(spot?.position) && spot.position.length === 3 && spot.position.every(Number.isFinite)
    && (spot.rotationY == null || Number.isFinite(spot.rotationY));
}

/** Evaluate only a small neighborhood of the pointed spot; never sweep the whole room. */
export function searchLocalProducts(plan: RoomPlan, request: ShopRequest): ShopResult[] {
  if (!validSpot(request.spot)) return [];
  const subtotal = costOf(plan).knownSubtotal.amountMinor;
  const results = catalogCandidates(plan, request)
    .filter((product) => !request.merchant || product.merchant === request.merchant)
    .map((product): ShopResult => {
      const fit = placeAt(plan, product, request.spot, FIT_OPTIONS);
      const problems: string[] = [];
      if (!fit.ok) problems.push(fit.message);
      if (product.availability === "unavailable") problems.push("Unavailable in the saved catalog observation.");
      if (product.availability === "unknown") problems.push("Stock was not established in the saved catalog observation.");
      if (!product.price) problems.push("No observed price.");
      const budget = plan.constraints.budget;
      const comparable = budget && product.price && product.price.currency === budget.currency;
      const over = comparable ? Math.max(0, subtotal + product.price!.amountMinor - budget.amountMinor) : null;
      return {
        product, source: "catalog", fits: fit.ok && product.availability !== "unavailable" && product.price !== null,
        placement: fit.ok ? fit.placement : null, problems,
        withinBudget: over === null ? null : over === 0,
        overBudgetUsd: over ? over / 100 : null,
        assetUrl: assetUrlFor(product.category, product.dimensions),
      };
    });
  return rank(results, request.request).slice(0, 6);
}

function refuse(message: string, rule: "in_room" | "product_known" = "product_known"): ApplyResult {
  return { ok: false, reason: "validation_failed", validations: [{ rule, status: "fail", itemIds: [], message }] };
}

/** Recheck before committing; a result card is never permission to reuse a stale placement. */
export function commitLocalProduct(plan: RoomPlan, productId: string, spot: FloorSpot, expectedRevision: number): ApplyResult {
  if (plan.revision !== expectedRevision) return { ok: false, reason: "stale_revision", currentRevision: plan.revision };
  const product = plan.products.find((entry) => entry.id === productId && !entry.fixture);
  if (!product || !product.price || !product.dimensions) return refuse("Choose an observed product with a recorded price and dimensions.");
  if (product.availability === "unavailable") return refuse("This product was unavailable in the saved catalog observation.");
  if (!validSpot(spot)) return refuse("Choose a finite floor point.", "in_room");
  const fit = placeAt(plan, product, spot, FIT_OPTIONS);
  if (!fit.ok) return refuse(fit.message, "in_room");
  const reserved = new Set([...plan.geometry.rooms, ...plan.geometry.walls, ...plan.geometry.openings, ...plan.items].map((entry) => entry.id));
  let id: string;
  do { id = `local_purchase_${crypto.randomUUID()}`; } while (reserved.has(id));
  const changes: PlanChange[] = [{ kind: "add", item: itemFor(product, fit.placement, id) }];
  const next = applyChanges(plan, changes);
  const validations = validateChanges(plan, changes, next);
  if (blocking(plan, changes, next, validations).length) return { ok: false, reason: "validation_failed", validations };
  next.revision = plan.revision + 1;
  return { ok: true, plan: next };
}

/** Remove only a local purchase; captured owned furniture is never a basket line. */
export function removeLocalPurchase(plan: RoomPlan, itemId: string, expectedRevision: number): ApplyResult {
  if (plan.revision !== expectedRevision) return { ok: false, reason: "stale_revision", currentRevision: plan.revision };
  const item = plan.items.find((entry) => entry.id === itemId);
  if (!item || item.origin !== "proposed_purchase") return refuse("Only a proposed purchase can be removed from the preview basket.");
  if (item.locked) return { ok: false, reason: "validation_failed", validations: [{ rule: "locked_kept", status: "fail", itemIds: [itemId], message: "This purchase is locked; unlock it before removing it." }] };
  const changes: PlanChange[] = [{ kind: "remove", itemId }];
  const next = applyChanges(plan, changes);
  const validations = validateChanges(plan, changes, next);
  if (blocking(plan, changes, next, validations).length) return { ok: false, reason: "validation_failed", validations };
  next.revision = plan.revision + 1;
  return { ok: true, plan: next };
}

export const localShoppingCost = costOf;
