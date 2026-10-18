// Walkable first-person room engine for /rooms/[roomId].
// Built against walk-api.ts only. Every piece is drawn at its real size in meters.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { dracoLoader } from "./draco";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import type { PlacedItem, PointXZ, ProductCandidate, RoomPlan, Vector3Meters } from "../../backend/contracts";
import { LIBRARY, assetFor, assetTransform, itemAsset, type LibraryModel } from "../../backend/shopping/assets";
import type { AddRequest, WalkCallbacks, WalkCore, WalkItem, WalkMode, WalkOptions, WalkScene, WalkXR } from "./walk-api";
import { block, rug, standingLamp, surface } from "./parts";
import { createRoomLighting, setMetricSurfaceUVs } from "./lighting";
import { createFurnitureProxy, placeFurnitureModel } from "./furniture-model";
import { galleryPart } from "./gallery-parts";
import { createPanel } from "./labels";
import { footprint, footprintInside, polygonCentroid } from "./plan";
import { insideFloor, planWindowDaylight } from "./window-daylight";

type Size = [number, number, number];

const BACKGROUND = "#f5f2eb";
const ACCENT = "#a95431";
const INVALID = "#c2412d";
const VALID = "#5b7f5f";
const INK = "#24221f";
const EYE_HEIGHT = 1.6;
const WALK_SPEED = 1.4;
const FAST_SPEED = 2.8;
const BODY_RADIUS = 0.22;
const GRID = 0.05;
const LOOK_SPEED = 0.0022;
const DRAG_LOOK_SPEED = 0.004;
const WALK_FOV = 70;
const ORBIT_FOV = 42;
const FLAT_HEIGHT = 0.05;
const XR_FEATURES = ["local-floor", "bounded-floor", "hand-tracking"];
const TURN_STEP = THREE.MathUtils.degToRad(15);

type Entry = {
  item: PlacedItem;
  root: THREE.Group;
  /** Drawn width, height, depth in meters. */
  dims: Size;
  source: WalkItem["dimensionSource"];
  loaded: boolean;
  flat: boolean;
  cos: number;
  sin: number;
};

type UndoOp =
  | { kind: "add"; id: string }
  | { kind: "remove"; entry: Entry; index: number }
  | { kind: "swap"; old: Entry; newId: string; index: number }
  | { kind: "store"; entry: Entry; index: number }
  | { kind: "takeOut"; id: string; item: PlacedItem; index: number }
  | { kind: "transform"; id: string; position: Vector3Meters; rotationY: number; coalesceUntil?: number };

type MoveState = {
  id: string;
  startPosition: Vector3Meters;
  startRotation: number;
  x: number;
  z: number;
  rotation: number;
  valid: boolean;
  checkedKey: string;
};

type Segment = { ax: number; az: number; bx: number; bz: number; radius: number };

/** Release GPU resources once, including embedded ImageBitmaps from loaded GLBs. */
function releaseAll(roots: Iterable<THREE.Object3D>) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const root of roots) {
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh || node instanceof THREE.Line)) return;
      geometries.add(node.geometry);
      const list = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of list) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
    });
  }
  for (const geometry of geometries) geometry.dispose();
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) images.add(texture.image);
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const material of materials) material.dispose();
}

const libraryByUrl = (url: string | null): LibraryModel | null => {
  if (!url) return null;
  for (const list of Object.values(LIBRARY)) for (const m of list) if (m.url === url) return m;
  return null;
};

const inches = (m: number) => {
  const v = Math.round((m / 0.0254) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

/** SAT overlap of two convex footprints; touching edges do not count. */
function footprintsOverlap(a: readonly PointXZ[], b: readonly PointXZ[]) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = -(q[1] - p[1]);
      const nz = q[0] - p[0];
      const len = Math.hypot(nx, nz) || 1;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const [x, z] of a) {
        const d = (x * nx + z * nz) / len;
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      for (const [x, z] of b) {
        const d = (x * nx + z * nz) / len;
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      if (maxA <= minB + 0.005 || maxB <= minA + 0.005) return false;
    }
  }
  return true;
}

