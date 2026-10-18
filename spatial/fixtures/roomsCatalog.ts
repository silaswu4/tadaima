import publishedScan from "../../public/demo/scanned-living-room/scene.json";
import publishedScanManifest from "../../public/demo/scanned-living-room/manifest.json";
import type { WalkOptions } from "../room/walk-api";
import type { FurnitureCategory, PlacedItem, PointXZ, RoomPlan } from "../../backend/contracts";
import { demoPlan } from "../../backend/fixtures/demo-room";
import { assetUrlFor } from "../../backend/shopping/assets";
import nativeScan from "../../reconstruction/fixtures/native-furniture.synthetic.json";
import photoReference from "../../reconstruction/fixtures/photo-reference.request.json";
import { parseRoomImport } from "../room/import-room";
import { DEMO_PLAN_R2 } from "./demoRoom";
import {
  WALL_FACE, adaptLegacyPlan, buy, libraryPiece, makeGalleryRooms, own, plan, rectShell, walls, workspaceLivingRoom,
  type Size,
} from "./galleryRooms";

/*
 * Every room the /rooms carousel shows. Each entry is a plain RoomPlan in the
 * frame described at the top of galleryRooms.ts, so the walk engine, the
 * shopping HUD and any later editor read the same data.
 *
 * Every piece has real-world dimensions in meters and a category. Catalog
 * pieces (origin "proposed_purchase") point at backend/fixtures/real-catalog.json
 * by productId and carry its listed size, and the plan's `products` holds those
 * entries so they can be priced. Pieces with no library model have assetUrl null
 * and are drawn by room/gallery-parts.ts from their id.
 *
 * validateRoom() checks bounds, overlaps, sizes, door clearance and that a
 * person (0.8 m wide) can walk from the door to every floor piece.
 */

export type CarouselRoom = {
  id: string; slug: string; label: string; source: "tadaima-original" | "tadaima-demo" | "tadaima-scan"; plan: RoomPlan;
  description?: string; sourceDescription?: string; reconstruction?: WalkOptions["reconstruction"];
};

export const PUBLISHED_SCAN_ID = "scanned-living-room";
const SCAN_DESCRIPTION = "iPhone scan · measured layout, photo-informed furniture and baked lighting";
let publishedReconstruction: Promise<NonNullable<WalkOptions["reconstruction"]>> | undefined;

/** One shared download for gallery and room entry. The original private scan stays separate. */
export async function hydrateCatalogRoom(room: CarouselRoom): Promise<CarouselRoom> {
  if (room.id !== PUBLISHED_SCAN_ID) return room;
  publishedReconstruction ??= (async () => {
    const [{ validateLocalTexturedGlb }, { validateRoomModelBinding }] = await Promise.all([
      import("../room/textured-model"), import("../rooms/registry"),
    ]);
    const response = await fetch("/demo/scanned-living-room/scene.glb", { credentials: "same-origin" });
    if (!response.ok) throw new Error("The shared scanned room could not download. Try again.");
    const texturedModel = await response.arrayBuffer();
    if (texturedModel.byteLength !== publishedScanManifest.modelBytes) throw new Error("The shared scanned room download is incomplete. Try again.");
    const plan = parseRoomImport(JSON.stringify(publishedScan));
    const binding = { jobId: publishedScan.jobId, inputSha256: publishedScanManifest.sourceSha256 };
    validateRoomModelBinding(validateLocalTexturedGlb(texturedModel), plan, binding);
    return { plan, texturedModel, binding };
  })().catch((cause) => { publishedReconstruction = undefined; throw cause; });
  return { ...room, reconstruction: await publishedReconstruction };
}

const withLabel = (p: RoomPlan, label: string) => {
  p.geometry.rooms[0].label = label;
  return p;
};

// ---------- originals already in the repo ----------

/** backend/fixtures/demo-room.ts: the shopping demo, a 5 x 4.2 m living room with a desk. */
function studioLivingRoom(): RoomPlan {
  return adaptLegacyPlan(demoPlan, {
    moves: {
      // sofa back and the two wall pieces sat a few centimeters inside the wall
      item_sofa: { at: [2.5, 4.2 - WALL_FACE - 0.95 / 2] },
      item_desk: { at: [1.0, WALL_FACE + 0.6 / 2] },
      item_shelf: { at: [5 - WALL_FACE - 0.899 / 2, WALL_FACE + 0.371 / 2] },
    },
  });
}

