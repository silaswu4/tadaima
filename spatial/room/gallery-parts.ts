import * as THREE from "three";
import type { FurnitureCategory, Vector3Meters } from "../../backend/contracts";
import { block, place, rod, surface } from "./parts";

/*
 * Procedural models for room pieces that have no model file.
 *
 * Every shape is built exactly to the item's dimensions [width, height, depth]
 * in meters: it sits on y = 0, is centered on its footprint, its width runs
 * along local x and its front faces +z (the same frame as backend/shopping/assets.ts).
 * Nothing pokes outside that box, so the drawn piece and the listed size agree.
 *
 * Id convention. The shape comes from the item id, split on "-" or "_" into
 * tokens. The longest key below whose tokens appear in a row in the id wins:
 *
 *   kitchen-base-1     -> base-cabinet      kitchen-upper-2   -> upper-cabinet
 *   kitchen-sink       -> sink-run          kitchen-range     -> range
 *   kitchen-hood       -> hood              kitchen-fridge    -> fridge
 *   kitchen-island     -> island            kitchen-stool-1   -> bar-stool
 *   dining-table       -> dining-table      dining-chair-3    -> dining-chair
 *   any-pendant        -> pendant           item_floor_lamp   -> lamp
 *   gallery-bed        -> bed               kids-bed          -> kids-bed
 *   bedroom-nightstand -> nightstand        bedroom-dresser   -> dresser
 *   bedroom-wardrobe   -> wardrobe          kids-cubes        -> cube-storage
 *   kids-toy-shelf     -> toy-shelf         kids-bean-bag     -> bean-bag
 *   kids-play-table    -> play-table        kids-chair-1      -> kids-chair
 *   item_desk          -> desk              gallery-desk-chair -> desk-chair
 *   item_rug           -> rug
 *
 * Generic words like "table", "chair", "sofa", "cabinet" and "shelves" are not
 * keys on purpose: pieces such as "item_coffee_table" have a library model and
 * must keep it. Engines that know the whole item can pass `hint`: an item with
 * an assetUrl always keeps its model, and an unmatched id falls back to a
 * shape for its category.
 */

export type GalleryShape =
  | "bed" | "kids-bed" | "nightstand" | "dresser" | "wardrobe"
  | "desk" | "desk-chair" | "dining-chair" | "kids-chair" | "bar-stool"
  | "dining-table" | "play-table" | "round-table"
  | "base-cabinet" | "upper-cabinet" | "sink-run" | "range" | "hood" | "fridge" | "island"
  | "cube-storage" | "toy-shelf" | "bean-bag" | "sofa-block"
  | "pendant" | "lamp" | "rug";

const KEYS: Array<[string, GalleryShape]> = [
  ["desk-chair", "desk-chair"], ["dining-chair", "dining-chair"], ["kids-chair", "kids-chair"],
  ["kids-bed", "kids-bed"], ["dining-table", "dining-table"], ["play-table", "play-table"],
  ["toy-shelf", "toy-shelf"], ["bean-bag", "bean-bag"], ["bar-stool", "bar-stool"],
  ["base-cabinet", "base-cabinet"], ["upper-cabinet", "upper-cabinet"],
  ["base", "base-cabinet"], ["upper", "upper-cabinet"], ["sink", "sink-run"], ["range", "range"],
  ["hood", "hood"], ["fridge", "fridge"], ["island", "island"], ["stool", "bar-stool"],
  ["pendant", "pendant"], ["lamp", "lamp"], ["rug", "rug"], ["bed", "bed"], ["desk", "desk"],
  ["nightstand", "nightstand"], ["dresser", "dresser"], ["wardrobe", "wardrobe"],
  ["cubes", "cube-storage"], ["cube", "cube-storage"],
].map(([k, s]) => [k, s] as [string, GalleryShape]).sort((a, b) => b[0].split("-").length - a[0].split("-").length);

/** The procedural shape an id asks for, or null when the piece should use its own model. */
export function galleryShapeFor(id: string): GalleryShape | null {
  const tokens = id.toLowerCase().split(/[-_\s]+/).filter(Boolean);
  for (const [key, shape] of KEYS) {
    const want = key.split("-");
    for (let i = 0; i + want.length <= tokens.length; i++) {
      if (want.every((t, j) => tokens[i + j] === t)) return shape;
    }
  }
  return null;
}

