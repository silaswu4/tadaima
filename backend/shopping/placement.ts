import type { FloorSpot, FurnitureCategory, Placement, PointXZ, RoomGeometry, RoomPlan, Vector3Meters } from "@/backend/contracts";
import { footprint, inside, NO_FOOTPRINT, overlaps } from "@/backend/plan/rules";

/**
 * Where a piece goes when the shopper points at a spot. Pure and deterministic.
 *
 * The spot is a point on the floor (what the viewer's raycast hits). Pieces
 * that live against a wall (sofas, shelves, desks, beds) snap their back to
 * the nearest wall and face into the room; chairs, and wall pieces out in the
 * open, face the middle of the room (squared to the walls); everything else
 * faces away from the nearest wall. If that exact pose is blocked, the
 * piece slides (along the wall first) or turns until it clears every other
 * piece by the plan's clearance and stays inside the room: the same in_room
 * and no_overlap rules the validator enforces, so a placement here always
 * passes them.
 */

export type Spot = FloorSpot;

export type FitResult =
  | { ok: true; placement: Placement }
  | {
      ok: false;
      reason: "off_floor" | "no_size" | "too_big" | "no_room_nearby";
      message: string;
      /** For no_room_nearby: the closest pose anywhere in the room that does fit. */
      nearest: Placement | null;
    };

export interface PlaceOptions {
  /** An item being moved: it doesn't block itself. */
  ignoreItemId?: string | null;
  /** How far from the spot to look before giving up. Default 1.2 m. */
  maxShiftM?: number;
  /** Grid step, meters. Default 0.05. */
  stepM?: number;
  /** On a miss, also search the whole room for the nearest pose that fits. Default true. */
  fallback?: boolean;
}

export const WALL_BACKED = new Set<FurnitureCategory>(["sofa", "storage", "desk", "bed"]);
const SNAP_M = 0.9; // a wall piece snaps if the spot is within this of the wall (beyond half its depth)
const WALL_GAP = 0.01;

const round = (n: number, p = 3) => Math.round(n * 10 ** p) / 10 ** p;
const wrap = (a: number) => {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return round(r, 6) === round(-Math.PI, 6) ? Math.PI : r;
};

interface Edge {
  a: PointXZ;
  b: PointXZ;
  t: PointXZ; // unit tangent
  n: PointXZ; // unit inward normal
  len: number;
  wallId: string | null;
}

function edgesOf(geometry: RoomGeometry, poly: readonly PointXZ[]): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const t: PointXZ = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let n: PointXZ = [-t[1], t[0]];
    const mid: PointXZ = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!inside([mid[0] + n[0] * 0.01, mid[1] + n[1] * 0.01], poly)) n = [-n[0], -n[1]];
    const same = (p: PointXZ, q: PointXZ) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-3;
    const wall = geometry.walls.find((w) => (same(w.start, a) && same(w.end, b)) || (same(w.start, b) && same(w.end, a)));
    out.push({ a, b, t, n, len, wallId: wall?.id ?? null });
  }
  return out;
}

/** Nearest edge to p, the foot of the perpendicular, and the distance. */
function nearestEdge(edges: Edge[], p: PointXZ) {
  let best: { edge: Edge; foot: PointXZ; dist: number } | null = null;
  for (const e of edges) {
    const s = Math.max(0, Math.min(e.len, (p[0] - e.a[0]) * e.t[0] + (p[1] - e.a[1]) * e.t[1]));
    const foot: PointXZ = [e.a[0] + e.t[0] * s, e.a[1] + e.t[1] * s];
    const dist = Math.hypot(p[0] - foot[0], p[1] - foot[1]);
    if (!best || dist < best.dist) best = { edge: e, foot, dist };
  }
  return best!;
}

export function roomAt(plan: RoomPlan, spot: Spot) {
  const p: PointXZ = [spot.position[0], spot.position[2]];
  if (spot.roomId) {
    const r = plan.geometry.rooms.find((x) => x.id === spot.roomId);
    return r && inside(p, r.floorPolygon) ? r : null;
  }
  return plan.geometry.rooms.find((r) => inside(p, r.floorPolygon)) ?? null;
}

/** The automatic facing at a spot: back to the nearest wall, front into the room. */
export function facingAt(plan: RoomPlan, spot: Spot) {
  const room = roomAt(plan, spot);
  if (!room) return null;
  const near = nearestEdge(edgesOf(plan.geometry, room.floorPolygon), [spot.position[0], spot.position[2]]);
  // front is local +Z, which rotationY r sends to (sin r, cos r)
  return { rotationY: wrap(Math.atan2(near.edge.n[0], near.edge.n[1])), wall: near };
}

