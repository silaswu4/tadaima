import type { FurnitureCategory, PlacedItem, Vector3Meters } from "@/backend/contracts";

/**
 * Our 3D furniture library. A product doesn't come with a model, so it gets the
 * closest library model for its category, scaled per axis to the product's
 * real width, height and depth. Pure and browser-safe: the viewer calls
 * `assetTransform` to draw a product at its true size.
 *
 * Library frame: +Y up, the piece's front faces +Z, its width runs along X.
 * `yaw` turns a model into that frame; `size` is the model's native bounds
 * after that turn (measured from the GLBs in public/models).
 */

export interface LibraryModel {
  kind: "model";
  url: string;
  yaw: number;
  size: Vector3Meters;
}

/** No GLB for these yet; the viewer draws a procedural shape at the real size. */
export interface ProceduralModel {
  kind: "procedural";
  shape: "rug" | "lamp" | "box";
}

export type FurnitureAsset = LibraryModel | ProceduralModel;

const model = (file: string, yaw: number, size: Vector3Meters): LibraryModel => ({ kind: "model", url: `/models/${file}.glb`, yaw, size });

export const LIBRARY: Record<FurnitureCategory, LibraryModel[]> = {
  sofa: [model("sofa_02", 0, [1.807, 0.71, 0.818])],
  chair: [model("mid_century_lounge_chair", 0, [1.009, 1.169, 1.19])],
  // native long side runs along Z, so turn it a quarter
  table: [model("modern_coffee_table_01", Math.PI / 2, [1.202, 0.39, 0.6]), model("side_table_01", 0, [0.55, 0.551, 0.45])],
  // shelves face -X natively with their width along Z
  storage: [model("wooden_display_shelves_01", Math.PI / 2, [1.078, 1.556, 0.371]), model("modern_wooden_cabinet", 0, [2.44, 0.68, 0.52])],
  desk: [],
  bed: [],
  rug: [],
  lamp: [],
  decor: [model("ceramic_vase_01", 0, [0.204, 0.4, 0.204])],
  other: [],
};

const PROCEDURAL: Partial<Record<FurnitureCategory, ProceduralModel["shape"]>> = { rug: "rug", lamp: "lamp" };

/** Best library model for a piece: same category, closest proportions. */
export function assetFor(category: FurnitureCategory, dimensions: Vector3Meters | null): FurnitureAsset {
  const options = LIBRARY[category] ?? [];
  if (!options.length) return { kind: "procedural", shape: PROCEDURAL[category] ?? "box" };
  if (!dimensions || options.length === 1) return options[0];
  // compare shape, not size: log-ratio distance of each axis
  const shape = (s: Vector3Meters) => s.map((v) => Math.log(Math.max(v, 0.01)));
  const target = shape(dimensions);
  const off = (m: LibraryModel) => {
    const s = shape(m.size);
    const mean = (s[0] - target[0] + s[1] - target[1] + s[2] - target[2]) / 3;
    return s.reduce((n, v, i) => n + (v - target[i] - mean) ** 2, 0);
  };
  return options.reduce((best, m) => (off(m) < off(best) ? m : best));
}

export const assetUrlFor = (category: FurnitureCategory, dimensions: Vector3Meters | null) => {
  const a = assetFor(category, dimensions);
  return a.kind === "model" ? a.url : null;
};

/**
 * How to draw a library model at a product's real size: recenter the model on
 * its footprint with its base at y = 0, rotate by `yaw`, then scale by `scale`.
 * The item's own position and rotationY go on a parent group as usual.
 */
export function assetTransform(asset: LibraryModel, dimensions: Vector3Meters | null) {
  const target = dimensions ?? asset.size;
  const scale: Vector3Meters = [target[0] / asset.size[0], target[1] / asset.size[1], target[2] / asset.size[2]];
  return { yaw: asset.yaw, scale };
}

export const itemAsset = (item: Pick<PlacedItem, "category" | "dimensions">) => assetFor(item.category, item.dimensions);