const CATEGORY_SHAPE: Partial<Record<FurnitureCategory, GalleryShape>> = {
  bed: "bed", desk: "desk", chair: "dining-chair", storage: "base-cabinet", rug: "rug", lamp: "lamp", sofa: "sofa-block",
};

type Size = [number, number, number];

/** Sizes used only when an item has no dimensions at all. */
const DEFAULT_SIZE: Record<GalleryShape, Size> = {
  bed: [1.6, 1, 2.13], "kids-bed": [1.04, 0.9, 2], nightstand: [0.5, 0.55, 0.4], dresser: [1.2, 0.8, 0.5],
  wardrobe: [1, 2, 0.6], desk: [1.2, 0.75, 0.6], "desk-chair": [0.6, 0.95, 0.6], "dining-chair": [0.45, 0.9, 0.52],
  "kids-chair": [0.3, 0.55, 0.3], "bar-stool": [0.42, 0.75, 0.42], "dining-table": [1.8, 0.75, 0.9],
  "play-table": [0.8, 0.5, 0.6], "round-table": [0.8, 0.45, 0.8], "base-cabinet": [0.6, 0.9, 0.6],
  "upper-cabinet": [0.6, 0.76, 0.35], "sink-run": [0.9, 1.15, 0.6], range: [0.76, 0.93, 0.64], hood: [0.76, 0.6, 0.5],
  fridge: [0.76, 1.78, 0.74], island: [1.8, 0.92, 0.9], "cube-storage": [1.47, 0.77, 0.39], "toy-shelf": [1, 0.6, 0.3],
  "bean-bag": [0.8, 0.6, 0.8], "sofa-block": [1.8, 0.8, 0.9], pendant: [0.3, 0.8, 0.3], lamp: [0.42, 1.58, 0.42], rug: [2, 0.01, 1.4],
};

// One warm palette for every shape. Terracotta is the single accent.
const C = {
  oak: "#b98d63", walnut: "#a77d55", birch: "#d8bf98", linen: "#f1ece3", shell: "#f6f2ea", paper: "#fbf8f2",
  oat: "#c9b49a", stone: "#e8e2d7", ink: "#2e2a25", steel: "#cfcac2", glass: "#3a3631", accent: "#c8775a",
};

const g = (...parts: THREE.Object3D[]) => {
  const out = new THREE.Group();
  out.add(...parts);
  return out;
};

const legs = (w: number, d: number, h: number, inset: number, r: number, m: THREE.Material) =>
  [-1, 1].flatMap((sx) => [-1, 1].map((sz) => place(rod(r, r * 0.85, h, m, 12), sx * (w / 2 - inset), 0, sz * (d / 2 - inset))));

function bed([w, h, d]: Size, kids = false) {
  const frame = surface(kids ? C.birch : C.oak, 0.7);
  const linen = surface(C.linen, 0.95);
  const blanket = surface(kids ? C.accent : C.oat, 1);
  const pillow = surface(C.paper, 1);
  const base = Math.min(0.32, h * 0.32);
  const mattress = Math.min(0.22, h * 0.24);
  const top = base + mattress;
  const pillowH = Math.min(0.12, h - top - 0.01);
  const parts: THREE.Object3D[] = [
    place(block(w, base, d - 0.08, frame, 0.02), 0, 0, 0.04),
    place(block(w, h, 0.08, frame, 0.02), 0, 0, -d / 2 + 0.04),
    place(block(w - 0.06, mattress, d - 0.16, linen, 0.06), 0, base, 0.04),
    place(block(w - 0.02, 0.05, d * 0.36, blanket, 0.02), 0, top - 0.02, d * 0.24),
  ];
  if (kids) parts.push(place(block(w * 0.6, pillowH, 0.32, pillow, 0.05), 0, top, -d / 2 + 0.3));
  else parts.push(
    place(block(w * 0.4, pillowH, 0.34, pillow, 0.05), -w * 0.23, top, -d / 2 + 0.3),
    place(block(w * 0.4, pillowH, 0.34, pillow, 0.05), w * 0.23, top, -d / 2 + 0.3),
  );
  return g(...parts);
}

