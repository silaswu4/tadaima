import type { FurnitureCategory, PlacedItem, ProductCandidate, RoomGeometry, RoomPlan, Vector3Meters } from "../../backend/contracts";
import { realCatalog } from "../../backend/fixtures/demo-room";
import realCatalogFile from "../../backend/fixtures/real-catalog.json";
import { LIBRARY, assetUrlFor } from "../../backend/shopping/assets";
import { makeWorkspaceDemo } from "../room/workspace-fixture";

/*
 * Presentation rooms for the landing gallery until real scans are available,
 * plus the small kit the room catalog (roomsCatalog.ts) builds rooms with.
 *
 * Frame: meters, +Y up, origin at the back-left floor corner, x right, z toward
 * the viewer. Item `position` is the bottom center of its footprint. Item
 * `dimensions` are [width, height, depth] in the library frame of
 * backend/shopping/assets.ts: width along local x, front facing local +z,
 * before `rotationY`. rotationY 0 faces +z, PI / 2 faces +x, -PI / 2 faces -x.
 *
 * Walls run along the floor polygon edges and are 0.12 m thick, so their inner
 * face sits 0.06 m inside the polygon. "Flush to a wall" means touching that face.
 *
 * Pieces with no model file are drawn procedurally from their id (see
 * room/gallery-parts.ts for the id convention).
 */

export type Size = readonly [w: number, h: number, d: number];
export const WALL_THICKNESS = 0.12;
export const WALL_FACE = WALL_THICKNESS / 2;

type Side = "back" | "right" | "front" | "left";
type OpeningSpec = { id: string; side: Side; kind: "door" | "window"; offset: number; width: number; height: number; sillHeight?: number };

/** Rectangular room shell. Wall ids are `${id}-back|right|front|left`; openings measure `offset` from each wall's start. */
export function rectShell(id: string, label: string, w: number, d: number, openings: OpeningSpec[], height = 2.6, evidenceIds: string[] = []): RoomGeometry {
  const wall = (side: Side, start: [number, number], end: [number, number]) => ({ id: `${id}-${side}`, start, end, height, thickness: WALL_THICKNESS, evidenceIds });
  return {
    units: "m", coordinateSystem: "right-handed-y-up",
    rooms: [{ id, label, height, floorPolygon: [[0, 0], [w, 0], [w, d], [0, d]], evidenceIds }],
    walls: [wall("back", [0, 0], [w, 0]), wall("right", [w, 0], [w, d]), wall("front", [w, d], [0, d]), wall("left", [0, d], [0, 0])],
    openings: openings.map((o) => ({ id: o.id, wallId: `${id}-${o.side}`, kind: o.kind, offset: o.offset, width: o.width, height: o.height, sillHeight: o.sillHeight ?? 0, evidenceIds })),
  };
}

export type Pose = { at: [x: number, z: number]; rot: number };

/** Poses that put a piece's back flush against a wall of a w by d rectangular room. `along` is the piece's center along that wall's axis (x for back/front, z for left/right). */
export function walls(w: number, d: number) {
  return {
    back: (along: number, depth: number, gap = 0): Pose => ({ at: [along, WALL_FACE + gap + depth / 2], rot: 0 }),
    front: (along: number, depth: number, gap = 0): Pose => ({ at: [along, d - WALL_FACE - gap - depth / 2], rot: Math.PI }),
    left: (along: number, depth: number, gap = 0): Pose => ({ at: [WALL_FACE + gap + depth / 2, along], rot: Math.PI / 2 }),
    right: (along: number, depth: number, gap = 0): Pose => ({ at: [w - WALL_FACE - gap - depth / 2, along], rot: -Math.PI / 2 }),
  };
}

type PieceOptions = { y?: number; seats?: number | null; locked?: boolean; asset?: "library" | string | null; origin?: PlacedItem["origin"] };

