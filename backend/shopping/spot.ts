import type { FurnitureCategory, PlacedItem, ProductCandidate, RoomPlan, ShopRequest, ShopResult, Vector3Meters } from "@/backend/contracts";
import { costOf } from "@/backend/plan/rules";
import { assetUrlFor } from "@/backend/shopping/assets";
import { facingAt, placeAt, roomAt } from "@/backend/shopping/placement";
import { shoppingBrief } from "@/backend/shopping/roomBrief";

/**
 * Shopping for a spot on the floor, the pure half: which products fit there
 * as the room is now, what they'd do to the budget, and how to rank them.
 * Everything is re-derived from the plan passed in, so results never go stale.
 */

/** Rough size of a typical piece, used to measure a spot before anything is picked. */
const TYPICAL: Record<FurnitureCategory, Vector3Meters> = {
  sofa: [1.6, 0.8, 0.9],
  chair: [0.75, 0.8, 0.8],
  table: [0.9, 0.45, 0.6],
  storage: [0.8, 1.8, 0.4],
  desk: [1.2, 0.75, 0.6],
  bed: [1.5, 0.5, 2.0],
  rug: [1.5, 0.01, 2.1],
  lamp: [0.4, 1.6, 0.4],
  decor: [0.3, 0.4, 0.3],
  other: [0.5, 0.5, 0.5],
};

export const SEARCH_TERM: Record<FurnitureCategory, string> = {
  sofa: "sofa or loveseat",
  chair: "armchair",
  table: "coffee table",
  storage: "bookcase",
  desk: "desk",
  bed: "bed frame",
  rug: "area rug",
  lamp: "floor lamp",
  decor: "decor",
  other: "furniture",
};

const words = (s: string | null | undefined) =>
  new Set(
    (s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );

/** Widest piece of this kind (at a typical depth) that fits at the spot, for the search prompt. */
export function maxWidthAtSpot(plan: RoomPlan, req: Pick<ShopRequest, "category" | "spot">) {
  if (req.category === "rug") return null;
  const [, h, d] = TYPICAL[req.category];
  const fits = (w: number) => placeAt(plan, { category: req.category, dimensions: [w, h, d] }, req.spot, { maxShiftM: 0.6, stepM: 0.1, fallback: false }).ok;
  if (!fits(0.3)) return null;
  let lo = 0.3;
  let hi = 6;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return Math.round(lo * 100) / 100;
}

/** The room facts for a browsing agent, measured at the spot. */
export function spotBrief(plan: RoomPlan, req: Pick<ShopRequest, "category" | "spot" | "maxPriceUsd" | "request">) {
  const facing = facingAt(plan, req.spot);
  const brief = shoppingBrief(plan, { category: req.category, position: req.spot.position, rotationY: req.spot.rotationY ?? facing?.rotationY ?? 0 });
  const maxWidthM = maxWidthAtSpot(plan, req);
  const budgetLeft = brief.budget.maxPriceUsd;
  const cap = req.maxPriceUsd ?? null;
  const parts = [
    `Shopping for a ${SEARCH_TERM[req.category]} for one spot in a ${brief.room.widthM} x ${brief.room.depthM} m ${brief.room.label.toLowerCase()} with ${brief.room.heightM} m ceilings.`,
    maxWidthM !== null ? `It can be at most ${Math.round(maxWidthM * 100)} cm (${(maxWidthM / 0.0254).toFixed(0)} in) wide there.` : "",
    cap !== null ? `The shopper wants it under $${cap}.` : "",
    budgetLeft !== null ? `Their room budget has $${Math.floor(budgetLeft)} left.` : "",
    req.request ? `They asked for: ${req.request}.` : "",
    brief.context.owned.length ? `They already own: ${brief.context.owned.join(", ")}.` : "",
  ];
  return { text: parts.filter(Boolean).join(" "), maxWidthM, budgetLeftUsd: budgetLeft };
}

/** Check one product at the spot against the room as it is now. */
export function evaluate(plan: RoomPlan, product: ProductCandidate, req: ShopRequest, source: ShopResult["source"]): ShopResult {
  const problems: string[] = [];
  if (product.availability === "unavailable") problems.push("Out of stock.");
  if (!product.dimensions) problems.push("No size listed, so it can't be fit-checked.");
  if (!product.price) problems.push("No price listed.");

  const fit = product.dimensions ? placeAt(plan, product, req.spot) : null;
  if (fit && !fit.ok) problems.push(fit.message);

  const budget = plan.constraints.budget;
  let withinBudget: boolean | null = null;
  let overBudgetUsd: number | null = null;
  if (budget && product.price && product.price.currency === budget.currency) {
    const after = costOf(plan).knownSubtotal.amountMinor + product.price.amountMinor;
    withinBudget = after <= budget.amountMinor;
    overBudgetUsd = withinBudget ? null : Math.round(after - budget.amountMinor) / 100;
  }

  return {
    product,
    source,
    fits: !!fit?.ok && product.availability !== "unavailable",
    placement: fit?.ok ? fit.placement : null,
    problems,
    withinBudget,
    overBudgetUsd,
    assetUrl: assetUrlFor(product.category, product.dimensions),
  };
}

/** Best first: fits, then within budget, then matches the shopper's words, then cheaper. */
export function rank(results: ShopResult[], request: string | null | undefined) {
  const want = words(request);
  const match = (r: ShopResult) => [...words(r.product.label)].filter((w) => want.has(w)).length;
  return [...results].sort(
    (a, b) =>
      Number(b.fits) - Number(a.fits) ||
      Number(b.withinBudget !== false) - Number(a.withinBudget !== false) ||
      match(b) - match(a) ||
      (a.product.price?.amountMinor ?? Infinity) - (b.product.price?.amountMinor ?? Infinity) ||
      a.product.id.localeCompare(b.product.id),
  );
}

/** Within the shopper's own cap. Unpriced products can't be shown as under it. */
export const underCap = (p: ProductCandidate, req: Pick<ShopRequest, "maxPriceUsd">) =>
  req.maxPriceUsd == null || (p.price !== null && p.price.amountMinor <= Math.round(req.maxPriceUsd * 100));

/** Catalog products worth checking for this request: the right kind, real, under the cap. */
export const catalogCandidates = (plan: RoomPlan, req: ShopRequest) =>
  plan.products.filter((p) => p.category === req.category && !p.fixture && underCap(p, req));

export function evaluateAll(plan: RoomPlan, entries: Array<{ product: ProductCandidate; source: ShopResult["source"] }>, req: ShopRequest) {
  return rank(
    entries.map((e) => evaluate(plan, e.product, req, e.source)),
    req.request,
  );
}

/** The placed item for a product at a placement. */
export function itemFor(product: ProductCandidate, placement: { roomId: string; position: Vector3Meters; rotationY: number }, id: string): PlacedItem {
  return {
    id,
    roomId: placement.roomId,
    label: product.label,
    category: product.category,
    origin: "proposed_purchase",
    productId: product.id,
    assetUrl: assetUrlFor(product.category, product.dimensions),
    position: placement.position,
    rotationY: placement.rotationY,
    dimensions: product.dimensions,
    seats: product.seats,
    locked: false,
  };
}

export const onFloor = (plan: RoomPlan, req: Pick<ShopRequest, "spot">) => roomAt(plan, req.spot) !== null;
