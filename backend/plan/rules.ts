import type {
  CostSummary,
  PlacedItem,
  PlanChange,
  PointXZ,
  RoomPlan,
  ValidationResult,
} from "@/backend/contracts";

/**
 * Deterministic plan logic: apply changes, cost a plan, validate it.
 * Pure functions, no I/O, so the planner, routes and tests all share them.
 */

// items that sit under or beside others without blocking floor space
const NO_FOOTPRINT = new Set(["rug"]);

export class PlanChangeError extends Error {}

export function applyChanges(plan: RoomPlan, changes: PlanChange[]): RoomPlan {
  const next: RoomPlan = structuredClone(plan);
  for (const c of changes) {
    if (c.kind === "set_constraints") {
      next.constraints = { ...next.constraints, ...c.constraints };
      continue;
    }
    if (c.kind === "add") {
      if (next.items.some((i) => i.id === c.item.id)) throw new PlanChangeError(`item ${c.item.id} already exists`);
      next.items.push(structuredClone(c.item));
      continue;
    }
    const idx = next.items.findIndex((i) => i.id === c.itemId);
    if (idx < 0) throw new PlanChangeError(`no item ${c.itemId}`);
    const item = next.items[idx];
    if (c.kind === "remove") {
      next.items.splice(idx, 1);
    } else if (c.kind === "lock") {
      item.locked = c.locked;
    } else if (c.kind === "move") {
      item.position = c.position;
      item.rotationY = c.rotationY;
    } else if (c.kind === "replace") {
      const p = next.products.find((x) => x.id === c.productId);
      if (!p) throw new PlanChangeError(`no product ${c.productId}`);
      next.items[idx] = {
        ...item,
        label: p.label,
        category: p.category,
        origin: "proposed_purchase",
        productId: p.id,
        assetUrl: null,
        dimensions: p.dimensions,
        seats: p.seats,
      };
    }
  }
  return next;
}

export function costOf(plan: RoomPlan): CostSummary {
  const currency = plan.constraints.budget?.currency ?? "USD";
  let amountMinor = 0;
  const unknownPriceItemIds: string[] = [];
  for (const item of plan.items) {
    if (item.origin !== "proposed_purchase") continue;
    const price = plan.products.find((p) => p.id === item.productId)?.price;
    if (!price || price.currency !== currency) unknownPriceItemIds.push(item.id);
    else amountMinor += price.amountMinor;
  }
  return { knownSubtotal: { amountMinor, currency }, unknownPriceItemIds, feesKnown: false };
}

/** Corners of an item's footprint on the floor, after rotation about +Y. */
export function footprint(item: PlacedItem, grow = 0): PointXZ[] | null {
  if (!item.dimensions) return null;
  const [w, , d] = item.dimensions;
  const hw = w / 2 + grow;
  const hd = d / 2 + grow;
  const [cx, , cz] = item.position;
  const c = Math.cos(item.rotationY);
  const s = Math.sin(item.rotationY);
  // rotation about +Y in a right-handed frame: x' = x cos + z sin, z' = -x sin + z cos
  return (
    [
      [-hw, -hd],
      [hw, -hd],
      [hw, hd],
      [-hw, hd],
    ] as const
  ).map(([x, z]) => [cx + x * c + z * s, cz - x * s + z * c] as PointXZ);
}

function inside(p: PointXZ, poly: readonly PointXZ[]) {
  const eps = 1e-6;
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    // on an edge counts as inside
    const cross = (xj - xi) * (p[1] - zi) - (zj - zi) * (p[0] - xi);
    const within = Math.min(xi, xj) - eps <= p[0] && p[0] <= Math.max(xi, xj) + eps && Math.min(zi, zj) - eps <= p[1] && p[1] <= Math.max(zi, zj) + eps;
    if (Math.abs(cross) < eps && within) return true;
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** Separating axis test for two convex quads. Touching edges do not count as overlap. */
function overlaps(a: PointXZ[], b: PointXZ[]) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, z1] = poly[i];
      const [x2, z2] = poly[(i + 1) % poly.length];
      const axis: PointXZ = [z1 - z2, x2 - x1];
      const proj = (q: PointXZ[]) => q.map(([x, z]) => x * axis[0] + z * axis[1]);
      const pa = proj(a);
      const pb = proj(b);
      if (Math.max(...pa) <= Math.min(...pb) + 1e-9 || Math.max(...pb) <= Math.min(...pa) + 1e-9) return false;
    }
  }
  return true;
}