/** A piece the household already owns. `asset: "library"` picks the closest library model, a file name picks that model, null draws it procedurally. */
export function own(roomId: string, id: string, label: string, category: FurnitureCategory, size: Size, pose: Pose, options: PieceOptions = {}): PlacedItem {
  const dimensions: Vector3Meters = [size[0], size[1], size[2]];
  const asset = options.asset ?? null;
  return {
    id, roomId, label, category, origin: options.origin ?? "existing_owned", productId: null,
    assetUrl: asset === "library" ? assetUrlFor(category, dimensions) : asset ? `/models/${asset}.glb` : null,
    position: [pose.at[0], options.y ?? 0, pose.at[1]], rotationY: pose.rot, dimensions,
    seats: options.seats ?? null, locked: options.locked ?? false,
  };
}

/** Native size of a library model file, in the library frame. */
export function librarySize(file: string): Size {
  const url = `/models/${file}.glb`;
  for (const options of Object.values(LIBRARY)) for (const m of options) if (m.url === url) return m.size;
  throw new Error(`No library model ${file}`);
}

/** An owned piece drawn with a library model at that model's own size. */
export function libraryPiece(roomId: string, id: string, label: string, category: FurnitureCategory, file: string, pose: Pose, options: Omit<PieceOptions, "asset"> = {}) {
  return own(roomId, id, label, category, librarySize(file), pose, { ...options, asset: file });
}

export function catalogProduct(productId: string): ProductCandidate {
  const p = realCatalog.find((c) => c.id === productId);
  if (!p) throw new Error(`No catalog product ${productId}`);
  if (!p.dimensions) throw new Error(`Catalog product ${productId} has no dimensions`);
  return p;
}

/** A proposed purchase from the real IKEA / Target catalog, at its listed size and price. */
export function buy(roomId: string, id: string, productId: string, pose: Pose, options: { y?: number; label?: string } = {}): PlacedItem {
  const p = catalogProduct(productId);
  const procedural = p.category === "rug" || p.category === "lamp";
  return {
    id, roomId, label: options.label ?? p.label, category: p.category, origin: "proposed_purchase", productId,
    assetUrl: procedural ? null : assetUrlFor(p.category, p.dimensions),
    position: [pose.at[0], options.y ?? 0, pose.at[1]], rotationY: pose.rot, dimensions: p.dimensions,
    seats: p.seats, locked: false,
  };
}

/** Catalog entries the plan's items point at, so the shopping HUD can price them. */
export function productsFor(items: PlacedItem[]): ProductCandidate[] {
  const ids = [...new Set(items.map((i) => i.productId).filter((id): id is string => !!id))];
  return ids.map(catalogProduct);
}

export function plan(projectId: string, geometry: RoomGeometry, items: PlacedItem[], constraints: Partial<RoomPlan["constraints"]> = {}): RoomPlan {
  const products = productsFor(items);
  const evidenceIds = new Set(products.flatMap((p) => p.evidenceIds));
  const evidence = (realCatalogEvidence() ?? []).filter((e) => evidenceIds.has(e.id));
  return {
    schemaVersion: "0.2", projectId, revision: 1, geometry, evidence, items, products,
    constraints: { budget: null, minimumSeats: null, clearance: 0.3, ...constraints },
  };
}

function realCatalogEvidence(): RoomPlan["evidence"] {
  return (realCatalogFile as unknown as { evidence?: RoomPlan["evidence"] }).evidence ?? [];
}

// ---------- the three gallery rooms ----------

