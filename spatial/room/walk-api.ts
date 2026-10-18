// Shared contract for the walkable room experience at /rooms/[roomId].
// Engine (room/walk-scene.ts), headset layer (room/walk-xr.ts) and the HUD
// (components/RoomExperience.tsx) are built against these types only.
import type * as THREE from "three";
import type { FurnitureCategory, PlacedItem, ProductCandidate, RoomPlan, Vector3Meters } from "../../backend/contracts";

/** Everything the HUD needs to show about one piece, always in real-world meters. */
export type WalkItem = {
  id: string;
  label: string;
  category: FurnitureCategory;
  /** Width (x), height (y), depth (z) in meters, as drawn. Comes from the product or the plan, never guessed from a mesh. */
  dimensions: Vector3Meters;
  /** Where the size came from, for honest labels. */
  dimensionSource: "product" | "plan" | "model";
  position: Vector3Meters;
  rotationY: number;
  productId: string | null;
  priceMinor: number | null;
  currency: string | null;
  origin: PlacedItem["origin"];
  locked: boolean;
  /** Put away in the shopper's inventory: kept in the plan, not standing in the room. */
  stored: boolean;
};

export type WalkSelection = { item: WalkItem; /** Screen position of the piece's top center, CSS px, or null when off screen. */ anchor: { x: number; y: number } | null } | null;

export type WalkMode = "walk" | "orbit";

export type WalkCallbacks = {
  onReady(items: WalkItem[]): void;
  /** Fired whenever pieces are added, removed, moved or rotated (including undo). */
  onItemsChange(items: WalkItem[]): void;
  onSelect(selection: WalkSelection): void;
  /** Fired each frame while something is selected so the HUD card can follow it. */
  onAnchor?(anchor: { x: number; y: number } | null): void;
  onModeChange?(mode: WalkMode, pointerLocked: boolean): void;
  onError(message: string): void;
};

export type AddRequest = {
  product: ProductCandidate;
  /** Optional floor point; defaults to the free floor spot in front of the viewer. */
  at?: [number, number];
};

export type WalkScene = {
  ready: Promise<void>;
  /** Current pieces in plan form; the HUD builds the basket and saves from this. */
  getPlan(): RoomPlan;
  select(id: string | null): void;
  remove(id: string): void;
  /** Put an owned piece away: it leaves the room but stays in the plan as stored, ready to come back. */
  store(id: string): void;
  /** Bring a stored piece back to a free spot in front of the viewer. Returns its id, or null when it is not stored. */
  takeOut(id: string): string | null;
  add(request: AddRequest): string;
  /** Replace a piece with a product, keeping its spot and facing. */
  swap(id: string, product: ProductCandidate): string;
  rotate(id: string, radians: number): void;
  /** Start moving a piece: it follows the view (desktop) or controller (headset) until confirmed or cancelled. */
  beginMove(id: string): void;
  confirmMove(): void;
  cancelMove(): void;
  undo(): void;
  canUndo(): boolean;
  setMode(mode: WalkMode): void;
  /** Request pointer lock for mouse look (desktop walk mode). */
  lockPointer(): void;
  /** True when this browser can enter an immersive VR session (Quest 3S browser). */
  xrSupported(): Promise<boolean>;
  enterXR(): Promise<void>;
  dispose(): void;
};

/** A static backdrop (walls, stairs, glass) loaded from one GLB, in the plan's meter frame. */
export type WalkEnvironment = {
  glbUrl: string;
  /** Uniform scale applied to the GLB to reach meters. */
  scale: number;
  /** Floor point to start from; eye height is added by the engine. */
  spawn: [number, number, number];
};

export type WalkOptions = {
  reducedMotion?: boolean;
  lite?: boolean;
  attachXR?: (core: WalkCore) => WalkXR;
  /** When set, the plan supplies only floor bounds and pieces; walls and collision come from this GLB. */
  environment?: WalkEnvironment;
};

/** What the engine exposes to the headset layer. Keep this small. */
export type WalkCore = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Parent of the camera; locomotion moves and turns this, never the camera itself. */
  rig: THREE.Group;
  /** Root objects that can be picked, each with userData.walkItemId. */
  pickables(): THREE.Object3D[];
  /** Floor meshes for teleport and placement rays. */
  floors(): THREE.Object3D[];
  /** Clamp a desired rig position (x, z) against walls and furniture footprints, eye height excluded. */
  collide(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3;
  select(id: string | null): void;
  selectedId(): string | null;
  remove(id: string): void;
  rotate(id: string, radians: number): void;
  /** Place a piece directly (used for grab-to-move); validated against the room outline. */
  setItemTransform(id: string, x: number, z: number, rotationY: number): void;
  /** Show the dimension label for a piece inside the headset. */
  itemInfo(id: string): WalkItem | null;
};

/** The headset layer: attach once, it drives itself from renderer.xr events. */
export type WalkXR = { update(dt: number): void; dispose(): void };