const money = (minor: number) => `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/**
 * Check a plan. Pass `base` to also check that locked items survived unchanged.
 * Anything not established comes back `unknown`, never `pass`.
 */
export function validate(plan: RoomPlan, base?: RoomPlan): ValidationResult[] {
  const out: ValidationResult[] = [];
  const rooms = new Map(plan.geometry.rooms.map((r) => [r.id, r]));

  // dimensions known
  const unsized = plan.items.filter((i) => !i.dimensions);
  out.push(
    unsized.length
      ? { rule: "dimensions_known", status: "unknown", itemIds: unsized.map((i) => i.id), message: `No size on record for ${unsized.map((i) => i.label).join(", ")}, so fit can't be checked.` }
      : { rule: "dimensions_known", status: "pass", itemIds: [], message: "Every item has a size." },
  );

  // proposed purchases point at a real, available product
  const badProducts = plan.items.filter((i) => {
    if (i.origin !== "proposed_purchase") return false;
    const p = plan.products.find((x) => x.id === i.productId);
    return !p || p.availability === "unavailable";
  });
  const unknownStock = plan.items.filter(
    (i) => i.origin === "proposed_purchase" && plan.products.find((x) => x.id === i.productId)?.availability === "unknown",
  );
  out.push(
    badProducts.length
      ? { rule: "product_known", status: "fail", itemIds: badProducts.map((i) => i.id), message: `${badProducts.map((i) => i.label).join(", ")} isn't available.` }
      : unknownStock.length
        ? { rule: "product_known", status: "unknown", itemIds: unknownStock.map((i) => i.id), message: `Stock not confirmed for ${unknownStock.map((i) => i.label).join(", ")}.` }
        : { rule: "product_known", status: "pass", itemIds: [], message: "Every new item is in stock." },
  );

  // inside the room
  const outside = plan.items.filter((i) => {
    const room = rooms.get(i.roomId);
    const fp = footprint(i);
    return room && fp && !fp.every((p) => inside(p, room.floorPolygon));
  });
  out.push(
    outside.length
      ? { rule: "in_room", status: "fail", itemIds: outside.map((i) => i.id), message: `${outside.map((i) => i.label).join(", ")} sticks out past the walls.` }
      : { rule: "in_room", status: unsized.length ? "unknown" : "pass", itemIds: [], message: "Everything sits inside the room." },
  );

  // no overlaps, with clearance between pieces
  const gap = plan.constraints.clearance / 2;
  const solid = plan.items.filter((i) => i.dimensions && !NO_FOOTPRINT.has(i.category));
  const clashes: string[][] = [];
  for (let a = 0; a < solid.length; a++) {
    for (let b = a + 1; b < solid.length; b++) {
      if (solid[a].roomId !== solid[b].roomId) continue;
      if (overlaps(footprint(solid[a], gap)!, footprint(solid[b], gap)!)) clashes.push([solid[a].id, solid[b].id]);
    }
  }
  const label = (id: string) => plan.items.find((i) => i.id === id)!.label;
  out.push(
    clashes.length
      ? {
          rule: "no_overlap",
          status: "fail",
          itemIds: [...new Set(clashes.flat())],
          message: `Too tight: ${clashes.map(([a, b]) => `${label(a)} and ${label(b)}`).join("; ")} (need ${plan.constraints.clearance} m between pieces).`,
        }
      : { rule: "no_overlap", status: unsized.length ? "unknown" : "pass", itemIds: [], message: `At least ${plan.constraints.clearance} m between pieces.` },
  );

  // seats
  const min = plan.constraints.minimumSeats;
  if (min !== null) {
    const seats = plan.items.reduce((n, i) => n + (i.seats ?? 0), 0);
    out.push({
      rule: "seats",
      status: seats >= min ? "pass" : "fail",
      itemIds: [],
      message: seats >= min ? `Seats ${seats}, need ${min}.` : `Only seats ${seats}, need ${min}.`,
    });
  }

  // budget
  const budget = plan.constraints.budget;
  if (budget) {
    const cost = costOf(plan);
    const over = cost.knownSubtotal.amountMinor > budget.amountMinor;
    out.push({
      rule: "budget",
      status: over ? "fail" : cost.unknownPriceItemIds.length ? "unknown" : "pass",
      itemIds: cost.unknownPriceItemIds,
      message: over
        ? `New items come to ${money(cost.knownSubtotal.amountMinor)}, over the ${money(budget.amountMinor)} cap.`
        : `New items come to ${money(cost.knownSubtotal.amountMinor)} of ${money(budget.amountMinor)}, before shipping and tax.`,
    });
  }

  // locked items untouched
  if (base) {
    const broken = base.items
      .filter((i) => i.locked)
      .filter((i) => {
        const now = plan.items.find((x) => x.id === i.id);
        return (
          !now ||
          now.productId !== i.productId ||
          now.rotationY !== i.rotationY ||
          now.position.some((v, k) => Math.abs(v - i.position[k]) > 1e-6)
        );
      });
    out.push(
      broken.length
        ? { rule: "locked_kept", status: "fail", itemIds: broken.map((i) => i.id), message: `${broken.map((i) => i.label).join(", ")} is locked and can't change.` }
        : { rule: "locked_kept", status: "pass", itemIds: [], message: "Locked items untouched." },
    );
  }

  return out;
}

export const passes = (results: ValidationResult[]) => results.every((r) => r.status !== "fail");