function bedroom(): RoomPlan {
  const r = "bedroom";
  const W = 4.6, D = 4.2;
  const at = walls(W, D);
  const bed: Size = [1.6, 1.0, 2.13];
  const stand: Size = [0.5, 0.55, 0.4];
  const items = [
    own(r, "gallery-bed", "Queen bed", "bed", bed, at.back(2.3, bed[2])),
    own(r, "bedroom-nightstand-left", "Nightstand", "storage", stand, at.back(2.3 - bed[0] / 2 - 0.05 - stand[0] / 2, stand[2])),
    own(r, "bedroom-nightstand-right", "Nightstand", "storage", stand, at.back(2.3 + bed[0] / 2 + 0.05 + stand[0] / 2, stand[2])),
    libraryPiece(r, "bedroom-vase", "Ceramic vase", "decor", "ceramic_vase_01", at.back(3.45, stand[2]), { y: stand[1] }),
    buy(r, "bedroom-rug", "prod_target_a-94258305", { at: [2.3, 2.35], rot: Math.PI / 2 }),
    own(r, "bedroom-wardrobe", "Wardrobe", "storage", [1.0, 2.0, 0.6], at.right(1.2, 0.6)),
    own(r, "bedroom-dresser", "Dresser", "storage", [1.2, 0.8, 0.5], at.front(1.9, 0.5)),
    buy(r, "bedroom-chair", "prod_ikea_poaeng-armchair-birch-veneer-knisa-light-beige-s", { at: [WALL_FACE + 0.819 / 2 + 0.1, 3.34], rot: Math.PI / 2 }),
    buy(r, "bedroom-lamp", "prod_ikea_roedflik-floor-reading-lamp-gray-green-80563581", { at: [0.3, 2.65], rot: 0 }),
  ];
  return plan("gallery-bedroom", rectShell(r, "Bedroom", W, D, [
    { id: "bedroom-window", side: "left", kind: "window", offset: 1.2, width: 1.8, height: 1.4, sillHeight: 0.8 },
    { id: "bedroom-door", side: "front", kind: "door", offset: 0.5, width: 0.9, height: 2.05 },
  ]), items, { minimumSeats: 1 });
}

function study(): RoomPlan {
  const r = "study";
  const W = 4, D = 3.8;
  const at = walls(W, D);
  const desk: Size = [1.4, 0.75, 0.7];
  const shelf = catalogProduct("prod_ikea_hemnes-bookcase-white-stain-light-brown-60413502").dimensions!;
  const items = [
    own(r, "gallery-desk", "Writing desk", "desk", desk, at.back(2.15, desk[2])),
    own(r, "gallery-desk-chair", "Desk chair", "chair", [0.6, 0.95, 0.6], { at: [2.15, WALL_FACE + desk[2] + 0.05 + 0.3], rot: Math.PI }, { seats: 1 }),
    buy(r, "study-shelves-1", "prod_ikea_hemnes-bookcase-white-stain-light-brown-60413502", at.right(0.95, shelf[2])),
    buy(r, "study-shelves-2", "prod_ikea_hemnes-bookcase-white-stain-light-brown-60413502", at.right(0.95 + shelf[0] + 0.02, shelf[2])),
    buy(r, "study-chair", "prod_ikea_stockholm-2025-armchair-djurmo-gray-white-405947", { at: [0.85, 2.6], rot: Math.PI / 2 + 0.4 }),
    libraryPiece(r, "study-side", "Side table", "table", "side_table_01", { at: [WALL_FACE + 0.45 / 2 + 0.05, 3.45], rot: Math.PI / 2 }),
    buy(r, "study-lamp", "prod_ikea_simrishamn-floor-lamp-chrome-plated-opal-glass-5", { at: [0.3, 1.9], rot: 0 }),
    buy(r, "study-rug", "prod_ikea_lohals-rug-flatwoven-natural-30511288", { at: [1.3, 2.6], rot: Math.PI / 2 }),
  ];
  return plan("gallery-study", rectShell(r, "Study", W, D, [
    { id: "study-window", side: "back", kind: "window", offset: 1.4, width: 1.5, height: 1.3, sillHeight: 0.9 },
    { id: "study-door", side: "front", kind: "door", offset: 0.4, width: 0.9, height: 2.05 },
  ]), items, { minimumSeats: 2 });
}

// ---------- adapting older fixtures ----------

const FILE_CATEGORY: Record<string, { category: FurnitureCategory; seats: number | null }> = {
  sofa_02: { category: "sofa", seats: 3 }, mid_century_lounge_chair: { category: "chair", seats: 1 },
  modern_coffee_table_01: { category: "table", seats: null }, side_table_01: { category: "table", seats: null },
  modern_wooden_cabinet: { category: "storage", seats: null }, wooden_display_shelves_01: { category: "storage", seats: null },
  ceramic_vase_01: { category: "decor", seats: null },
};