function chest([w, h, d]: Size, drawers: number, wood = C.walnut) {
  const body = surface(wood, 0.7);
  const front = surface(C.shell, 0.85);
  const dark = surface(C.ink, 0.5, 0.2);
  const legH = Math.min(0.12, h * 0.15);
  const bodyH = h - legH;
  const gap = 0.012;
  const rowH = (bodyH - 0.04 - gap * (drawers + 1)) / drawers;
  const fronts = Array.from({ length: drawers }, (_, i) => {
    const y = legH + 0.02 + gap + i * (rowH + gap);
    return g(place(block(w - 0.05, rowH, 0.012, front, 0.004), 0, y, d / 2 - 0.018), place(block(Math.min(0.18, w * 0.3), 0.012, 0.012, dark, 0.004), 0, y + rowH / 2 - 0.006, d / 2 - 0.006));
  });
  return g(...legs(w, d - 0.024, legH, 0.05, 0.016, dark).map((l) => place(l, l.position.x, 0, l.position.z - 0.012)), place(block(w, bodyH, d - 0.024, body, 0.012), 0, legH, -0.012), ...fronts);
}

function wardrobe([w, h, d]: Size) {
  const body = surface(C.shell, 0.85);
  const wood = surface(C.oak, 0.7);
  const dark = surface(C.ink, 0.5, 0.2);
  const plinth = 0.08;
  const doorW = (w - 0.03) / 2;
  return g(
    place(block(w - 0.04, plinth, d - 0.06, wood, 0.005), 0, 0, -0.03),
    place(block(w, h - plinth, d - 0.032, body, 0.012), 0, plinth, -0.016),
    ...[-1, 1].map((s) => place(block(doorW, h - plinth - 0.03, 0.02, body, 0.006), s * (doorW / 2 + 0.005), plinth + 0.015, d / 2 - 0.022)),
    ...[-1, 1].map((s) => place(block(0.012, 0.3, 0.012, dark, 0.004), s * 0.04, h * 0.5, d / 2 - 0.006)),
  );
}

function desk([w, h, d]: Size) {
  const wood = surface(C.walnut, 0.65);
  const dark = surface(C.ink, 0.5, 0.2);
  return g(...legs(w, d, h - 0.04, 0.06, 0.022, dark), place(block(w, 0.04, d, wood, 0.01), 0, h - 0.04, 0));
}

function deskChair([w, h, d]: Size) {
  const seat = surface("#8a6e4e", 0.85);
  const dark = surface(C.ink, 0.5, 0.2);
  const seatY = Math.min(0.46, h * 0.5);
  return g(
    rod(Math.min(w, d) / 2 - 0.01, Math.min(w, d) / 2 - 0.01, 0.025, dark, 20),
    rod(0.025, 0.025, seatY, dark, 12),
    place(block(w, 0.07, d, seat, 0.03), 0, seatY, 0),
    place(block(w * 0.92, h - seatY - 0.07, 0.06, seat, 0.03), 0, seatY + 0.07, -d / 2 + 0.03),
  );
}

function sideChair([w, h, d]: Size, wood = C.oak, cushion = C.linen) {
  const frame = surface(wood, 0.7);
  const pad = surface(cushion, 0.95);
  const seatY = Math.min(0.46, h * 0.5);
  const back = place(block(w - 0.02, (h - seatY) * 0.55, 0.025, frame, 0.008), 0, h - (h - seatY) * 0.55, -d / 2 + 0.0125);
  const posts = [-1, 1].map((s) => place(rod(0.016, 0.016, h, frame, 10), s * (w / 2 - 0.02), 0, -d / 2 + 0.02));
  const front = [-1, 1].map((s) => place(rod(0.017, 0.015, seatY, frame, 10), s * (w / 2 - 0.02), 0, d / 2 - 0.03));
  return g(
    ...posts, ...front, back,
    place(block(w, 0.03, d - 0.02, frame, 0.008), 0, seatY - 0.03, 0.01),
    place(block(w - 0.04, 0.03, d - 0.08, pad, 0.012), 0, seatY, 0.03),
  );
}

function barStool([w, h, d]: Size) {
  const wood = surface(C.oak, 0.7);
  const dark = surface(C.ink, 0.5, 0.25);
  const r = Math.min(w, d) / 2;
  return g(
    rod(r * 0.8, r * 0.85, 0.02, dark, 24),
    rod(0.022, 0.022, h - 0.05, dark, 12),
    place(rod(r * 0.6, r * 0.6, 0.012, dark, 24), 0, h * 0.35, 0),
    place(rod(r, r * 0.92, 0.05, wood, 28), 0, h - 0.05, 0),
  );
}

