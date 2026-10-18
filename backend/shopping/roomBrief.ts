import type { FurnitureCategory, PlacedItem, ProductCandidate, RoomPlan, ValidationResult, Vector3Meters } from "@/backend/contracts";
import { applyChanges, costOf, validate } from "@/backend/plan/rules";

/**
 * What the shopping agent knows about the room before it searches: the room
 * itself, the free space at the spot being shopped for, the money left, the
 * seats the piece has to provide, and what's already there. Pure, derived from
 * the live plan every time, so it can't go stale.
 */

export interface SpotSpace {
  /** Widest the piece can be at this spot, keeping the current depth. Null if nothing fits. */
  maxWidthM: number | null;
  /** Deepest the piece can be, keeping the current width. */
  maxDepthM: number | null;
  maxHeightM: number;
  /** Size the space was measured around (the current piece, or a probe). */
  aroundWHD: Vector3Meters;
}

export interface ShoppingBrief {
  projectId: string;
  planRevision: number;
  category: FurnitureCategory;
  /** Item being replaced, or null when shopping for a new spot. */
  replacingItemId: string | null;
  room: { label: string; widthM: number; depthM: number; heightM: number; openings: string[] };
  space: SpotSpace;
  budget: { capUsd: number | null; otherNewPurchasesUsd: number; maxPriceUsd: number | null };
  /** Seats this piece must provide for the room to still meet its minimum. */
  seatsRequired: number;
  /** Things in the room the new piece should sit well with. */
  context: { owned: string[]; otherNew: string[] };
  /** The same facts as one paragraph, for a browsing agent's task prompt. */
  text: string;
}

const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
const usd = (minor: number) => minor / 100;
const cm = (m: number) => `${Math.round(m * 100)} cm`;
const inches = (m: number) => `${(m / 0.0254).toFixed(0)} in`;

const PROBE_ID = "__probe__";

/** Does a piece of this size, at this item's spot, stay in the room and clear of everything else? */
function fitsAt(plan: RoomPlan, item: PlacedItem, whd: Vector3Meters) {
  const trial: RoomPlan = { ...plan, items: plan.items.map((i) => (i.id === item.id ? { ...i, dimensions: whd } : i)) };
  return !validate(trial).some(
    (v: ValidationResult) => (v.rule === "in_room" || v.rule === "no_overlap") && v.status === "fail" && v.itemIds.includes(item.id),
  );
}