export function placeAt(
  plan: RoomPlan,
  piece: { category: FurnitureCategory; dimensions: Vector3Meters | null },
  spot: Spot,
  opts: PlaceOptions = {},
): FitResult {
  const room = roomAt(plan, spot);
  if (!room) return { ok: false, reason: "off_floor", message: "That spot isn't on the floor of a room.", nearest: null };
  if (!piece.dimensions) return { ok: false, reason: "no_size", message: "This piece has no size on record, so it can't be placed.", nearest: null };

  const [w, , d] = piece.dimensions;
  const edges = edgesOf(plan.geometry, room.floorPolygon);
  const spotXZ: PointXZ = [spot.position[0], spot.position[2]];
  const near = nearestEdge(edges, spotXZ);
  const chosen = spot.rotationY ?? null;
  const wallBacked = WALL_BACKED.has(piece.category) && chosen === null;
  const snaps = wallBacked && near.dist <= d / 2 + SNAP_M;
  // against a wall: face out from it. Out in the open (and for chairs): face the middle of the room.
  const centroid = room.floorPolygon.reduce<PointXZ>((c, p) => [c[0] + p[0] / room.floorPolygon.length, c[1] + p[1] / room.floorPolygon.length], [0, 0]);
  const toMiddle: PointXZ = [centroid[0] - spotXZ[0], centroid[1] - spotXZ[1]];
  const faceMiddle = (!snaps && (wallBacked || piece.category === "chair")) && Math.hypot(...toMiddle) > 0.3;
  const wallFacing = Math.atan2(near.edge.n[0], near.edge.n[1]);
  // square to the walls: the quarter turn from the wall's facing closest to the middle
  const auto = faceMiddle
    ? wrap(wallFacing + (Math.PI / 2) * Math.round(wrap(Math.atan2(toMiddle[0], toMiddle[1]) - wallFacing) / (Math.PI / 2)))
    : wrap(wallFacing);
  const base = chosen ?? auto;
  const solid = !NO_FOOTPRINT.has(piece.category);

  const gap = plan.constraints.clearance / 2;
  const obstacles = solid
    ? plan.items
        .filter((i) => i.id !== opts.ignoreItemId && i.roomId === room.id && i.dimensions && !NO_FOOTPRINT.has(i.category))
        .map((i) => footprint(i, gap)!)
    : [];

  const probe = (x: number, z: number, rotationY: number, withObstacles = true) => {
    const item = { position: [x, 0, z] as Vector3Meters, rotationY, dimensions: piece.dimensions };
    if (!footprint(item)!.every((p) => inside(p, room.floorPolygon))) return false;
    if (!withObstacles || !solid) return true;
    const fp = footprint(item, gap)!;
    return !obstacles.some((o) => overlaps(fp, o));
  };

  // facings to try, cheapest first: the natural one, then a quarter turn each way, then backwards
  const turns = [
    { r: base, penalty: 0, depth: d },
    { r: wrap(base + Math.PI / 2), penalty: wallBacked ? 0.6 : 0.15, depth: w },
    { r: wrap(base - Math.PI / 2), penalty: wallBacked ? 0.6 : 0.15, depth: w },
    { r: wrap(base + Math.PI), penalty: wallBacked ? 1.5 : 0.3, depth: d },
  ];

  const step = opts.stepM ?? 0.05;
  const maxShift = opts.maxShiftM ?? 1.2;
  const { t, n } = near.edge;

  type Cand = { x: number; z: number; r: number; score: number; snapped: boolean };
  const candidates = (radius: number, stride: number, from: "anchor" | "spot") => {
    const out: Cand[] = [];
    const k = Math.ceil(radius / stride);
    for (const turn of turns) {
      // a wall piece's anchor is flush against the wall behind it
      const snapped = snaps && from === "anchor" && turn.penalty < 1;
      const anchor: PointXZ = snapped
        ? [near.foot[0] + n[0] * (turn.depth / 2 + WALL_GAP), near.foot[1] + n[1] * (turn.depth / 2 + WALL_GAP)]
        : spotXZ;
      for (let i = -k; i <= k; i++) {
        for (let j = -k; j <= k; j++) {
          const a = i * stride;
          const b = j * stride;
          if (Math.hypot(a, b) > radius + 1e-9) continue;
          // slide along the wall before pulling away from it
          const shift = snapped ? Math.abs(a) + 3 * Math.abs(b) + (b < 0 ? 10 : 0) : Math.hypot(a, b);
          out.push({ x: anchor[0] + t[0] * a + n[0] * b, z: anchor[1] + t[1] * a + n[1] * b, r: turn.r, score: shift + turn.penalty, snapped });
        }
      }
    }
    return out.sort((p, q) => p.score - q.score);
  };

  const done = (c: Cand): Placement => ({
    roomId: room.id,
    position: [round(c.x), 0, round(c.z)],
    rotationY: c.r,
    distanceM: round(Math.hypot(c.x - spotXZ[0], c.z - spotXZ[1]), 2),
    againstWallId: c.snapped ? near.edge.wallId : null,
  });

  for (const c of candidates(maxShift, step, "anchor")) if (probe(c.x, c.z, c.r)) return { ok: true, placement: done(c) };

  if (opts.fallback === false) return { ok: false, reason: "no_room_nearby", message: "No room for it there.", nearest: null };

  // nothing near the spot: is it simply bigger than the room, or is the room just full there?
  const xs = room.floorPolygon.map((p) => p[0]);
  const zs = room.floorPolygon.map((p) => p[1]);
  const span = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  const wide = candidates(span, 0.1, "spot").map((c) => ({ ...c, score: Math.hypot(c.x - spotXZ[0], c.z - spotXZ[1]), snapped: false }));
  wide.sort((p, q) => p.score - q.score);
  const anywhere = wide.find((c) => probe(c.x, c.z, c.r));
  if (anywhere) {
    const p = done(anywhere);
    return { ok: false, reason: "no_room_nearby", message: `No room for it there. The closest spot it fits is ${p.distanceM} m away.`, nearest: p };
  }
  if (!wide.some((c) => probe(c.x, c.z, c.r, false)))
    return { ok: false, reason: "too_big", message: `At ${Math.round(w * 100)} x ${Math.round(d * 100)} cm it's too big for this room.`, nearest: null };
  return { ok: false, reason: "no_room_nearby", message: "The room's too full for it anywhere. Move or remove something first.", nearest: null };
}