function table([w, h, d]: Size, wood = C.oak) {
  const top = surface(wood, 0.62);
  const legM = surface(wood, 0.7);
  const t = Math.min(0.04, h * 0.08);
  return g(...legs(w, d, h - t, Math.min(0.08, Math.min(w, d) * 0.12), 0.025, legM), place(block(w, t, d, top, 0.01), 0, h - t, 0));
}

function roundTable([w, h, d]: Size) {
  const wood = surface(C.oak, 0.62);
  const r = Math.min(w, d) / 2;
  const top = place(rod(r, r, 0.035, wood, 40), 0, h - 0.035, 0);
  top.scale.set(w / (2 * r), 1, d / (2 * r));
  return g(rod(r * 0.45, r * 0.5, 0.03, wood, 28), rod(0.05, 0.06, h - 0.035, wood, 16), top);
}

function cabinetBody([w, h, d]: Size, counter: string | null, doors: number) {
  const shell = surface(C.shell, 0.8);
  const toe = surface(C.ink, 0.7);
  const dark = surface(C.ink, 0.45, 0.3);
  const kick = counter ? 0.1 : 0;
  const top = counter ? 0.03 : 0;
  const bodyH = h - kick - top;
  const parts: THREE.Object3D[] = [];
  if (kick) parts.push(place(block(w - 0.02, kick, d - 0.1, toe, 0.004), 0, 0, -0.05));
  parts.push(place(block(w, bodyH, d - 0.03, shell, 0.006), 0, kick, -0.015));
  const doorW = (w - 0.006 * (doors + 1)) / doors;
  for (let i = 0; i < doors; i++) {
    const x = -w / 2 + 0.006 + doorW / 2 + i * (doorW + 0.006);
    parts.push(place(block(doorW, bodyH - 0.012, 0.018, shell, 0.004), x, kick + 0.006, d / 2 - 0.021));
    const hx = doors === 1 ? x + doorW / 2 - 0.04 : x + (i % 2 ? -1 : 1) * (doorW / 2 - 0.04);
    parts.push(place(block(0.012, 0.12, 0.012, dark, 0.004), hx, counter ? kick + bodyH - 0.17 : kick + 0.04, d / 2 - 0.006));
  }
  if (counter) parts.push(place(block(w, top, d, surface(counter, 0.5), 0.004), 0, h - top, 0));
  return g(...parts);
}

function baseCabinet(size: Size) {
  return cabinetBody(size, C.stone, size[0] > 0.5 ? 2 : 1);
}

function upperCabinet(size: Size) {
  return cabinetBody(size, null, size[0] > 0.5 ? 2 : 1);
}

function sinkRun([w, h, d]: Size) {
  const counterH = h > 1 ? 0.9 : h;
  const steel = surface(C.steel, 0.3, 0.7);
  const basin = surface("#9a958d", 0.35, 0.6);
  const parts: THREE.Object3D[] = [cabinetBody([w, counterH, d], C.stone, 2), place(block(w * 0.62, 0.004, d * 0.6, basin, 0), 0, counterH, 0.02)];
  if (h > counterH + 0.05) {
    const spout = h - counterH;
    parts.push(place(rod(0.016, 0.02, spout, steel, 12), 0, counterH, -d / 2 + 0.08));
    parts.push(place(block(0.03, 0.03, 0.2, steel, 0.012), 0, h - 0.03, -d / 2 + 0.17));
  }
  return g(...parts);
}

function range([w, h, d]: Size) {
  const enamel = surface(C.paper, 0.45, 0.1);
  const glass = surface(C.glass, 0.25, 0.1);
  const steel = surface(C.steel, 0.3, 0.7);
  const body = Math.min(0.9, h - 0.02);
  const guard = h - body;
  return g(
    place(block(w, body, d - 0.03, enamel, 0.01), 0, 0, 0.015),
    place(block(w - 0.02, 0.012, d - 0.12, glass, 0.003), 0, body - 0.012, 0.03),
    place(block(w - 0.12, body * 0.45, 0.012, glass, 0.006), 0, body * 0.18, d / 2 - 0.006),
    place(block(w - 0.16, 0.02, 0.02, steel, 0.008), 0, body * 0.7, d / 2 - 0.01),
    place(block(w, guard + 0.06, 0.06, enamel, 0.01), 0, body - 0.06, -d / 2 + 0.03),
  );
}