/** spatial/fixtures/demoRoom.ts, latest revision (2): the constrained 5.2 x 4.4 m living room. */
function familyRoom(): RoomPlan {
  return adaptLegacyPlan(DEMO_PLAN_R2, {
    nativeFrame: true,
    moves: {
      item_cabinet: { at: [5.2 - WALL_FACE - 0.26, 2.1] },
      // the lamp sat in a pocket behind the sofa and lounge chair; it moves by the door
      item_floor_lamp: { at: [0.3, 3.95] },
    },
  });
}

type ScanObject = { id: string; category: string; dimensions: number[]; transform: number[]; confidence: string };

/**
 * reconstruction/fixtures: the synthetic 4.2 x 3.5 m room. Shell, openings and
 * photo finishes come from photo-reference.request.json through the same local
 * importer the /room workspace uses. The sofa and table are the two objects in
 * native-furniture.synthetic.json (the same synthetic room), converted the way
 * reconstruction/roomplan/objects.py does, with two notes below.
 */
function scannedStudio(): RoomPlan {
  const p = parseRoomImport(JSON.stringify(photoReference));
  const roomId = p.geometry.rooms[0].id;
  const evidenceId = "ev_synthetic_scan_objects";
  p.evidence.push({
    id: evidenceId, sourceUrl: null, privateAssetId: null, observedAt: (nativeScan as { capturedAt: string }).capturedAt,
    claim: "Synthetic RoomPlan protocol objects (no device). Oriented bounding boxes, not furniture meshes or measured pieces.",
    dimensionStatus: "inferred", confirmedByUserAt: null,
  });
  const categories: Record<string, FurnitureCategory> = { sofa: "sofa", table: "table", chair: "chair", bed: "bed", storage: "storage" };
  p.items = (nativeScan.objects as ScanObject[]).map((o): PlacedItem => {
    const m = o.transform;
    const dimensions: [number, number, number] = [o.dimensions[0], o.dimensions[1], o.dimensions[2]];
    const category = categories[o.category] ?? "other";
    // A RoomPlan box has no front, so the sofa is turned to face into the room
    // (same footprint). The synthetic table floats 0.75 m up; it is set on the floor.
    const yaw = Math.atan2(-m[2], m[0]);
    return {
      id: o.id, roomId, label: `Scanned ${o.category}`, category, origin: "existing_owned", productId: null,
      assetUrl: category === "sofa" ? assetUrlFor("sofa", dimensions) : null,
      position: [m[12], 0, m[14]], rotationY: category === "sofa" ? yaw + Math.PI : yaw, dimensions,
      seats: category === "sofa" ? 3 : null, locked: true, evidenceIds: [evidenceId],
    };
  });
  return p;
}

// ---------- new rooms ----------