function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function createWalkScene(canvas: HTMLCanvasElement, plan: RoomPlan, callbacks: WalkCallbacks, options: WalkOptions = {}): WalkScene {
  // Own copy of the plan; edits change only this snapshot and are read back through getPlan().
  const working: RoomPlan = structuredClone(plan);
  const rooms = working.geometry.rooms;
  if (!rooms.length || rooms.every((r) => r.floorPolygon.length < 3)) throw new Error("A room floor is required for the walk view.");
  const lite = !!options.lite;
  const reduced = !!options.reducedMotion;

  // ------------------------------------------------------------ renderer
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lite ? 1.25 : 2));
  renderer.setClearColor(BACKGROUND);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap is removed in this three.js; a filtered PCF radius gives the soft edge.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  renderer.xr.setFoveation(0.5);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  const lighting = createRoomLighting(renderer, scene, lite);
  scene.add(new THREE.HemisphereLight("#eef2ff", "#b6a48c", 0.55));
  const sun = new THREE.DirectionalLight("#fff3e0", 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(lite ? 1024 : 2048);
  sun.shadow.radius = 4;
  sun.shadow.normalBias = 0.02;
  sun.shadow.bias = -0.0001;
  scene.add(sun, sun.target);

  const windows = lite ? [] : planWindowDaylight(working.geometry, 4);
  if (windows.length) RectAreaLightUniformsLib.init();
  for (const w of windows) {
    const light = new THREE.RectAreaLight("#f1f5ff", 5, w.width, w.height);
    light.position.fromArray(w.position);
    light.lookAt(w.position[0] + w.inward[0], w.position[1], w.position[2] + w.inward[2]);
    scene.add(light);
  }

  const camera = new THREE.PerspectiveCamera(WALK_FOV, 1, 0.05, 120);
  camera.rotation.order = "YXZ";
  const rig = new THREE.Group();
  rig.add(camera);
  scene.add(rig);

  const controls = new OrbitControls(camera, canvas);
  controls.enabled = false;
  controls.enableDamping = !reduced;
  controls.dampingFactor = 0.09;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;
  controls.minDistance = 1.5;
  controls.enablePan = true;

  // ------------------------------------------------------------ shell
  const shell = new THREE.Group();
  scene.add(shell);
  const appearances = new Map(working.appearance?.surfaces.map((s) => [s.entityId, s]) ?? []);
  const floorMeshes: THREE.Mesh[] = [];
  const ceilings: THREE.Mesh[] = [];
  const ceilingMaterial = surface("#f4f1ea", 0.95);
  for (const room of rooms) {
    if (room.floorPolygon.length < 3) continue;
    const appearance = appearances.get(room.id);
    const shape = new THREE.Shape(room.floorPolygon.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);
    setMetricSurfaceUVs(geometry, appearance?.tileMeters ?? 1.2, appearance?.rotationDegrees);
    const floor = new THREE.Mesh(geometry, lighting.makeSurface("floor", appearance));
    floor.position.y = -0.1;
    floor.receiveShadow = true;
    shell.add(floor);
    floorMeshes.push(floor);
    // Faces down only, so it is invisible from above and in the cutaway.
    const ceilingGeometry = new THREE.ShapeGeometry(new THREE.Shape(room.floorPolygon.map(([x, z]) => new THREE.Vector2(x, z))));
    ceilingGeometry.rotateX(Math.PI / 2);
    const ceiling = new THREE.Mesh(ceilingGeometry, ceilingMaterial);
    ceiling.position.y = room.height;
    ceiling.receiveShadow = false;
    ceiling.castShadow = false;
    shell.add(ceiling);
    ceilings.push(ceiling);
  }
  // An environment GLB brings its own floor and ceiling; the plan floor stays as an invisible pick and placement surface.
  const environment = options.environment;
  if (environment) {
    for (const f of floorMeshes) (f.material as THREE.Material).visible = false;
    for (const c of ceilings) c.visible = false;
  }

  type WallView = { materials: THREE.MeshStandardMaterial[]; meshes: THREE.Mesh[]; midpoint: THREE.Vector3; outward: THREE.Vector3; interior: boolean };
  const wallViews: WallView[] = [];
  const wallMeshes: THREE.Mesh[] = [];
  const segments: Segment[] = [];
  let halfWall = 0.06;
  for (const wall of working.geometry.walls) {
    const dx = wall.end[0] - wall.start[0];
    const dz = wall.end[1] - wall.start[1];
    const length = Math.hypot(dx, dz);
    if (length <= 0) continue;
    halfWall = Math.max(halfWall, wall.thickness / 2);
    const material = lighting.makeSurface("wall", appearances.get(wall.id));
    const midpoint = new THREE.Vector3((wall.start[0] + wall.end[0]) / 2, 0, (wall.start[1] + wall.end[1]) / 2);
    const outward = new THREE.Vector3(dz, 0, -dx).normalize();
    const plusInside = insideFloor([midpoint.x + outward.x * 0.01, midpoint.z + outward.z * 0.01], working.geometry);
    const minusInside = insideFloor([midpoint.x - outward.x * 0.01, midpoint.z - outward.z * 0.01], working.geometry);
    if (plusInside && !minusInside) outward.negate();
    const interior = plusInside && minusInside;
    const view: WallView = { materials: [material], meshes: [], midpoint, outward, interior };
    wallViews.push(view);
    const openings = working.geometry.openings.filter((o) => o.wallId === wall.id);
    const cuts = [...new Set([0, length, ...openings.flatMap((o) => [THREE.MathUtils.clamp(o.offset, 0, length), THREE.MathUtils.clamp(o.offset + o.width, 0, length)])])].sort(
      (a, b) => a - b,
    );
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      const middle = (a + b) / 2;
      const here = openings.filter((o) => middle > o.offset && middle < o.offset + o.width);
      const holes = here.map((o) => [Math.max(0, o.sillHeight), Math.min(wall.height, o.sillHeight + o.height)]).sort((p, q) => p[0] - q[0]);
      let bottom = 0;
      const spans: number[][] = [];
      for (const [low, high] of holes) {
        if (low > bottom) spans.push([bottom, low]);
        bottom = Math.max(bottom, high);
      }
      if (bottom < wall.height) spans.push([bottom, wall.height]);
      for (const [low, high] of spans) {
        if (high <= low || b <= a) continue;
        const mesh = block(b - a, high - low, wall.thickness, material, 0);
        setMetricSurfaceUVs(mesh.geometry, appearances.get(wall.id)?.tileMeters ?? 1, appearances.get(wall.id)?.rotationDegrees, [middle, low]);
        mesh.position.set(wall.start[0] + (dx * middle) / length, low, wall.start[1] + (dz * middle) / length);
        mesh.rotation.y = -Math.atan2(dz, dx);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        view.meshes.push(mesh);
        wallMeshes.push(mesh);
        shell.add(mesh);
      }
      // Collision: an interior partition lets you through its door gaps; the outer shell never does.
      const door = here.some((o) => o.kind === "door" && o.sillHeight < 0.2);
      if (!(interior && door)) {
        segments.push({
          ax: wall.start[0] + (dx * a) / length,
          az: wall.start[1] + (dz * a) / length,
          bx: wall.start[0] + (dx * b) / length,
          bz: wall.start[1] + (dz * b) / length,
          radius: wall.thickness / 2 + BODY_RADIUS,
        });
      }
    }
  }
  if (!segments.length) {
    for (const room of rooms) {
      const p = room.floorPolygon;
      for (let i = 0; i < p.length; i++) {
        const q = p[(i + 1) % p.length];
        segments.push({ ax: p[i][0], az: p[i][1], bx: q[0], bz: q[1], radius: BODY_RADIUS });
      }
    }
  }

  const roomBounds = new THREE.Box3().setFromObject(shell);
  const roomCenter = roomBounds.getCenter(new THREE.Vector3());
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), surface(BACKGROUND, 1));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(roomCenter.x, -0.115, roomCenter.z);
  ground.receiveShadow = true;
  scene.add(ground);

  // Shadow frustum fitted once around the shell in light space.
  {
    const primary = windows[0];
    const direction = primary ? new THREE.Vector3(-primary.inward[0], 0.9, -primary.inward[2]).normalize() : new THREE.Vector3(-6, 12, 8).normalize();
    const span = roomBounds.getSize(new THREE.Vector3()).length();
    sun.target.position.copy(roomCenter);
    sun.position.copy(roomCenter).addScaledVector(direction, Math.max(12, span * 1.5));
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);
    const lightBounds = roomBounds.clone().expandByScalar(0.3).applyMatrix4(sun.shadow.camera.matrixWorldInverse);
    const cam = sun.shadow.camera;
    cam.left = lightBounds.min.x;
    cam.right = lightBounds.max.x;
    cam.bottom = lightBounds.min.y;
    cam.top = lightBounds.max.y;
    cam.near = Math.max(0.1, -lightBounds.max.z - 2);
    cam.far = Math.max(cam.near + 1, -lightBounds.min.z + 2);
    cam.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ overlays
  const outlineGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const makeOutline = (color: string, opacity: number) => {
    const line = new THREE.LineSegments(outlineGeometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }));
    line.renderOrder = 12;
    line.visible = false;
    line.raycast = () => {};
    scene.add(line);
    return line;
  };
  const selectionOutline = makeOutline(ACCENT, 0.95);
  const hoverOutline = makeOutline(INK, 0.35);
  const footprintMaterial = new THREE.MeshBasicMaterial({ color: VALID, transparent: true, opacity: 0.3, depthWrite: false });
  const footprintMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), footprintMaterial);
  footprintMesh.renderOrder = 11;
  footprintMesh.visible = false;
  footprintMesh.raycast = () => {};
  scene.add(footprintMesh);

  const panel = createPanel(0.6, 0.2, 1000);
  panel.mesh.visible = false;
  scene.add(panel.mesh);

  const crosshairMaterial = new THREE.MeshBasicMaterial({ color: INK, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false });
  const crosshair = new THREE.Mesh(new THREE.RingGeometry(0.0035, 0.0055, 24), crosshairMaterial);
  crosshair.position.set(0, 0, -0.5);
  crosshair.renderOrder = 30;
  crosshair.visible = false;
  crosshair.raycast = () => {};
  camera.add(crosshair);

  // ------------------------------------------------------------ state
  const entries = new Map<string, Entry>();
  /** Plan order of every item id, including stored ones. */
  const order: string[] = [];
  const storedItems = new Map<string, PlacedItem>();
  /** Every root ever built, so detached (removed or undoable) pieces are released on dispose. */
  const allRoots = new Set<THREE.Object3D>();
  const gltfCache = new Map<string, Promise<THREE.Object3D>>();
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setDRACOLoader(dracoLoader());
  const envMeshes: THREE.Mesh[] = [];
  const envLoad: Promise<void> = environment
    ? loader.loadAsync(environment.glbUrl).then((gltf) => {
        const root = gltf.scene;
        root.scale.setScalar(environment.scale);
        root.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.castShadow = true;
            node.receiveShadow = true;
            envMeshes.push(node);
          }
        });
        scene.add(root);
        allRoots.add(root);
        root.updateMatrixWorld(true);
      })
    : Promise.resolve();
  const undoStack: UndoOp[] = [];
  let pickList: THREE.Object3D[] = [];
  let pickRoots: THREE.Object3D[] = [];
  let pickDirty = true;
  let mode: WalkMode = "walk";
  let pointerLocked = false;
  let selectedId: string | null = null;
  let hoverId: string | null = null;
  let moving: MoveState | null = null;
  let disposed = false;
  let itemsDirty = false;
  let labelKey = "";
  let lastAnchor: { x: number; y: number } | null = null;
  let viewWidth = 1;
  let viewHeight = 1;
  let idCounter = 0;
  let yaw = 0;
  let pitch = 0;
  let xrSession: XRSession | null = null;
  let xr: WalkXR | null = null;
  const savedRig = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const keys = new Set<string>();
  const mouse = new THREE.Vector2();
  let mouseOnCanvas = false;

  // scratch values reused every frame
  const raycaster = new THREE.Raycaster();
  const hits: THREE.Intersection[] = [];
  const center = new THREE.Vector2(0, 0);
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const desired = new THREE.Vector3();

  const productFor = (item: PlacedItem) => (item.productId ? working.products.find((p) => p.id === item.productId) ?? null : null);
  const roomFor = (x: number, z: number) => rooms.find((r) => insideFloor([x, z], { ...working.geometry, rooms: [r] })) ?? rooms[0];

  function knownSize(item: PlacedItem): { dims: Size; source: "product" | "plan" } | null {
    const product = productFor(item);
    if (product?.dimensions) return { dims: [...product.dimensions] as Size, source: "product" };
    if (item.dimensions) return { dims: [...item.dimensions] as Size, source: "plan" };
    return null;
  }

  function toWalkItem(entry: Entry): WalkItem {
    const { item } = entry;
    const product = productFor(item);
    return {
      id: item.id,
      label: item.label,
      category: item.category,
      dimensions: [...entry.dims] as Vector3Meters,
      dimensionSource: entry.source,
      position: [...item.position] as Vector3Meters,
      rotationY: item.rotationY,
      productId: item.productId,
      priceMinor: product?.price?.amountMinor ?? null,
      currency: product?.price?.currency ?? null,
      origin: item.origin,
      locked: item.locked,
      stored: false,
    };
  }
  function storedWalkItem(item: PlacedItem): WalkItem {
    const known = knownSize(item);
    const product = productFor(item);
    return {
      id: item.id,
      label: item.label,
      category: item.category,
      dimensions: known ? (known.dims as Vector3Meters) : [0, 0, 0],
      dimensionSource: known?.source ?? "model",
      position: [...item.position] as Vector3Meters,
      rotationY: item.rotationY,
      productId: item.productId,
      priceMinor: product?.price?.amountMinor ?? null,
      currency: product?.price?.currency ?? null,
      origin: item.origin,
      locked: item.locked,
      stored: true,
    };
  }
  // Stored pieces are listed too (not drawn); the HUD does its own filtering.
  const listItems = () => order.flatMap((id) => {
    const e = entries.get(id);
    if (e) return [toWalkItem(e)];
    const stored = storedItems.get(id);
    return stored ? [storedWalkItem(stored)] : [];
  });
  const emitItems = () => {
    itemsDirty = false;
    if (!disposed) callbacks.onItemsChange(listItems());
  };

  function syncEntry(entry: Entry) {
    entry.root.position.fromArray(entry.item.position);
    entry.root.rotation.y = entry.item.rotationY;
    entry.cos = Math.cos(entry.item.rotationY);
    entry.sin = Math.sin(entry.item.rotationY);
    entry.flat = entry.item.category === "rug" || entry.dims[1] < FLAT_HEIGHT;
  }

  // ------------------------------------------------------------ models
  function loadGlb(url: string) {
    let cached = gltfCache.get(url);
    if (!cached) {
      cached = loader.loadAsync(url).then((gltf) => {
        allRoots.add(gltf.scene);
        return gltf.scene;
      });
      gltfCache.set(url, cached);
    }
    return cached.then((template) => template.clone(true));
  }

  /** Builds the drawn model, base-centered at the origin, scaled per axis to the real size. */
  async function buildModel(item: PlacedItem, size: Size | null): Promise<{ object: THREE.Object3D; dims: Size }> {
    let base: THREE.Object3D | null = galleryPart(item.id, size);
    let library: LibraryModel | null = null;
    if (!base) {
      try {
        if (item.assetUrl) {
          library = libraryByUrl(item.assetUrl);
          base = await loadGlb(item.assetUrl);
        } else if (item.origin === "existing_owned" && item.evidenceIds?.length) {
          // A captured piece is an honest size proxy, not a guessed library model.
          base = createFurnitureProxy(size ?? [0.8, 0.8, 0.8]);
        } else {
          const asset = itemAsset({ category: item.category, dimensions: size });
          if (asset.kind === "model") {
            library = asset;
            base = await loadGlb(asset.url);
          } else if (asset.shape === "rug") base = rug(size?.[0] ?? 1.6, size?.[2] ?? 1, "#cfc2ad");
          else if (asset.shape === "lamp") base = standingLamp();
          else base = createFurnitureProxy(size ?? [0.8, 0.8, 0.8]);
        }
      } catch {
        library = null;
        base = createFurnitureProxy(size ?? [0.8, 0.8, 0.8]);
      }
    }
    const turn = new THREE.Group();
    // Library yaw maps a model into the width-on-X frame its sizes are given in.
    // Legacy items with no size or product were placed in the model's native frame.
    if (library && (size || item.productId)) turn.rotation.y = library.yaw;
    turn.add(base);
    const scaler = new THREE.Group();
    scaler.add(turn);
    if (size) {
      if (library) scaler.scale.fromArray(assetTransform(library, size).scale);
      else {
        const measured = new THREE.Box3().setFromObject(scaler, true).getSize(tmpC);
        scaler.scale.set(
          measured.x > 1e-4 ? size[0] / measured.x : 1,
          measured.y > 1e-4 ? size[1] / measured.y : 1,
          measured.z > 1e-4 ? size[2] / measured.z : 1,
        );
      }
    }
    const placed = placeFurnitureModel({ id: item.id, position: [0, 0, 0], rotationY: 0 }, scaler);
    placed.root.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
    return { object: placed.root, dims: size ?? placed.size };
  }

  function createEntry(item: PlacedItem): { entry: Entry; loaded: Promise<void> } {
    const known = knownSize(item);
    const root = new THREE.Group();
    root.userData.walkItemId = item.id;
    allRoots.add(root);
    const entry: Entry = {
      item,
      root,
      dims: known?.dims ?? [0.6, 0.6, 0.6],
      source: known?.source ?? "model",
      loaded: false,
      flat: false,
      cos: 1,
      sin: 0,
    };
    if (known && item.productId && known.source === "product") item.dimensions = [...known.dims];
    syncEntry(entry);
    // Sized stand-in until the model arrives, so a new piece is visible and selectable at once.
    const placeholder = createFurnitureProxy(entry.dims);
    placeholder.castShadow = true;
    root.add(placeholder);
    const loaded = buildModel(item, known?.dims ?? null).then(({ object, dims }) => {
      if (disposed) {
        releaseAll([object]);
        return;
      }
      root.remove(placeholder);
      releaseAll([placeholder]);
      root.add(object);
      entry.dims = dims;
      entry.loaded = true;
      syncEntry(entry);
      pickDirty = true;
      if (moving?.id === item.id) moving.checkedKey = "";
      labelKey = "";
    });
    return { entry, loaded };
  }

  function attach(entry: Entry, index = order.length) {
    entries.set(entry.item.id, entry);
    order.splice(Math.min(index, order.length), 0, entry.item.id);
    scene.add(entry.root);
    pickDirty = true;
  }

  function detach(id: string): { entry: Entry; index: number } | null {
    const entry = entries.get(id);
    if (!entry) return null;
    if (moving?.id === id) cancelMove();
    if (selectedId === id) select(null);
    if (hoverId === id) hoverId = null;
    entries.delete(id);
    const index = order.indexOf(id);
    if (index >= 0) order.splice(index, 1);
    scene.remove(entry.root);
    pickDirty = true;
    return { entry, index };
  }

  const initialLoads: Promise<void>[] = [];
  for (const item of working.items) {
    if (item.stored) {
      storedItems.set(item.id, item);
      order.push(item.id);
      continue;
    }
    const { entry, loaded } = createEntry(item);
    attach(entry);
    initialLoads.push(loaded);
  }

  function rebuildPicks() {
    pickDirty = false;
    pickRoots = order.flatMap((id) => {
      const e = entries.get(id);
      return e ? [e.root] : [];
    });
    pickList = mode === "walk" ? [...pickRoots, ...wallMeshes] : pickRoots;
  }

  // ------------------------------------------------------------ placement rules
  function insideRoom(x: number, z: number, rotation: number, dims: Size) {
    const corners = footprint([x, 0, z], rotation, dims[0] + halfWall * 2, dims[2] + halfWall * 2);
    return rooms.some((r) => footprintInside(corners, r.floorPolygon));
  }

  function overlapsOthers(id: string, x: number, y: number, z: number, rotation: number, dims: Size) {
    if (dims[1] < FLAT_HEIGHT) return false;
    const mine = footprint([x, 0, z], rotation, dims[0], dims[2]);
    for (const [otherId, other] of entries) {
      if (otherId === id || other.flat) continue;
      const oy = other.item.position[1];
      if (y >= oy + other.dims[1] - 0.01 || oy >= y + dims[1] - 0.01) continue;
      if (footprintsOverlap(mine, footprint(other.item.position, other.item.rotationY, other.dims[0], other.dims[2]))) return true;
    }
    return false;
  }

  function placementValid(id: string, x: number, y: number, z: number, rotation: number, dims: Size) {
    return insideRoom(x, z, rotation, dims) && !overlapsOthers(id, x, y, z, rotation, dims);
  }

  // ------------------------------------------------------------ collision
  const envRay = new THREE.Raycaster();
  const envFrom = new THREE.Vector3();
  const envDir = new THREE.Vector3();
  function envBlocked(ax: number, az: number, bx: number, bz: number) {
    const dist = Math.hypot(bx - ax, bz - az);
    if (dist < 1e-6) return false;
    envDir.set((bx - ax) / dist, 0, (bz - az) / dist);
    envRay.far = dist + BODY_RADIUS;
    for (const h of [0.45, 1.1]) {
      envFrom.set(ax, h, az);
      envRay.set(envFrom, envDir);
      if (envRay.intersectObjects(envMeshes, false).length) return true;
    }
    return false;
  }
  /** Pushes a rig point out of walls and furniture footprints; keeps the result inside the floor. */
  function collideInto(from: THREE.Vector3, to: THREE.Vector3, out: THREE.Vector3) {
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.max(1, Math.ceil(dist / 0.08));
    let px = from.x;
    let pz = from.z;
    for (let s = 1; s <= steps; s++) {
      let x = from.x + ((to.x - from.x) * s) / steps;
      let z = from.z + ((to.z - from.z) * s) / steps;
      for (let iter = 0; iter < 3; iter++) {
        for (const entry of entries.values()) {
          if (entry.flat || entry.item.position[1] > 1.2 || moving?.id === entry.item.id) continue;
          const ex = entry.dims[0] / 2 + BODY_RADIUS;
          const ez = entry.dims[2] / 2 + BODY_RADIUS;
          const dx = x - entry.item.position[0];
          const dz = z - entry.item.position[2];
          let lx = dx * entry.cos - dz * entry.sin;
          let lz = dx * entry.sin + dz * entry.cos;
          if (Math.abs(lx) >= ex || Math.abs(lz) >= ez) continue;
          if (ex - Math.abs(lx) < ez - Math.abs(lz)) lx = Math.sign(lx || 1) * ex;
          else lz = Math.sign(lz || 1) * ez;
          x = entry.item.position[0] + lx * entry.cos + lz * entry.sin;
          z = entry.item.position[2] - lx * entry.sin + lz * entry.cos;
        }
        for (const seg of segments) {
          const sx = seg.bx - seg.ax;
          const sz = seg.bz - seg.az;
          const len2 = sx * sx + sz * sz || 1;
          const t = THREE.MathUtils.clamp(((x - seg.ax) * sx + (z - seg.az) * sz) / len2, 0, 1);
          const cx = seg.ax + sx * t;
          const cz = seg.az + sz * t;
          const d = Math.hypot(x - cx, z - cz);
          if (d >= seg.radius || d < 1e-6) continue;
          x = cx + ((x - cx) / d) * seg.radius;
          z = cz + ((z - cz) / d) * seg.radius;
        }
      }
      if (envMeshes.length) {
        // Slide: try the full step, then each axis alone, against the backdrop at knee and chest height.
        if (envBlocked(px, pz, x, z)) {
          if (!envBlocked(px, pz, x, pz)) z = pz;
          else if (!envBlocked(px, pz, px, z)) x = px;
          else break;
        }
      }
      if (!insideFloor([x, z], working.geometry)) break;
      px = x;
      pz = z;
    }
    return out.set(px, to.y, pz);
  }

  // ------------------------------------------------------------ spawn
  function spawn() {
    const centroid = polygonCentroid(rooms[0].floorPolygon);
    let start: [number, number] | null = null;
    for (const opening of working.geometry.openings) {
      if (opening.kind !== "door") continue;
      const wall = working.geometry.walls.find((w) => w.id === opening.wallId);
      if (!wall) continue;
      const dx = wall.end[0] - wall.start[0];
      const dz = wall.end[1] - wall.start[1];
      const len = Math.hypot(dx, dz);
      if (!len) continue;
      const t = (opening.offset + opening.width / 2) / len;
      const mx = wall.start[0] + dx * t;
      const mz = wall.start[1] + dz * t;
      const nx = -dz / len;
      const nz = dx / len;
      for (const side of [1, -1]) {
        const x = mx + nx * side * 0.75;
        const z = mz + nz * side * 0.75;
        if (insideFloor([x, z], working.geometry)) {
          start = [x, z];
          break;
        }
      }
      if (start) break;
    }
    if (!start) {
      // No door: stand near the middle of the longest wall, inside the room.
      let best = -1;
      for (const wall of working.geometry.walls) {
        const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
        if (len <= best) continue;
        const mx = (wall.start[0] + wall.end[0]) / 2;
        const mz = (wall.start[1] + wall.end[1]) / 2;
        const toward = Math.hypot(centroid[0] - mx, centroid[1] - mz) || 1;
        const x = mx + ((centroid[0] - mx) / toward) * 0.8;
        const z = mz + ((centroid[1] - mz) / toward) * 0.8;
        if (insideFloor([x, z], working.geometry)) {
          best = len;
          start = [x, z];
        }
      }
    }
    if (environment) start = [environment.spawn[0], environment.spawn[2]];
    const [sx, sz] = start ?? centroid;
    tmpA.set(sx, EYE_HEIGHT, sz);
    collideInto(tmpA, tmpA, rig.position);
    rig.position.y = EYE_HEIGHT;
    yaw = Math.atan2(-(centroid[0] - rig.position.x), -(centroid[1] - rig.position.z));
    pitch = -0.08;
    rig.rotation.set(0, yaw, 0);
    camera.position.set(0, 0, 0);
    camera.rotation.set(pitch, 0, 0);
  }
  spawn();

  // ------------------------------------------------------------ view helpers
  function viewerFloor(out: THREE.Vector3, forward: THREE.Vector3) {
    if (mode === "orbit") {
      out.copy(controls.target);
      camera.getWorldDirection(forward);
    } else {
      camera.getWorldPosition(out);
      camera.getWorldDirection(forward);
    }
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    out.y = 0;
  }

  function fitOrbit() {
    const direction = tmpA.set(1, 1.05, 1.35).normalize();
    const target = roomBounds.getCenter(tmpB);
    target.y = 0.4;
    const right = tmpC.crossVectors(camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(ORBIT_FOV / 2));
    const tanH = tanV * camera.aspect;
    let distance = 2;
    const corner = new THREE.Vector3();
    for (const x of [roomBounds.min.x, roomBounds.max.x])
      for (const y of [roomBounds.min.y, roomBounds.max.y])
        for (const z of [roomBounds.min.z, roomBounds.max.z]) {
          corner.set(x, y, z).sub(target);
          distance = Math.max(distance, corner.dot(direction) + Math.abs(corner.dot(right)) / tanH, corner.dot(direction) + Math.abs(corner.dot(up)) / tanV);
        }
    camera.position.copy(target).addScaledVector(direction, distance * 1.1);
    controls.target.copy(target);
    controls.maxDistance = distance * 4;
    controls.update();
  }

  function applyWallMode() {
    const orbit = mode === "orbit";
    for (const wall of wallViews) {
      for (const material of wall.materials) {
        material.transparent = orbit;
        material.opacity = 1;
        material.depthWrite = true;
        material.needsUpdate = true;
      }
      for (const mesh of wall.meshes) mesh.castShadow = true;
    }
    for (const ceiling of ceilings) ceiling.visible = !orbit && !environment;
    pickDirty = true;
  }

  function resize() {
    if (disposed || renderer.xr.isPresenting) return;
    const { width, height } = canvas.getBoundingClientRect();
    viewWidth = Math.max(1, width);
    viewHeight = Math.max(1, height);
    renderer.setSize(viewWidth, viewHeight, false);
    camera.aspect = viewWidth / viewHeight;
    camera.updateProjectionMatrix();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  // ------------------------------------------------------------ selection
  function select(id: string | null) {
    const next = id !== null && entries.has(id) ? id : null;
    if (moving && moving.id !== next) cancelMove();
    if (next === selectedId) return;
    selectedId = next;
    labelKey = "";
    lastAnchor = null;
    const entry = next ? entries.get(next) : null;
    callbacks.onSelect(entry ? { item: toWalkItem(entry), anchor: anchorFor(entry) } : null);
  }

  function anchorFor(entry: Entry): { x: number; y: number } | null {
    if (renderer.xr.isPresenting) return null;
    tmpA.set(entry.root.position.x, entry.root.position.y + entry.dims[1], entry.root.position.z).project(camera);
    if (tmpA.z < -1 || tmpA.z > 1 || Math.abs(tmpA.x) > 1.02 || Math.abs(tmpA.y) > 1.02) return null;
    return { x: ((tmpA.x + 1) / 2) * viewWidth, y: ((1 - tmpA.y) / 2) * viewHeight };
  }

  function pickAt(ndc: THREE.Vector2): string | null {
    if (pickDirty) rebuildPicks();
    raycaster.setFromCamera(ndc, camera);
    raycaster.far = mode === "walk" ? 12 : 400;
    hits.length = 0;
    raycaster.intersectObjects(pickList, true, hits);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node && node.userData.walkItemId === undefined) node = node.parent;
      if (!node) return null; // a wall is in front
      const id = node.userData.walkItemId as string;
      if (moving?.id === id) continue;
      return id;
    }
    return null;
  }

  const usesCenter = () => renderer.xr.isPresenting || (mode === "walk" && pointerLocked) || !mouseOnCanvas;

  // ------------------------------------------------------------ editing
  function pushUndo(op: UndoOp) {
    undoStack.push(op);
    if (undoStack.length > 100) undoStack.shift();
  }

  function newId(base: string) {
    let id: string;
    do id = `${base}-${Date.now().toString(36)}${(idCounter++).toString(36)}`;
    while (entries.has(id) || storedItems.has(id));
    return id;
  }

  function itemFromProduct(product: ProductCandidate, id: string, position: Vector3Meters, rotationY: number, roomId: string): PlacedItem {
    const asset = assetFor(product.category, product.dimensions);
    if (!working.products.some((p) => p.id === product.id)) working.products.push(structuredClone(product));
    return {
      id,
      roomId,
      label: product.label,
      category: product.category,
      origin: "proposed_purchase",
      productId: product.id,
      assetUrl: asset.kind === "model" ? asset.url : null,
      position,
      rotationY,
      dimensions: product.dimensions ? [...product.dimensions] : null,
      seats: product.seats,
      locked: false,
    };
  }

  function findFreeSpot(id: string, dims: Size, at?: [number, number]): { x: number; z: number; rotation: number } {
    const viewer = new THREE.Vector3();
    const forward = new THREE.Vector3();
    viewerFloor(viewer, forward);
    const ox = at ? at[0] : viewer.x + forward.x * (mode === "orbit" ? 0 : 1.1 + dims[2] / 2);
    const oz = at ? at[1] : viewer.z + forward.z * (mode === "orbit" ? 0 : 1.1 + dims[2] / 2);
    // Front (+z) faces the viewer, snapped to the nearest quarter turn so it squares up with the walls.
    const face = Math.atan2(viewer.x - ox, viewer.z - oz);
    const base = Math.round(face / (Math.PI / 2)) * (Math.PI / 2);
    const snap = (v: number) => Math.round(v / GRID) * GRID;
    for (let r = 0; r <= 5; r += 0.25) {
      const count = r === 0 ? 1 : Math.max(8, Math.round((Math.PI * 2 * r) / 0.3));
      for (let k = 0; k < count; k++) {
        const angle = (k / count) * Math.PI * 2;
        const x = snap(ox + Math.cos(angle) * r);
        const z = snap(oz + Math.sin(angle) * r);
        for (const rotation of [base, base + Math.PI / 2]) {
          if (placementValid(id, x, 0, z, rotation, dims)) return { x, z, rotation };
        }
      }
    }
    // Nothing free: put it at the room center so the shopper can move it; it will read as overlapping.
    const c = polygonCentroid(rooms[0].floorPolygon);
    return { x: snap(c[0]), z: snap(c[1]), rotation: base };
  }

  function remove(id: string) {
    const entry = entries.get(id);
    if (!entry || entry.item.locked) return;
    const out = detach(id);
    if (!out) return;
    pushUndo({ kind: "remove", entry: out.entry, index: out.index });
    emitItems();
  }

  function store(id: string) {
    const entry = entries.get(id);
    if (!entry || entry.item.locked) return;
    const out = detach(id);
    if (!out) return;
    const item = structuredClone(entry.item);
    item.stored = true;
    storedItems.set(id, item);
    // keeps its place in plan order, so the plan and undo stay stable
    order.splice(Math.min(out.index, order.length), 0, id);
    pushUndo({ kind: "store", entry: out.entry, index: out.index });
    emitItems();
  }

  function takeOut(id: string): string | null {
    const stored = storedItems.get(id);
    if (!stored) return null;
    const known = knownSize(stored);
    const dims: Size = known ? ([...known.dims] as Size) : [0.6, 0.6, 0.6];
    const spot = findFreeSpot(id, dims);
    const index = order.indexOf(id);
    storedItems.delete(id);
    if (index >= 0) order.splice(index, 1);
    const item: PlacedItem = { ...structuredClone(stored), position: [spot.x, 0, spot.z], rotationY: spot.rotation, roomId: roomFor(spot.x, spot.z).id };
    delete item.stored;
    const { entry } = createEntry(item);
    attach(entry, index >= 0 ? index : order.length);
    pushUndo({ kind: "takeOut", id, item: stored, index: index >= 0 ? index : order.length - 1 });
    select(id);
    emitItems();
    return id;
  }

  /** Delete key: owned pieces go to the inventory, pieces being bought come out of the basket. */
  function discard(id: string) {
    if (entries.get(id)?.item.origin === "existing_owned") store(id);
    else remove(id);
  }

  function add(request: AddRequest): string {
    const product = request.product;
    const id = newId(product.id);
    const dims: Size = product.dimensions ? ([...product.dimensions] as Size) : [0.6, 0.6, 0.6];
    const spot = findFreeSpot(id, dims, request.at);
    const item = itemFromProduct(product, id, [spot.x, 0, spot.z], spot.rotation, roomFor(spot.x, spot.z).id);
    const { entry, loaded } = createEntry(item);
    attach(entry);
    pushUndo({ kind: "add", id });
    emitItems();
    // A product without listed dimensions only learns its drawn size once the model is in.
    if (!product.dimensions) void loaded.then(() => !disposed && entries.has(id) && emitItems());
    return id;
  }

  function swap(id: string, product: ProductCandidate): string {
    const old = entries.get(id);
    if (!old || old.item.locked) return id;
    const wasSelected = selectedId === id;
    const out = detach(id);
    if (!out) return id;
    const newIdValue = newId(product.id);
    const item = itemFromProduct(product, newIdValue, [...old.item.position] as Vector3Meters, old.item.rotationY, old.item.roomId);
    const { entry, loaded } = createEntry(item);
    attach(entry, out.index);
    pushUndo({ kind: "swap", old: out.entry, newId: newIdValue, index: out.index });
    if (wasSelected) select(newIdValue);
    emitItems();
    if (!product.dimensions) void loaded.then(() => !disposed && entries.has(newIdValue) && emitItems());
    return newIdValue;
  }

  function setTransform(entry: Entry, position: Vector3Meters, rotationY: number) {
    entry.item.position = [...position] as Vector3Meters;
    entry.item.rotationY = rotationY;
    entry.item.roomId = roomFor(position[0], position[2]).id;
    syncEntry(entry);
    labelKey = "";
  }

  function rotate(id: string, radians: number) {
    if (moving?.id === id) {
      moving.rotation += radians;
      moving.checkedKey = "";
      return;
    }
    const entry = entries.get(id);
    if (!entry || entry.item.locked || !radians) return;
    const [x, y, z] = entry.item.position;
    const next = entry.item.rotationY + radians;
    const before = placementValid(id, x, y, z, entry.item.rotationY, entry.dims);
    // Never turn a piece into a wall or into a neighbour it was clear of.
    if (before && !placementValid(id, x, y, z, next, entry.dims)) return;
    if (!before && !insideRoom(x, z, next, entry.dims) && insideRoom(x, z, entry.item.rotationY, entry.dims)) return;
    pushUndo({ kind: "transform", id, position: [...entry.item.position] as Vector3Meters, rotationY: entry.item.rotationY });
    setTransform(entry, entry.item.position, next);
    emitItems();
  }

  function beginMove(id: string) {
    const entry = entries.get(id);
    if (!entry || entry.item.locked) return;
    if (moving) cancelMove();
    select(id);
    moving = {
      id,
      startPosition: [...entry.item.position] as Vector3Meters,
      startRotation: entry.item.rotationY,
      x: entry.item.position[0],
      z: entry.item.position[2],
      rotation: entry.item.rotationY,
      valid: true,
      checkedKey: "",
    };
  }

  function cancelMove() {
    if (!moving) return;
    const entry = entries.get(moving.id);
    const state = moving;
    moving = null;
    footprintMesh.visible = false;
    if (entry) setTransform(entry, state.startPosition, state.startRotation);
    emitItems();
  }

  function confirmMove() {
    if (!moving) return;
    const entry = entries.get(moving.id);
    if (!entry) {
      moving = null;
      return;
    }
    updateMove(true);
    if (!moving.valid) return; // refuses to land overlapping or outside the room
    const state = moving;
    moving = null;
    footprintMesh.visible = false;
    pushUndo({ kind: "transform", id: state.id, position: state.startPosition, rotationY: state.startRotation });
    setTransform(entry, [state.x, 0, state.z], state.rotation);
    emitItems();
  }

  function undo() {
    if (moving) cancelMove();
    const op = undoStack.pop();
    if (!op) return;
    if (op.kind === "add") detach(op.id);
    else if (op.kind === "remove") attach(op.entry, op.index);
    else if (op.kind === "swap") {
      const wasSelected = selectedId === op.newId;
      detach(op.newId);
      attach(op.old, op.index);
      if (wasSelected) select(op.old.item.id);
    } else if (op.kind === "store") {
      const id = op.entry.item.id;
      storedItems.delete(id);
      const at = order.indexOf(id);
      if (at >= 0) order.splice(at, 1);
      attach(op.entry, op.index);
    } else if (op.kind === "takeOut") {
      detach(op.id);
      storedItems.set(op.id, op.item);
      order.splice(Math.min(op.index, order.length), 0, op.id);
    } else {
      const entry = entries.get(op.id);
      if (entry) setTransform(entry, op.position, op.rotationY);
    }
    emitItems();
  }

  function setItemTransform(id: string, x: number, z: number, rotationY: number) {
    const entry = entries.get(id);
    if (!entry) return;
    if (entry.item.locked || !insideRoom(x, z, rotationY, entry.dims)) {
      // The headset layer may have moved the root directly during a grab; snap it back.
      syncEntry(entry);
      itemsDirty = true;
      return;
    }
    const now = performance.now();
    const top = undoStack[undoStack.length - 1];
    // A grab streams many transforms; keep them as one undo step.
    if (top && top.kind === "transform" && top.id === id && (top.coalesceUntil ?? 0) > now) top.coalesceUntil = now + 600;
    else pushUndo({ kind: "transform", id, position: [...entry.item.position] as Vector3Meters, rotationY: entry.item.rotationY, coalesceUntil: now + 600 });
    setTransform(entry, [x, entry.item.position[1], z], rotationY);
    itemsDirty = true;
  }

  // ------------------------------------------------------------ move preview
  function updateMove(force = false) {
    if (!moving) return;
    const entry = entries.get(moving.id);
    if (!entry) return;
    raycaster.setFromCamera(usesCenter() ? center : mouse, camera);
    if (raycaster.ray.intersectPlane(floorPlane, tmpA)) {
      camera.getWorldPosition(tmpB);
      // Keep the piece within reach when looking toward the horizon.
      const dx = tmpA.x - tmpB.x;
      const dz = tmpA.z - tmpB.z;
      const reach = Math.hypot(dx, dz);
      const max = mode === "orbit" ? 60 : 6;
      if (reach > max) tmpA.set(tmpB.x + (dx / reach) * max, 0, tmpB.z + (dz / reach) * max);
      moving.x = Math.round(tmpA.x / GRID) * GRID;
      moving.z = Math.round(tmpA.z / GRID) * GRID;
    }
    const key = `${moving.x.toFixed(3)},${moving.z.toFixed(3)},${moving.rotation.toFixed(4)},${entry.dims.join(",")}`;
    if (force || key !== moving.checkedKey) {
      moving.checkedKey = key;
      moving.valid = placementValid(moving.id, moving.x, 0, moving.z, moving.rotation, entry.dims);
    }
    entry.root.position.set(moving.x, 0, moving.z);
    entry.root.rotation.y = moving.rotation;
    footprintMesh.visible = true;
    footprintMesh.position.set(moving.x, 0.006, moving.z);
    footprintMesh.rotation.y = moving.rotation;
    footprintMesh.scale.set(entry.dims[0], 1, entry.dims[2]);
    footprintMaterial.color.set(moving.valid ? VALID : INVALID);
  }

  // ------------------------------------------------------------ input
  function requestLock() {
    if (disposed || mode !== "walk" || renderer.xr.isPresenting || document.pointerLockElement === canvas) return;
    try {
      const result = canvas.requestPointerLock() as unknown;
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // Pointer lock can be refused (iframe, no user gesture); drag-look still works.
    }
  }

  function onLockChange() {
    const locked = document.pointerLockElement === canvas;
    if (locked === pointerLocked) return;
    pointerLocked = locked;
    if (!locked) keys.clear();
    callbacks.onModeChange?.(mode, pointerLocked);
  }

  function onMouseMove(event: MouseEvent) {
    if (!pointerLocked || mode !== "walk") return;
    yaw -= event.movementX * LOOK_SPEED;
    pitch = THREE.MathUtils.clamp(pitch - event.movementY * LOOK_SPEED, -1.45, 1.45);
  }

  let press: { x: number; y: number; id: number; lastX: number; lastY: number; dragged: boolean } | null = null;
  function setMouse(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    mouse.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    mouseOnCanvas = true;
  }
  function onPointerDown(event: PointerEvent) {
    if (!event.isPrimary || renderer.xr.isPresenting) return;
    setMouse(event);
    press = { x: event.clientX, y: event.clientY, id: event.pointerId, lastX: event.clientX, lastY: event.clientY, dragged: false };
  }
  function onPointerMove(event: PointerEvent) {
    if (!event.isPrimary) return;
    if (!pointerLocked) setMouse(event);
    if (!press || press.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6) press.dragged = true;
    // Unlocked walk mode: drag to look (touch and trackpads).
    if (mode === "walk" && !pointerLocked && press.dragged && !moving) {
      yaw += (event.clientX - press.lastX) * DRAG_LOOK_SPEED;
      pitch = THREE.MathUtils.clamp(pitch + (event.clientY - press.lastY) * DRAG_LOOK_SPEED, -1.45, 1.45);
    }
    press.lastX = event.clientX;
    press.lastY = event.clientY;
  }
  function onPointerUp(event: PointerEvent) {
    const start = press;
    press = null;
    if (!start || start.id !== event.pointerId || start.dragged || event.button !== 0 || renderer.xr.isPresenting) return;
    if (moving) {
      confirmMove();
      return;
    }
    if (mode === "walk" && pointerLocked) {
      select(pickAt(center));
      return;
    }
    setMouse(event);
    const hit = pickAt(mouse);
    select(hit);
    if (!hit && mode === "walk") requestLock();
  }
  function onPointerLeave() {
    mouseOnCanvas = false;
    hoverId = null;
  }
  function onPointerCancel() {
    press = null;
  }

  const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);
  function onKeyDown(event: KeyboardEvent) {
    if (disposed || isEditable(event.target)) return;
    if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ" && !event.shiftKey) {
      event.preventDefault();
      undo();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (MOVE_KEYS.has(event.code)) {
      if (mode === "walk" && !renderer.xr.isPresenting) {
        keys.add(event.code);
        if (event.code.startsWith("Arrow")) event.preventDefault();
      }
      return;
    }
    const target = moving?.id ?? selectedId;
    switch (event.code) {
      case "KeyQ":
        if (target) rotate(target, -TURN_STEP);
        break;
      case "KeyE":
        if (target) rotate(target, TURN_STEP);
        break;
      case "KeyR":
        if (target) rotate(target, Math.PI / 4);
        break;
      case "KeyG":
        if (!event.repeat && selectedId && !moving) beginMove(selectedId);
        break;
      case "Enter":
      case "NumpadEnter":
        if (moving) {
          event.preventDefault();
          confirmMove();
        }
        break;
      case "Escape":
        if (moving) cancelMove();
        else if (selectedId) select(null);
        break;
      case "Delete":
      case "Backspace":
        if (selectedId && !event.repeat) {
          event.preventDefault();
          discard(selectedId);
        }
        break;
    }
  }
  function onKeyUp(event: KeyboardEvent) {
    keys.delete(event.code);
  }
  function onBlur() {
    keys.clear();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("pointerleave", onPointerLeave);
  document.addEventListener("pointerlockchange", onLockChange);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  const previousTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";

  // ------------------------------------------------------------ modes
  function setMode(next: WalkMode) {
    if (disposed || next === mode) return;
    if (next === "orbit" && renderer.xr.isPresenting) return;
    if (moving) cancelMove();
    mode = next;
    keys.clear();
    velocity.set(0, 0, 0);
    hoverId = null;
    if (next === "orbit") {
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      savedRig.copy(rig.position);
      rig.position.set(0, 0, 0);
      rig.rotation.set(0, 0, 0);
      camera.rotation.set(0, 0, 0);
      camera.fov = ORBIT_FOV;
      camera.near = 0.1;
      camera.updateProjectionMatrix();
      controls.enabled = true;
      fitOrbit();
    } else {
      controls.enabled = false;
      rig.position.copy(savedRig);
      rig.rotation.set(0, yaw, 0);
      camera.position.set(0, 0, 0);
      camera.rotation.set(pitch, 0, 0);
      camera.fov = WALK_FOV;
      camera.near = 0.05;
      camera.updateProjectionMatrix();
    }
    applyWallMode();
    callbacks.onModeChange?.(mode, pointerLocked);
  }

  // ------------------------------------------------------------ XR
  function onSessionStart() {
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    keys.clear();
    velocity.set(0, 0, 0);
    hoverId = null;
    // The headset supplies eye height, so the rig stands on the floor.
    rig.position.y = 0;
    camera.position.set(0, 0, 0);
    camera.rotation.set(0, 0, 0);
    crosshair.visible = false;
  }
  function onSessionEnd() {
    xrSession = null;
    yaw = rig.rotation.y;
    rig.position.y = EYE_HEIGHT;
    camera.position.set(0, 0, 0);
    camera.rotation.set(pitch, 0, 0);
    camera.fov = WALK_FOV;
    camera.updateProjectionMatrix();
    resize();
    callbacks.onModeChange?.(mode, pointerLocked);
  }
  renderer.xr.addEventListener("sessionstart", onSessionStart);
  renderer.xr.addEventListener("sessionend", onSessionEnd);

  async function xrSupported() {
    try {
      return (await navigator.xr?.isSessionSupported("immersive-vr")) ?? false;
    } catch {
      return false;
    }
  }

  async function enterXR() {
    if (disposed || renderer.xr.isPresenting) return;
    if (!navigator.xr) {
      callbacks.onError("This browser cannot open a headset session.");
      return;
    }
    if (mode !== "walk") setMode("walk");
    try {
      const session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: XR_FEATURES });
      if (disposed) {
        await session.end().catch(() => {});
        return;
      }
      xrSession = session;
      await renderer.xr.setSession(session);
    } catch (cause) {
      xrSession = null;
      if (!disposed) callbacks.onError(cause instanceof Error ? `The headset session could not start: ${cause.message}` : "The headset session could not start.");
    }
  }

  const core: WalkCore = {
    renderer,
    scene,
    camera,
    rig,
    pickables() {
      if (pickDirty) rebuildPicks();
      return pickRoots;
    },
    floors: () => floorMeshes,
    collide(from, to) {
      // In XR the rig stands on the floor and the head drifts inside it; collide the head, return rig coords.
      let ox = 0;
      let oz = 0;
      if (renderer.xr.isPresenting) {
        camera.getWorldPosition(tmpC);
        ox = tmpC.x - rig.position.x;
        oz = tmpC.z - rig.position.z;
      }
      tmpA.set(from.x + ox, from.y, from.z + oz);
      tmpB.set(to.x + ox, to.y, to.z + oz);
      const out = collideInto(tmpA, tmpB, new THREE.Vector3());
      out.x -= ox;
      out.z -= oz;
      return out;
    },
    select,
    selectedId: () => selectedId,
    remove,
    rotate,
    setItemTransform,
    itemInfo(id) {
      const entry = entries.get(id);
      return entry ? toWalkItem(entry) : null;
    },
  };

  // ------------------------------------------------------------ frame
  function updateWalk(dt: number) {
    let forward = 0;
    let strafe = 0;
    if (keys.has("KeyW") || keys.has("ArrowUp")) forward += 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) forward -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) strafe += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) strafe -= 1;
    const speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? FAST_SPEED : WALK_SPEED;
    const length = Math.hypot(forward, strafe) || 1;
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    // forward is -z in the rig's frame
    const tx = ((-s * forward + c * strafe) / length) * speed;
    const tz = ((-c * forward - s * strafe) / length) * speed;
    if (reduced) velocity.set(tx, 0, tz);
    else {
      velocity.x = THREE.MathUtils.damp(velocity.x, tx, 10, dt);
      velocity.z = THREE.MathUtils.damp(velocity.z, tz, 10, dt);
    }
    if (Math.abs(velocity.x) + Math.abs(velocity.z) > 1e-4) {
      desired.set(rig.position.x + velocity.x * dt, rig.position.y, rig.position.z + velocity.z * dt);
      collideInto(rig.position, desired, tmpA);
      rig.position.x = tmpA.x;
      rig.position.z = tmpA.z;
    }
    rig.rotation.y = yaw;
    camera.rotation.set(pitch, 0, 0);
  }

  function updateOrbitWalls() {
    camera.getWorldPosition(tmpA);
    for (const wall of wallViews) {
      const near = wall.interior || wall.outward.dot(tmpB.copy(tmpA).sub(wall.midpoint)) > 0;
      for (const material of wall.materials) {
        material.opacity = near ? 0.075 : 1;
        material.depthWrite = !near;
      }
      for (const mesh of wall.meshes) mesh.castShadow = !near;
    }
  }

  function placeOutline(line: THREE.LineSegments, entry: Entry) {
    line.visible = true;
    line.position.copy(entry.root.position);
    line.position.y -= 0.01;
    line.rotation.y = entry.root.rotation.y;
    line.scale.set(entry.dims[0] + 0.04, entry.dims[1] + 0.02, entry.dims[2] + 0.04);
  }

  function updateOverlays() {
    const presenting = renderer.xr.isPresenting;
    crosshair.visible = !presenting && mode === "walk" && pointerLocked;
    if (crosshair.visible) {
      crosshair.scale.setScalar(hoverId ? 1.6 : 1);
      crosshairMaterial.color.set(hoverId ? ACCENT : INK);
    }
    const hovered = hoverId && hoverId !== selectedId ? entries.get(hoverId) : null;
    if (hovered) placeOutline(hoverOutline, hovered);
    else hoverOutline.visible = false;

    const selected = selectedId ? entries.get(selectedId) : null;
    if (!selected) {
      selectionOutline.visible = false;
      panel.mesh.visible = false;
      return;
    }
    placeOutline(selectionOutline, selected);
    (selectionOutline.material as THREE.LineBasicMaterial).color.set(moving && !moving.valid ? INVALID : ACCENT);

    const [w, h, d] = selected.dims;
    const key = `${selected.item.label}|${w}|${h}|${d}|${selected.source}`;
    if (key !== labelKey) {
      labelKey = key;
      panel.draw([
        { text: selected.source === "model" ? `${selected.item.label} · model bounds` : selected.item.label, size: 26, muted: true },
        { text: `${Math.round(w * 100)} x ${Math.round(d * 100)} x ${Math.round(h * 100)} cm`, size: 46 },
        { text: `${inches(w)} x ${inches(d)} x ${inches(h)} in`, size: 28, muted: true },
      ]);
    }
    panel.mesh.visible = true;
    panel.mesh.position.set(selected.root.position.x, selected.root.position.y + h + 0.22, selected.root.position.z);
    camera.getWorldPosition(tmpA);
    camera.getWorldQuaternion(tmpQ);
    panel.mesh.quaternion.copy(tmpQ);
    const distance = tmpA.distanceTo(panel.mesh.position);
    panel.mesh.scale.setScalar(THREE.MathUtils.clamp(distance / 2.5, 0.7, mode === "orbit" ? 4 : 1.8));

    if (!presenting && callbacks.onAnchor) {
      const anchor = anchorFor(selected);
      const same = anchor && lastAnchor ? Math.abs(anchor.x - lastAnchor.x) < 0.5 && Math.abs(anchor.y - lastAnchor.y) < 0.5 : anchor === lastAnchor;
      if (!same) lastAnchor = anchor;
      callbacks.onAnchor(lastAnchor);
    }
  }

  let last = performance.now();
  function frame(time: number) {
    if (disposed) return;
    const dt = Math.min(0.1, Math.max(0, (time - last) / 1000));
    last = time;
    const presenting = renderer.xr.isPresenting;
    if (!presenting && mode === "walk") updateWalk(dt);
    if (mode === "orbit") {
      controls.update();
      updateOrbitWalls();
    }
    try {
      xr?.update(dt);
    } catch {
      // A headset layer fault must not stop the room from drawing.
    }
    if (moving) updateMove();
    if (!presenting) hoverId = mouseOnCanvas || pointerLocked || mode === "walk" ? pickAt(usesCenter() ? center : mouse) : null;
    updateOverlays();
    if (itemsDirty) emitItems();
    renderer.render(scene, camera);
  }

  applyWallMode();
  renderer.setAnimationLoop(frame);

  if (options.attachXR) {
    try {
      xr = options.attachXR(core);
    } catch (cause) {
      xr = null;
      callbacks.onError(cause instanceof Error ? cause.message : "The headset controls could not start.");
    }
  }

  const ready = Promise.all([Promise.all(initialLoads), lighting.ready, envLoad])
    .then(() => {
      if (disposed) return;
      pickDirty = true;
      callbacks.onReady(listItems());
      callbacks.onModeChange?.(mode, pointerLocked);
    })
    .catch(() => {
      if (!disposed) callbacks.onError("The room could not be prepared. Refresh to try again.");
    });

  function dispose() {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null);
    if (xrSession) xrSession.end().catch(() => {});
    xrSession = null;
    try {
      xr?.dispose();
    } catch {
      // ignore headset layer teardown faults
    }
    xr = null;
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    resizeObserver.disconnect();
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerCancel);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    document.removeEventListener("pointerlockchange", onLockChange);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    renderer.xr.removeEventListener("sessionstart", onSessionStart);
    renderer.xr.removeEventListener("sessionend", onSessionEnd);
    canvas.style.touchAction = previousTouchAction;
    controls.dispose();
    lighting.dispose();
    const roots: THREE.Object3D[] = [scene, ...allRoots];
    for (const op of undoStack) {
      if (op.kind === "remove") roots.push(op.entry.root);
      if (op.kind === "swap") roots.push(op.old.root);
    }
    releaseAll(roots);
    outlineGeometry.dispose();
    sun.shadow.dispose();
    renderer.xr.dispose?.();
    renderer.dispose();
    entries.clear();
    allRoots.clear();
    gltfCache.clear();
    undoStack.length = 0;
  }

  return {
    ready,
    getPlan() {
      const out = structuredClone(working);
      out.items = order.flatMap((id) => {
        const stored = storedItems.get(id);
        if (stored) return [structuredClone(stored)];
        const entry = entries.get(id);
        if (!entry) return [];
        const item = structuredClone(entry.item);
        // Model-bounds sizes are not plan evidence; keep them out of the plan.
        item.dimensions = entry.source === "model" ? item.dimensions : ([...entry.dims] as Vector3Meters);
        return [item];
      });
      return out;
    },
    select,
    remove,
    store,
    takeOut,
    add,
    swap,
    rotate,
    beginMove,
    confirmMove,
    cancelMove,
    undo,
    canUndo: () => undoStack.length > 0,
    setMode,
    lockPointer: requestLock,
    xrSupported,
    enterXR,
    dispose,
  };
}