function hood([w, h, d]: Size) {
  const steel = surface(C.steel, 0.35, 0.6);
  const canopy = Math.min(0.14, h * 0.3);
  return g(
    place(block(w, canopy, d, steel, 0.01), 0, 0, 0),
    place(block(w * 0.4, h - canopy, d * 0.5, steel, 0.01), 0, canopy, -d / 4),
  );
}

function fridge([w, h, d]: Size) {
  const body = surface(C.paper, 0.4, 0.1);
  const steel = surface(C.steel, 0.3, 0.7);
  const seam = surface(C.ink, 0.6);
  const split = h * 0.62;
  return g(
    place(block(w, h, d - 0.04, body, 0.02), 0, 0, -0.02),
    place(block(w - 0.01, 0.006, 0.006, seam, 0), 0, split, d / 2 - 0.043),
    place(block(0.022, h * 0.3, 0.022, steel, 0.008), -w / 2 + 0.06, split + 0.06, d / 2 - 0.011),
    place(block(0.022, h * 0.25, 0.022, steel, 0.008), -w / 2 + 0.06, split - 0.06 - h * 0.25, d / 2 - 0.011),
  );
}

function island([w, h, d]: Size) {
  const shell = surface(C.shell, 0.8);
  const toe = surface(C.ink, 0.7);
  const top = surface(C.birch, 0.55);
  const overhang = Math.min(0.3, d * 0.33);
  const bodyD = d - overhang;
  return g(
    place(block(w - 0.1, 0.1, bodyD - 0.1, toe, 0.004), 0, 0, -overhang / 2),
    place(block(w - 0.04, h - 0.14, bodyD - 0.02, shell, 0.008), 0, 0.1, -overhang / 2),
    place(block(w, 0.04, d, top, 0.008), 0, h - 0.04, 0),
  );
}

function cubeStorage([w, h, d]: Size, wood = C.shell) {
  const frame = surface(wood, 0.8);
  const bin = surface(C.accent, 1);
  const bin2 = surface(C.oat, 1);
  const t = 0.03;
  const cols = Math.max(1, Math.round((w - t) / 0.37));
  const rows = Math.max(1, Math.round((h - t) / 0.37));
  const cw = (w - t) / cols;
  const ch = (h - t) / rows;
  const parts: THREE.Object3D[] = [place(block(w, h, 0.01, frame, 0.002), 0, 0, -d / 2 + 0.005)];
  for (let i = 0; i <= cols; i++) parts.push(place(block(t, h, d, frame, 0.004), -w / 2 + t / 2 + i * cw, 0, 0));
  for (let j = 0; j <= rows; j++) parts.push(place(block(w, t, d, frame, 0.004), 0, j * ch, 0));
  let n = 0;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++)
      if ((i + j) % 2 === 0) {
        const m = n++ % 3 === 0 ? bin : bin2;
        parts.push(place(block(cw - t - 0.02, ch - t - 0.02, d - 0.04, m, 0.02), -w / 2 + t + i * cw + (cw - t) / 2, t + j * ch + 0.01, 0.01));
      }
  return g(...parts);
}

function toyShelf([w, h, d]: Size) {
  const frame = surface(C.birch, 0.75);
  const bin = surface(C.accent, 1);
  const bin2 = surface(C.linen, 1);
  const t = 0.025;
  const mid = h * 0.5;
  return g(
    place(block(t, h, d, frame, 0.006), -w / 2 + t / 2, 0, 0),
    place(block(t, h, d, frame, 0.006), w / 2 - t / 2, 0, 0),
    place(block(w, t, d, frame, 0.006), 0, 0.04, 0),
    place(block(w, t, d, frame, 0.006), 0, mid, 0),
    place(block(w, t, d, frame, 0.006), 0, h - t, 0),
    place(block(w * 0.4, mid - 0.09, d - 0.04, bin, 0.03), -w * 0.22, 0.04 + t, 0),
    place(block(w * 0.4, mid - 0.09, d - 0.04, bin2, 0.03), w * 0.22, 0.04 + t, 0),
  );
}

function beanBag([w, h, d]: Size) {
  const fabric = surface(C.oat, 1);
  const geo = new THREE.SphereGeometry(0.5, 32, 20);
  geo.scale(w, h, d);
  geo.translate(0, h / 2, 0);
  return new THREE.Mesh(geo, fabric);
}