function kitchen(): RoomPlan {
  const r = "kitchen";
  const W = 4.2, D = 4.0;
  const at = walls(W, D);
  // back wall run, left to right from the inner wall face
  const run: Array<[id: string, label: string, category: FurnitureCategory, size: Size]> = [
    ["kitchen-fridge", "Refrigerator", "other", [0.76, 1.78, 0.74]],
    ["kitchen-base-1", "Base cabinet", "storage", [0.6, 0.9, 0.6]],
    ["kitchen-range", "Range", "other", [0.76, 0.93, 0.64]],
    ["kitchen-base-2", "Base cabinet", "storage", [0.6, 0.9, 0.6]],
    ["kitchen-sink", "Sink cabinet", "storage", [0.9, 1.15, 0.6]],
    ["kitchen-base-3", "Base cabinet", "storage", [0.46, 0.9, 0.6]],
  ];
  let x = WALL_FACE;
  const centers: Record<string, number> = {};
  const items: PlacedItem[] = run.map(([id, label, category, size]) => {
    centers[id] = x + size[0] / 2;
    x += size[0];
    return own(r, id, label, category, size, at.back(centers[id], size[2]));
  });
  const upper: Size = [0.6, 0.76, 0.35];
  items.push(
    own(r, "kitchen-upper-1", "Wall cabinet", "storage", upper, at.back(centers["kitchen-base-1"], upper[2]), { y: 1.4 }),
    own(r, "kitchen-hood", "Range hood", "other", [0.76, 0.6, 0.5], at.back(centers["kitchen-range"], 0.5), { y: 1.6 }),
    own(r, "kitchen-upper-2", "Wall cabinet", "storage", upper, at.back(centers["kitchen-base-2"], upper[2]), { y: 1.4 }),
    own(r, "kitchen-upper-3", "Wall cabinet", "storage", [0.46, 0.76, 0.35], at.back(centers["kitchen-base-3"], 0.35), { y: 1.4 }),
    own(r, "kitchen-upper-4", "Cabinet over fridge", "storage", [0.76, 0.38, 0.6], at.back(centers["kitchen-fridge"], 0.6), { y: 1.8 }),
    own(r, "kitchen-island", "Kitchen island", "storage", [1.8, 0.92, 0.9], { at: [2.1, 2.15], rot: 0 }),
    ...[1.5, 2.1, 2.7].map((sx, i) => own(r, `kitchen-stool-${i + 1}`, "Counter stool", "chair", [0.42, 0.75, 0.42], { at: [sx, 2.6 + 0.02 + 0.21], rot: Math.PI }, { seats: 1 })),
    ...[1.6, 2.6].map((px, i) => own(r, `kitchen-pendant-${i + 1}`, "Pendant light", "lamp", [0.3, 0.8, 0.3], { at: [px, 2.15], rot: 0 }, { y: 2.6 - 0.8 })),
  );
  return plan("tadaima-kitchen", rectShell(r, "Kitchen", W, D, [
    { id: "kitchen-window", side: "back", kind: "window", offset: 2.83, width: 0.8, height: 1.0, sillHeight: 1.05 },
    { id: "kitchen-window-side", side: "right", kind: "window", offset: 1.2, width: 1.2, height: 1.3, sillHeight: 0.9 },
    { id: "kitchen-door", side: "front", kind: "door", offset: 0.5, width: 0.9, height: 2.05 },
  ]), items, { minimumSeats: 3 });
}

function diningRoom(): RoomPlan {
  const r = "dining";
  const W = 4.8, D = 3.8;
  const at = walls(W, D);
  const table: Size = [1.8, 0.75, 0.9];
  const chair: Size = [0.45, 0.9, 0.52];
  const cx = 2.25, cz = 1.9;
  const backZ = cz - table[2] / 2 - 0.02 - chair[2] / 2;
  const frontZ = cz + table[2] / 2 + 0.02 + chair[2] / 2;
  const sideboard = at.right(1.9, 0.52);
  const items: PlacedItem[] = [
    own(r, "dining-table", "Dining table", "table", table, { at: [cx, cz], rot: 0 }),
    ...[-0.6, 0, 0.6].flatMap((dx, i) => [
      own(r, `dining-chair-${i + 1}`, "Dining chair", "chair", chair, { at: [cx + dx, backZ], rot: 0 }, { seats: 1 }),
      own(r, `dining-chair-${i + 4}`, "Dining chair", "chair", chair, { at: [cx + dx, frontZ], rot: Math.PI }, { seats: 1 }),
    ]),
    libraryPiece(r, "dining-sideboard", "Sideboard", "storage", "modern_wooden_cabinet", sideboard),
    libraryPiece(r, "dining-vase", "Ceramic vase", "decor", "ceramic_vase_01", { at: [sideboard.at[0], 2.6], rot: 0 }, { y: 0.68 }),
    own(r, "dining-pendant", "Pendant light", "lamp", [0.5, 0.7, 0.5], { at: [cx, cz], rot: 0 }, { y: 2.6 - 0.7 }),
    buy(r, "dining-lamp", "prod_ikea_tagarp-floor-uplighter-black-white-60464049", { at: [0.3, 0.3], rot: 0 }),
    buy(r, "dining-bookcase", "prod_ikea_gersby-bookcase-white-70261131", at.left(3.2, 0.241)),
  ];
  return plan("tadaima-dining", rectShell(r, "Dining room", W, D, [
    { id: "dining-window", side: "back", kind: "window", offset: 1.4, width: 2.0, height: 1.4, sillHeight: 0.8 },
    { id: "dining-door", side: "left", kind: "door", offset: 1.2, width: 0.9, height: 2.05 },
  ]), items, { minimumSeats: 6 });
}