/** Largest value in [lo, hi] for which ok() holds, assuming ok is monotone (true then false). */
function grow(ok: (v: number) => boolean, lo: number, hi: number) {
  if (!ok(lo)) return null;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function spaceAt(plan: RoomPlan, item: PlacedItem): SpotSpace {
  const room = plan.geometry.rooms.find((r) => r.id === item.roomId) ?? plan.geometry.rooms[0];
  const xs = room.floorPolygon.map((p) => p[0]);
  const zs = room.floorPolygon.map((p) => p[1]);
  const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  const [w, h, d] = item.dimensions ?? [0.3, 0.3, 0.3];
  const solid = item.category !== "rug";
  return {
    maxWidthM: solid ? grow((v) => fitsAt(plan, item, [v, h, d]), 0.05, span) : null,
    maxDepthM: solid ? grow((v) => fitsAt(plan, item, [w, h, v]), 0.05, span) : null,
    maxHeightM: room.height,
    aroundWHD: [w, h, d],
  };
}

export function shoppingBrief(
  plan: RoomPlan,
  target: { itemId: string } | { category: FurnitureCategory; position: Vector3Meters; rotationY?: number; roomId?: string },
): ShoppingBrief {
  const replacing = "itemId" in target ? plan.items.find((i) => i.id === target.itemId) : null;
  if ("itemId" in target && !replacing) throw new Error(`no item ${target.itemId}`);

  // a new spot is measured by dropping a small probe there
  const probe: PlacedItem | null =
    replacing ??
    ("position" in target
      ? {
          id: PROBE_ID,
          roomId: target.roomId ?? plan.geometry.rooms[0].id,
          label: "new piece",
          category: target.category,
          origin: "proposed_purchase",
          productId: null,
          assetUrl: null,
          position: target.position,
          rotationY: target.rotationY ?? 0,
          dimensions: [0.3, 0.3, 0.3],
          seats: null,
          locked: false,
        }
      : null);
  const measured = probe && !replacing ? applyChanges(plan, [{ kind: "add", item: probe }]) : plan;
  const space = spaceAt(measured, probe!);

  const room = plan.geometry.rooms.find((r) => r.id === probe!.roomId) ?? plan.geometry.rooms[0];
  const xs = room.floorPolygon.map((p) => p[0]);
  const zs = room.floorPolygon.map((p) => p[1]);

  const cost = costOf(plan);
  const priceOf = (i: PlacedItem) => plan.products.find((p: ProductCandidate) => p.id === i.productId)?.price?.amountMinor ?? 0;
  const replacingSpend = replacing && replacing.origin === "proposed_purchase" ? priceOf(replacing) : 0;
  const otherMinor = cost.knownSubtotal.amountMinor - replacingSpend;
  const capMinor = plan.constraints.budget?.amountMinor ?? null;

  const seatsNow = plan.items.filter((i) => !i.stored).reduce((n, i) => n + (i.seats ?? 0), 0);
  const seatsRequired = Math.max(0, (plan.constraints.minimumSeats ?? 0) - (seatsNow - (replacing?.seats ?? 0)));

  const others = plan.items.filter((i) => i.id !== replacing?.id && !i.stored);
  const brief: Omit<ShoppingBrief, "text"> = {
    projectId: plan.projectId,
    planRevision: plan.revision,
    category: replacing?.category ?? ("category" in target ? target.category : "other"),
    replacingItemId: replacing?.id ?? null,
    room: {
      label: room.label,
      widthM: round(Math.max(...xs) - Math.min(...xs)),
      depthM: round(Math.max(...zs) - Math.min(...zs)),
      heightM: room.height,
      openings: plan.geometry.openings.map((o) => `${o.kind} ${round(o.width)} m wide on ${o.wallId.replace("wall_", "")} wall`),
    },
    space: {
      ...space,
      maxWidthM: space.maxWidthM === null ? null : round(space.maxWidthM),
      maxDepthM: space.maxDepthM === null ? null : round(space.maxDepthM),
    },
    budget: {
      capUsd: capMinor === null ? null : usd(capMinor),
      otherNewPurchasesUsd: usd(otherMinor),
      maxPriceUsd: capMinor === null ? null : Math.max(0, usd(capMinor - otherMinor)),
    },
    seatsRequired,
    context: {
      owned: others.filter((i) => i.origin === "existing_owned").map((i) => i.label),
      otherNew: others.filter((i) => i.origin === "proposed_purchase").map((i) => i.label),
    },
  };
  return { ...brief, text: describe(brief, replacing) };
}

function describe(b: Omit<ShoppingBrief, "text">, replacing: PlacedItem | null | undefined) {
  const parts = [
    `Shopping for a ${b.category}${replacing ? ` to replace "${replacing.label}"` : ""} in a ${b.room.widthM} x ${b.room.depthM} m ${b.room.label.toLowerCase()} with ${b.room.heightM} m ceilings.`,
  ];
  if (b.space.maxWidthM !== null && b.space.maxDepthM !== null) {
    const [w, , d] = b.space.aroundWHD;
    parts.push(
      `At its spot it can be at most ${cm(b.space.maxWidthM)} (${inches(b.space.maxWidthM)}) wide if about ${cm(d)} deep, or at most ${cm(b.space.maxDepthM)} (${inches(b.space.maxDepthM)}) deep if about ${cm(w)} wide.`,
    );
  } else if (b.category !== "rug") {
    parts.push("Nothing fits at that spot as things stand.");
  }
  if (b.budget.maxPriceUsd !== null) parts.push(`Spend at most $${Math.floor(b.budget.maxPriceUsd)}.`);
  if (b.seatsRequired > 0) parts.push(`It must seat at least ${b.seatsRequired}.`);
  if (b.context.owned.length) parts.push(`The shopper already owns: ${b.context.owned.join(", ")}.`);
  if (b.context.otherNew.length) parts.push(`Also going in the room: ${b.context.otherNew.join(", ")}.`);
  return parts.join(" ");
}

/** Check researched products against the room as it is now. */
export function fitCheck(plan: RoomPlan, itemId: string, products: ProductCandidate[]) {
  const withProducts: RoomPlan = { ...plan, products: [...plan.products.filter((p) => !products.some((n) => n.id === p.id)), ...products] };
  return products.map((product) => {
    const next = applyChanges(withProducts, [{ kind: "replace", itemId, productId: product.id }]);
    const results = validate(next, plan);
    return {
      product,
      fits: results.every((r) => r.status === "pass"),
      problems: results.filter((r) => r.status !== "pass").map((r) => `${r.rule}: ${r.message}`),
    };
  });
}