function sofaBlock([w, h, d]: Size) {
  const fabric = surface(C.oat, 0.95);
  const cushion = surface(C.linen, 1);
  const arm = Math.min(0.16, w * 0.1);
  const seat = Math.min(0.42, h * 0.55);
  return g(
    block(w, seat - 0.1, d, fabric, 0.03),
    place(block(w, h, Math.min(0.2, d * 0.25), fabric, 0.04), 0, 0, -d / 2 + Math.min(0.1, d * 0.125)),
    ...[-1, 1].map((s) => place(block(arm, h * 0.75, d, fabric, 0.04), s * (w / 2 - arm / 2), 0, 0)),
    place(block(w - 2 * arm - 0.02, 0.1, d - Math.min(0.2, d * 0.25) - 0.02, cushion, 0.04), 0, seat - 0.1, Math.min(0.1, d * 0.125)),
  );
}

function pendant([w, h, d]: Size) {
  const dark = surface(C.ink, 0.4, 0.3);
  const shade = new THREE.MeshStandardMaterial({ color: C.linen, roughness: 0.9, emissive: "#ffbd7a", emissiveIntensity: 0.9, side: THREE.DoubleSide });
  const r = Math.min(w, d) / 2;
  const shadeH = Math.min(0.32, h * 0.45);
  return g(
    place(rod(0.005, 0.005, h - shadeH, dark, 8), 0, shadeH, 0),
    place(rod(0.04, 0.04, 0.012, dark, 16), 0, h - 0.012, 0),
    rod(r * 0.35, r, shadeH, shade, 32),
  );
}

function lamp([w, h, d]: Size) {
  const dark = surface(C.ink, 0.4, 0.3);
  const shade = new THREE.MeshStandardMaterial({ color: "#f3e8d4", roughness: 0.9, emissive: "#ffbd7a", emissiveIntensity: 1.4, side: THREE.DoubleSide });
  const r = Math.min(w, d) / 2;
  const shadeH = Math.min(0.3, h * 0.2);
  const light = new THREE.PointLight("#ffbd7a", 3.2, 0, 2);
  light.position.set(0, h - shadeH / 2, 0);
  return g(
    rod(r * 0.7, r * 0.75, 0.025, dark),
    rod(0.012, 0.012, h - shadeH * 0.6, dark, 10),
    place(rod(r * 0.72, r, shadeH, shade, 32), 0, h - shadeH, 0),
    light,
  );
}

function rugShape([w, h, d]: Size) {
  return block(w, Math.max(0.004, h), d, surface("#cfc2ad", 1), 0);
}

const BUILD: Record<GalleryShape, (s: Size) => THREE.Object3D> = {
  bed: (s) => bed(s), "kids-bed": (s) => bed(s, true), nightstand: (s) => chest(s, 1), dresser: (s) => chest(s, 3), wardrobe,
  desk, "desk-chair": deskChair, "dining-chair": (s) => sideChair(s), "kids-chair": (s) => sideChair(s, C.birch, C.accent), "bar-stool": barStool,
  "dining-table": (s) => table(s, C.walnut), "play-table": (s) => table(s, C.birch), "round-table": roundTable,
  "base-cabinet": baseCabinet, "upper-cabinet": upperCabinet, "sink-run": sinkRun, range, hood, fridge, island,
  "cube-storage": (s) => cubeStorage(s), "toy-shelf": toyShelf, "bean-bag": beanBag, "sofa-block": sofaBlock,
  pendant, lamp, rug: rugShape,
};

export type GalleryHint = { category?: FurnitureCategory; assetUrl?: string | null };

/**
 * Returns a procedural model for pieces drawn without a model file, or null when
 * the item should load its own asset. Built to `dimensions` exactly.
 */
export function galleryPart(id: string, dimensions: Vector3Meters | null, hint?: GalleryHint): THREE.Object3D | null {
  if (hint?.assetUrl) return null;
  let shape = galleryShapeFor(id);
  if (!shape && hint?.category) {
    shape = CATEGORY_SHAPE[hint.category] ?? (hint.category === "table" ? "round-table" : null);
    if (hint.category === "table" && dimensions && Math.abs(dimensions[0] - dimensions[2]) > 0.05) shape = "dining-table";
  }
  if (!shape) return null;
  const size: Size = dimensions ? [dimensions[0], dimensions[1], dimensions[2]] : [...DEFAULT_SIZE[shape]];
  return BUILD[shape](size);
}