function kidsRoom(): RoomPlan {
  const r = "kids";
  const W = 4.2, D = 3.8;
  const at = walls(W, D);
  const bed: Size = [1.04, 0.9, 2.0];
  const table: Size = [0.8, 0.5, 0.6];
  const kidChair: Size = [0.3, 0.55, 0.3];
  const tx = 2.1, tz = 1.75;
  const items: PlacedItem[] = [
    own(r, "kids-bed", "Twin bed", "bed", bed, { at: [WALL_FACE + bed[0] / 2, WALL_FACE + bed[2] / 2], rot: 0 }),
    own(r, "kids-nightstand", "Nightstand", "storage", [0.4, 0.5, 0.35], at.back(WALL_FACE + bed[0] + 0.05 + 0.2, 0.35)),
    own(r, "kids-wardrobe", "Wardrobe", "storage", [0.8, 1.8, 0.55], at.back(3.55, 0.55)),
    own(r, "kids-cubes", "Cube storage", "storage", [1.47, 0.77, 0.39], at.right(WALL_FACE + 0.55 + 0.02 + 1.47 / 2, 0.39)),
    own(r, "kids-play-table", "Play table", "table", table, { at: [tx, tz], rot: 0 }),
    ...[-0.2, 0.2].map((dx, i) =>
      own(r, `kids-chair-${i + 1}`, "Kids chair", "chair", kidChair, { at: [tx + dx, tz + table[2] / 2 + 0.02 + kidChair[2] / 2], rot: Math.PI }, { seats: 1 })),
    own(r, "kids-bean-bag", "Bean bag", "chair", [0.75, 0.6, 0.75], { at: [W - WALL_FACE - 0.4, D - WALL_FACE - 0.55], rot: 0 }, { seats: 1 }),
    own(r, "kids-toy-shelf", "Toy shelf", "storage", [1.0, 0.6, 0.3], at.back(2.15, 0.3)),
    buy(r, "kids-rug", "prod_ikea_vaendplats-rug-low-pile-white-black-dotted-30600", { at: [tx, tz], rot: Math.PI / 2 }),
  ];
  return plan("tadaima-kids", rectShell(r, "Kids' room", W, D, [
    { id: "kids-window", side: "back", kind: "window", offset: 1.4, width: 1.2, height: 1.3, sillHeight: 0.9 },
    { id: "kids-door", side: "front", kind: "door", offset: 2.5, width: 0.9, height: 2.05 },
  ]), items, { minimumSeats: 2 });
}

// ---------- the carousel ----------

export function getTadaimaRooms(): CarouselRoom[] {
  const gallery = Object.fromEntries(makeGalleryRooms().map((g) => [g.id, g.plan]));
  const rooms: Array<Omit<CarouselRoom, "plan"> & { plan: RoomPlan }> = [
    { id: PUBLISHED_SCAN_ID, slug: PUBLISHED_SCAN_ID, label: "Scanned living room", source: "tadaima-scan",
      plan: parseRoomImport(JSON.stringify(publishedScan)), description: SCAN_DESCRIPTION, sourceDescription: SCAN_DESCRIPTION },
    // spatial/room/workspace-fixture.ts, also the gallery's living room
    { id: "furniture-workspace-demo", slug: "living-room", label: "Living room", source: "tadaima-original", plan: workspaceLivingRoom() },
    { id: "proj_demo", slug: "studio-living-room", label: "Studio living room", source: "tadaima-original", plan: studioLivingRoom() },
    { id: "project_fixture_living", slug: "family-room", label: "Family room", source: "tadaima-original", plan: familyRoom() },
    { id: "photo-finish-reference", slug: "scanned-studio", label: "Scanned studio", source: "tadaima-original", plan: scannedStudio() },
    { id: "gallery-bedroom", slug: "bedroom", label: "Bedroom", source: "tadaima-demo", plan: gallery.bedroom },
    { id: "gallery-study", slug: "study", label: "Study", source: "tadaima-demo", plan: gallery.study },
    { id: "tadaima-kitchen", slug: "kitchen", label: "Kitchen", source: "tadaima-demo", plan: kitchen() },
    { id: "tadaima-dining", slug: "dining-room", label: "Dining room", source: "tadaima-demo", plan: diningRoom() },
    { id: "tadaima-kids", slug: "kids-room", label: "Kids' room", source: "tadaima-demo", plan: kidsRoom() },
  ];
  // Keep the published capture's measured shell, furniture locks and evidence intact.
  return rooms.map((room) => room.source === "tadaima-scan" ? room : ({ ...room, plan: asYours(withLabel(room.plan, room.label)) }));
}