const fileOf = (url: string | null) => url?.match(/\/models\/([^/]+)\.glb$/)?.[1] ?? null;

function libraryYaw(file: string) {
  const url = `/models/${file}.glb`;
  for (const options of Object.values(LIBRARY)) for (const m of options) if (m.url === url) return m.yaw;
  return 0;
}

export type LegacyFix = {
  /** The plan placed models in their native file frame (before backend/shopping/assets.ts yaw). */
  nativeFrame?: boolean;
  /** Sizes for procedural pieces that had none. */
  sizes?: Record<string, Size>;
  /** Small position or facing corrections so pieces sit inside the walls. */
  moves?: Record<string, { at?: [number, number]; rot?: number }>;
};

/**
 * Copies an older fixture into the shared library frame with every piece sized:
 * fills missing categories and dimensions (model size, product size, or `sizes`),
 * converts native-frame facings, and applies `moves`. The input is not changed.
 */
export function adaptLegacyPlan(source: RoomPlan, fix: LegacyFix = {}): RoomPlan {
  const out: RoomPlan = structuredClone(source);
  const swapped = new Set<string>();
  out.items = out.items.map((item) => {
    const file = fileOf(item.assetUrl);
    const known = file ? FILE_CATEGORY[file] : undefined;
    const next: PlacedItem = { ...item };
    if (next.category === "other" && known) next.category = known.category;
    if (next.seats === null && known?.seats) next.seats = known.seats;
    const yaw = file && fix.nativeFrame ? libraryYaw(file) : 0;
    const quarter = Math.abs(Math.abs(yaw) - Math.PI / 2) < 1e-6;
    if (!next.dimensions) {
      const product = next.productId ? out.products.find((p) => p.id === next.productId) : undefined;
      if (product?.dimensions) {
        next.dimensions = quarter ? [product.dimensions[2], product.dimensions[1], product.dimensions[0]] : product.dimensions;
        if (quarter) swapped.add(product.id);
      } else if (file) next.dimensions = [...librarySize(file)];
      else if (fix.sizes?.[next.id]) next.dimensions = [...fix.sizes[next.id]];
    } else if (quarter) next.dimensions = [next.dimensions[2], next.dimensions[1], next.dimensions[0]];
    if (yaw) next.rotationY = next.rotationY - yaw;
    const move = fix.moves?.[next.id];
    if (move?.at) next.position = [move.at[0], next.position[1], move.at[1]];
    if (move?.rot !== undefined) next.rotationY = move.rot;
    return next;
  });
  out.products = out.products.map((p) =>
    swapped.has(p.id) && p.dimensions ? { ...p, dimensions: [p.dimensions[2], p.dimensions[1], p.dimensions[0]] } : p,
  );
  return out;
}

/** The nine-piece workspace demo, sized and in the library frame. */
export function workspaceLivingRoom(): RoomPlan {
  const p = adaptLegacyPlan(makeWorkspaceDemo(), {
    nativeFrame: true,
    sizes: { "demo-rug": [3, 0.012, 2.1], "demo-lamp": [0.42, 1.58, 0.42] },
    moves: {
      sofa: { at: [3, 0.47] },
      shelves: { at: [6 - WALL_FACE - 1.078 / 2, WALL_FACE + 0.371 / 2] },
      "demo-lamp": { at: [0.4, 3.05] },
      cabinet: { at: [6 - WALL_FACE - 0.26, 2.05] },
    },
  });
  p.geometry.rooms[0].label = "Living room";
  return p;
}

export type GalleryRoom = { id: string; label: string; plan: RoomPlan };

export function makeGalleryRooms(): GalleryRoom[] {
  return [
    { id: "living-room", label: "Living room", plan: workspaceLivingRoom() },
    { id: "bedroom", label: "Bedroom", plan: bedroom() },
    { id: "study", label: "Study", plan: study() },
  ];
}