/**
 * A demo room is someone's room: everything already in it is theirs, so the
 * basket starts empty and only holds what the shopper adds, and they can move
 * any of it. (The fixtures came from planner tests where those pieces were
 * suggested purchases or locked.)
 */
const HAND_CLEARANCE = 0.03;
/** Any room the shopper arranges by hand (demo or scan): pieces may sit 3 cm apart. */
export const withHandClearance = (plan: RoomPlan): RoomPlan =>
  plan.constraints.clearance <= HAND_CLEARANCE ? plan : { ...plan, constraints: { ...plan.constraints, clearance: HAND_CLEARANCE } };
function asYours(plan: RoomPlan): RoomPlan {
  // and nothing starts locked: locks were for keeping the AI planner off pieces in tests
  // Pieces may sit right next to each other; 30 cm of walking room between everything was a planner heuristic.
  return {
    ...plan,
    items: plan.items.map((item) => ({ ...item, origin: "existing_owned" as const, locked: false })),
    constraints: { ...plan.constraints, clearance: Math.min(plan.constraints.clearance, HAND_CLEARANCE) },
  };
}

// ---------- validation ----------

const EPS = 0.005;
/** Half the width of a clear walking path. */
const BODY_RADIUS = 0.4;
/** How far from a piece a person may stand and still use it. */
const REACH = 0.5;
/** Clear swing zone in front of a door. */
const DOOR_DEPTH = 0.8;
/** Pieces whose bottom is above this do not block walking. */
const HEAD_HEIGHT = 1.95;
/** Thinner than this lies flat on the floor (rugs) and does not block or overlap. */
const FLAT = 0.03;
const GRID = 0.05;

type Box = { id: string; label: string; cx: number; cz: number; hw: number; hd: number; cos: number; sin: number; y0: number; y1: number };

function toBox(item: PlacedItem): Box | null {
  if (!item.dimensions) return null;
  const [w, h, d] = item.dimensions;
  return {
    id: item.id, label: item.label, cx: item.position[0], cz: item.position[2], hw: w / 2, hd: d / 2,
    cos: Math.cos(item.rotationY), sin: Math.sin(item.rotationY), y0: item.position[1], y1: item.position[1] + h,
  };
}

/** World footprint corners. Local x runs along (cos, -sin), local z along (sin, cos), matching three.js rotation.y. */
function corners(b: Box): PointXZ[] {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
    const lx = sx * b.hw, lz = sz * b.hd;
    return [b.cx + lx * b.cos + lz * b.sin, b.cz - lx * b.sin + lz * b.cos] as PointXZ;
  });
}

function axes(b: Box): PointXZ[] {
  return [[b.cos, -b.sin], [b.sin, b.cos]];
}

/** Separating axis test on the two footprints, shrunk by EPS so touching pieces pass. */
function footprintsOverlap(a: Box, b: Box) {
  const ca = corners(a), cb = corners(b);
  for (const [ax, az] of [...axes(a), ...axes(b)]) {
    const pa = ca.map(([x, z]) => x * ax + z * az), pb = cb.map(([x, z]) => x * ax + z * az);
    if (Math.min(...pa) + EPS >= Math.max(...pb) || Math.min(...pb) + EPS >= Math.max(...pa)) return false;
  }
  return true;
}

/** Distance from a point to a footprint (0 inside). */
function distanceToBox(b: Box, x: number, z: number) {
  const dx = x - b.cx, dz = z - b.cz;
  const lx = dx * b.cos - dz * b.sin, lz = dx * b.sin + dz * b.cos;
  const ox = Math.max(0, Math.abs(lx) - b.hw), oz = Math.max(0, Math.abs(lz) - b.hd);
  return Math.hypot(ox, oz);
}

function inPolygon(poly: readonly PointXZ[], x: number, z: number) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToSegment(a: PointXZ, b: PointXZ, x: number, z: number) {
  const vx = b[0] - a[0], vz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (z - a[1]) * vz) / (vx * vx + vz * vz || 1)));
  return Math.hypot(x - a[0] - t * vx, z - a[1] - t * vz);
}

function distanceToEdges(poly: readonly PointXZ[], x: number, z: number) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, distanceToSegment(poly[i], poly[(i + 1) % poly.length], x, z));
  return best;
}

/**
 * Problems that would make a room wrong to walk through or edit: missing or
 * impossible sizes, pieces through walls, floor or ceiling, overlapping pieces
 * (rugs excepted, stacking allowed), blocked doors, and floor pieces a person
 * can't reach on a 0.8 m wide path from a door. Returns [] when the room is fine.
 */
export function validateRoom(roomPlan: RoomPlan): string[] {
  const problems: string[] = [];
  const geometry = roomPlan.geometry;
  const items = roomPlan.items.filter((i) => !i.stored);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) problems.push(`${item.id}: duplicate id`);
    seen.add(item.id);
    if (!item.dimensions) problems.push(`${item.id}: missing dimensions`);
    else if (item.dimensions.some((v) => !(v > 0) || v > 10)) problems.push(`${item.id}: impossible dimensions ${item.dimensions.join(" x ")}`);
    if (![...item.position, item.rotationY].every(Number.isFinite)) problems.push(`${item.id}: position or rotation is not a number`);
    if (item.productId) {
      const product = roomPlan.products.find((p) => p.id === item.productId);
      if (!product) problems.push(`${item.id}: product ${item.productId} is not in the plan`);
      else if (product.dimensions && item.dimensions && product.dimensions.some((v, k) => Math.abs(v - item.dimensions![k]) > 1e-6))
        problems.push(`${item.id}: dimensions differ from its product`);
    }
  }

  const byRoom = new Map(geometry.rooms.map((r) => [r.id, r]));
  const boxes: Array<{ box: Box; item: PlacedItem }> = [];
  for (const item of items) {
    const room = byRoom.get(item.roomId);
    const box = toBox(item);
    if (!room) problems.push(`${item.id}: unknown room ${item.roomId}`);
    if (!room || !box) continue;
    boxes.push({ box, item });
    const face = Math.max(0, ...geometry.walls.map((w) => w.thickness / 2)) - EPS;
    for (const [x, z] of corners(box)) {
      if (!inPolygon(room.floorPolygon, x, z) || distanceToEdges(room.floorPolygon, x, z) < face) {
        problems.push(`${item.id}: outside the room or into a wall at (${x.toFixed(2)}, ${z.toFixed(2)})`);
        break;
      }
    }
    if (box.y0 < -EPS) problems.push(`${item.id}: below the floor`);
    if (box.y1 > room.height + EPS) problems.push(`${item.id}: through the ceiling (top ${box.y1.toFixed(2)} m, ceiling ${room.height} m)`);
  }

  const solid = boxes.filter(({ item }) => item.dimensions![1] > FLAT);
  for (let i = 0; i < solid.length; i++)
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i].box, b = solid[j].box;
      if (Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) <= EPS) continue;
      if (footprintsOverlap(a, b)) problems.push(`${a.id} overlaps ${b.id}`);
    }

  // floor obstacles for walking
  const blocking = solid.filter(({ box }) => box.y0 < HEAD_HEIGHT).map(({ box }) => box);
  const wallById = new Map(geometry.walls.map((w) => [w.id, w]));
  const doorZones: Box[] = [];
  const starts: PointXZ[] = [];
  for (const o of geometry.openings) {
    if (o.kind !== "door") continue;
    const wall = wallById.get(o.wallId);
    if (!wall) continue;
    const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
    const ux = (wall.end[0] - wall.start[0]) / len, uz = (wall.end[1] - wall.start[1]) / len;
    const mid = o.offset + o.width / 2;
    const px = wall.start[0] + ux * mid, pz = wall.start[1] + uz * mid;
    // inward normal: whichever side of the wall is inside a room
    let nx = -uz, nz = ux;
    if (!geometry.rooms.some((r) => inPolygon(r.floorPolygon, px + nx * 0.3, pz + nz * 0.3))) [nx, nz] = [uz, -ux];
    const depthC = wall.thickness / 2 + DOOR_DEPTH / 2;
    const angle = Math.atan2(nx, nz);
    doorZones.push({ id: o.id, label: "door", cx: px + nx * depthC, cz: pz + nz * depthC, hw: o.width / 2, hd: DOOR_DEPTH / 2, cos: Math.cos(angle), sin: Math.sin(angle), y0: 0, y1: o.height });
    starts.push([px + nx * (wall.thickness / 2 + BODY_RADIUS + 0.05), pz + nz * (wall.thickness / 2 + BODY_RADIUS + 0.05)]);
  }
  for (const zone of doorZones)
    for (const b of blocking) if (footprintsOverlap(zone, b)) problems.push(`${b.id} blocks door ${zone.id}`);

  if (!starts.length) {
    problems.push("no door to walk in from");
    return problems;
  }

  // walkable grid: cell centers at least BODY_RADIUS from walls and floor obstacles
  const poly = geometry.rooms.flatMap((r) => r.floorPolygon);
  const minX = Math.min(...poly.map((p) => p[0])), maxX = Math.max(...poly.map((p) => p[0]));
  const minZ = Math.min(...poly.map((p) => p[1])), maxZ = Math.max(...poly.map((p) => p[1]));
  const nx = Math.ceil((maxX - minX) / GRID), nz = Math.ceil((maxZ - minZ) / GRID);
  const wallFace = Math.max(0, ...geometry.walls.map((w) => w.thickness / 2));
  const free = new Uint8Array(nx * nz);
  const cx = (i: number) => minX + (i + 0.5) * GRID, cz = (j: number) => minZ + (j + 0.5) * GRID;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const x = cx(i), z = cz(j);
      const room = geometry.rooms.find((r) => inPolygon(r.floorPolygon, x, z));
      if (!room || distanceToEdges(room.floorPolygon, x, z) < wallFace + BODY_RADIUS) continue;
      if (blocking.some((b) => distanceToBox(b, x, z) < BODY_RADIUS)) continue;
      free[j * nx + i] = 1;
    }
  const reached = new Uint8Array(nx * nz);
  const queue: number[] = [];
  for (const [sx, sz] of starts) {
    const i = Math.floor((sx - minX) / GRID), j = Math.floor((sz - minZ) / GRID);
    // the nearest free cell to the doorway
    let best = -1, bestD = 0.3;
    for (let dj = -6; dj <= 6; dj++)
      for (let di = -6; di <= 6; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz || !free[jj * nx + ii]) continue;
        const d = Math.hypot(cx(ii) - sx, cz(jj) - sz);
        if (d < bestD) [best, bestD] = [jj * nx + ii, d];
      }
    if (best < 0) problems.push("a doorway has no clear 0.8 m space inside it");
    else if (!reached[best]) {
      reached[best] = 1;
      queue.push(best);
    }
  }
  while (queue.length) {
    const k = queue.pop()!;
    const i = k % nx, j = (k - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
      const n = jj * nx + ii;
      if (free[n] && !reached[n]) {
        reached[n] = 1;
        queue.push(n);
      }
    }
  }
  const reachedCells: PointXZ[] = [];
  for (let k = 0; k < reached.length; k++) if (reached[k]) reachedCells.push([cx(k % nx), cz(Math.floor(k / nx))]);
  for (const { box, item } of boxes) {
    // floor pieces must be reachable; stacked and wall-hung pieces are used from their base
    if (box.y0 > EPS) continue;
    const near = reachedCells.some(([x, z]) => distanceToBox(box, x, z) <= BODY_RADIUS + REACH);
    if (!near) problems.push(`${item.id}: no 0.8 m wide path reaches it from a door`);
  }
  return problems;
}
