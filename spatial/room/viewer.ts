import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { PlacedItem, PointXZ, RoomPlan, Vector3Meters } from "@/backend/contracts";
import { describeChange, diffPlans, dimensionSource, footprint, footprintInside, polygonCentroid, wallLength } from "./plan";
import {
  CHANGE,
  HOVER_FILL,
  INK,
  PAPER,
  PICKED_FILL,
  contours,
  dashedLine,
  disposeTree,
  floorLoop,
  inkEdges,
  inkLine,
  segments,
  sheet,
} from "./pencil";
import { createPanel, disposeLockTexture, lockBadge, type PanelLine } from "./labels";

// renders a RoomPlan. the plan is the only source of geometry and placement; the
// viewer keeps hover, camera, a local drag preview, and the headset alignment.
// it never writes the plan. a preview becomes real only when the parent accepts
// a proposal and hands back a new revision.

export type RenderKind = "loading" | "model" | "proxy" | "marker";

export interface ItemRenderState {
  kind: RenderKind;
  /** The model URL failed, so a proxy or marker is shown instead. */
  failed: boolean;
  /** Bounds of the drawn model in meters (w, h, d). Visual only, never a product size. */
  meshSize: Vector3Meters | null;
}

export interface PlacementPreview {
  itemId: string;
  baseRevision: number;
  position: Vector3Meters;
  rotationY: number;
  /** Footprint inside the room outline at the best known size; null when no size is known. */
  insideRoom: boolean | null;
}

export type XRMode = "immersive-vr" | "immersive-ar";
export type Alignment = "default" | "pick-corner" | "pick-wall" | "aligned";

export interface XRStatus {
  presenting: boolean;
  mode: XRMode | null;
  alignment: Alignment;
}

export type Axis = "width" | "depth" | "height";

export interface OverlayFrame {
  itemId: string;
  tag: { x: number; y: number };
  labels: Array<{ axis: Axis; x: number; y: number }>;
}

export interface ViewerEvents {
  select(id: string | null): void;
  hover(id: string | null): void;
  preview(preview: PlacementPreview | null): void;
  items(states: Record<string, ItemRenderState>): void;
  xr(status: XRStatus): void;
  overlay(frame: OverlayFrame | null): void;
}

interface ItemView {
  item: PlacedItem;
  key: string;
  root: THREE.Group;
  body: THREE.Group | null;
  decor: THREE.Group;
  fill: THREE.MeshBasicMaterial;
  line: THREE.LineBasicMaterial;
  /** Local bounds of the drawn body, in the item's own frame. */
  box: THREE.Box3;
  state: ItemRenderState;
  anchors: Array<{ axis: Axis; object: THREE.Object3D }>;
  removed: boolean;
}

interface WallView {
  full: THREE.Group;
  stub: THREE.Group;
  mid: THREE.Vector3;
  normal: THREE.Vector3;
}

const STUB = 0.16; // cutaway wall height, meters
const SNAP = 0.01;
const XR_FEATURES = ["local-floor", "bounded-floor", "hand-tracking", "layers"];

const cm = (m: number) => Math.round(m * 100);
const noRaycast = () => {};
const round = (v: number, step: number) => Math.round(v / step) * step;

const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

export function createViewer(
  canvas: HTMLCanvasElement,
  events: ViewerEvents,
  { lite = false }: { lite?: boolean } = {},
) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lite ? 1.5 : 2));
  renderer.setClearColor(PAPER, 1);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  // softer foveation keeps panel text sharp toward the edges of the lens
  renderer.xr.setFoveation(0.5);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAPER);
  const world = new THREE.Group();
  const shell = new THREE.Group();
  const itemsGroup = new THREE.Group();
  const ghosts = new THREE.Group();
  world.add(shell, itemsGroup, ghosts);
  scene.add(world);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.03, 60);

  // our pointer handlers must be registered before OrbitControls connects, so a
  // drag that starts on the selected item can stop the orbit from starting
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("pointerleave", onLeave);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 1.2;
  controls.maxDistance = 16;
  controls.screenSpacePanning = false;

  let plan: RoomPlan | null = null;
  let previous: RoomPlan | null = null;
  let showChanges = true;
  let selectedId: string | null = null;
  let hoveredId: string | null = null;
  let editable = false;
  let preview: PlacementPreview | null = null;
  let shellKey = "";
  let framed = false;
  let disposed = false;
  let visible = true;
  let looping = false;

  const views = new Map<string, ItemView>();
  const walls: WallView[] = [];
  const floors: THREE.Object3D[] = [];
  const templates = new Map<string, Promise<THREE.Group>>();

  // ---------------------------------------------------------------- models

  function loadTemplate(url: string) {
    let pending = templates.get(url);
    if (!pending) {
      pending = gltf.loadAsync(url).then(({ scene: model }) => {
        const lights: THREE.Object3D[] = [];
        model.traverse((o) => {
          if ((o as THREE.Light).isLight) lights.push(o);
        });
        for (const l of lights) l.removeFromParent();
        // glb origins vary, so recentre each model on its footprint with its base at y = 0
        const box = new THREE.Box3().setFromObject(model);
        const c = box.getCenter(new THREE.Vector3());
        model.position.set(-c.x, -box.min.y, -c.z);
        const out = new THREE.Group();
        out.add(model);
        out.updateMatrixWorld(true);
        return out;
      });
      pending.catch(() => templates.delete(url));
      templates.set(url, pending);
    }
    return pending;
  }

  function modelBody(template: THREE.Group, view: ItemView) {
    const body = template.clone(true);
    body.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.material = view.fill;
        o.userData.sharedGeometry = true; // the cached template owns it
      }
    });
    inkEdges(body, view.line, 45);
    if (!lite) contours(body);
    return body;
  }

  function proxyBody(size: Vector3Meters, view: ItemView) {
    const [w, h, d] = size;
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(0, h / 2, 0);
    const box = new THREE.Mesh(geo, view.fill);
    const body = new THREE.Group();
    body.add(box);
    // dashed edges say "this is a sized stand-in, not the product's model"
    inkEdges(body, dashedLine(0.9, INK, 0.05), 20);
    // a front tick so the facing direction reads on a plain box
    body.add(segments([new THREE.Vector3(-w * 0.2, 0.01, d / 2 + 0.002), new THREE.Vector3(w * 0.2, 0.01, d / 2 + 0.002)], inkLine(0.9)));
    return body;
  }

  function markerBody(view: ItemView) {
    const body = new THREE.Group();
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 10).translate(0, 0.25, 0), view.fill);
    body.add(post);
    const ring: PointXZ[] = [];
    for (let i = 0; i < 24; i++) ring.push([Math.cos((i / 24) * Math.PI * 2) * 0.2, Math.sin((i / 24) * Math.PI * 2) * 0.2]);
    body.add(floorLoop(ring, dashedLine(0.9, INK, 0.04)));
    inkEdges(body, view.line, 30);
    return body;
  }

  function knownSize(item: PlacedItem): Vector3Meters | null {
    if (!plan) return null;
    const source = dimensionSource(plan, item);
    return source.kind === "unknown" ? null : source.size;
  }

  function itemKey(item: PlacedItem) {
    return item.assetUrl ? `asset:${item.assetUrl}` : `size:${JSON.stringify(knownSize(item))}`;
  }

  function setBody(view: ItemView, body: THREE.Group, kind: RenderKind, failed: boolean) {
    if (view.removed) {
      disposeTree(body);
      return;
    }
    if (view.body) {
      view.root.remove(view.body);
      disposeTree(view.body, new Set([view.fill, view.line]));
    }
    view.body = body;
    body.updateMatrixWorld(true);
    view.box = new THREE.Box3().setFromObject(body);
    view.root.add(body);
    const size = view.box.getSize(new THREE.Vector3());
    view.state = { kind, failed, meshSize: kind === "model" ? [size.x, size.y, size.z] : null };
    rebuildDecor(view);
    rebuildGhosts();
    emitItems();
  }

  function fallbackBody(view: ItemView, failed: boolean) {
    const size = knownSize(view.item);
    if (size) setBody(view, proxyBody(size, view), "proxy", failed);
    else setBody(view, markerBody(view), "marker", failed);
  }

  function createView(item: PlacedItem): ItemView {
    const root = new THREE.Group();
    root.userData.itemId = item.id;
    const decor = new THREE.Group();
    root.add(decor);
    itemsGroup.add(root);
    const view: ItemView = {
      item,
      key: itemKey(item),
      root,
      body: null,
      decor,
      fill: sheet(),
      line: inkLine(0.6),
      box: new THREE.Box3(new THREE.Vector3(-0.2, 0, -0.2), new THREE.Vector3(0.2, 0.4, 0.2)),
      state: { kind: "loading", failed: false, meshSize: null },
      anchors: [],
      removed: false,
    };
    if (item.assetUrl) {
      loadTemplate(item.assetUrl).then(
        (template) => !view.removed && setBody(view, modelBody(template, view), "model", false),
        () => !view.removed && fallbackBody(view, true),
      );
    } else {
      fallbackBody(view, false);
    }
    return view;
  }

  function removeView(view: ItemView) {
    view.removed = true;
    itemsGroup.remove(view.root);
    disposeTree(view.root);
    views.delete(view.item.id);
  }

  function emitItems() {
    const out: Record<string, ItemRenderState> = {};
    for (const [id, v] of views) out[id] = v.state;
    events.items(out);
  }

  // ---------------------------------------------------------------- shell

  function buildShell(next: RoomPlan) {
    disposeTree(shell);
    shell.clear();
    walls.length = 0;
    floors.length = 0;
    const geometry = next.geometry;
    const wallLine = inkLine(0.5);
    const centroid = geometry.rooms[0] ? polygonCentroid(geometry.rooms[0].floorPolygon) : ([0, 0] as PointXZ);

    for (const room of geometry.rooms) {
      if (room.floorPolygon.length < 3) continue;
      const shape = new THREE.Shape(room.floorPolygon.map(([x, z]) => new THREE.Vector2(x, z)));
      const floorGeo = new THREE.ShapeGeometry(shape);
      floorGeo.rotateX(Math.PI / 2); // shape (x, z) onto the floor plane
      const floor = new THREE.Mesh(floorGeo, sheet());
      floor.userData.noEdges = true;
      floor.raycast = noRaycast;
      shell.add(floor);
      floors.push(floor);
      shell.add(floorLoop(room.floorPolygon, inkLine(0.85), 0.003));

      // metric grid across the room's bounds: faint every 50 cm, stronger every meter
      const xs = room.floorPolygon.map((p) => p[0]);
      const zs = room.floorPolygon.map((p) => p[1]);
      const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
      const fine: THREE.Vector3[] = [];
      const major: THREE.Vector3[] = [];
      for (let x = Math.ceil(x0 / 0.5) * 0.5; x <= x1 + 1e-6; x += 0.5) {
        (Math.abs(x - Math.round(x)) < 1e-6 ? major : fine).push(new THREE.Vector3(x, 0.002, z0), new THREE.Vector3(x, 0.002, z1));
      }
      for (let z = Math.ceil(z0 / 0.5) * 0.5; z <= z1 + 1e-6; z += 0.5) {
        (Math.abs(z - Math.round(z)) < 1e-6 ? major : fine).push(new THREE.Vector3(x0, 0.002, z), new THREE.Vector3(x1, 0.002, z));
      }
      if (fine.length) shell.add(segments(fine, inkLine(0.07)));
      if (major.length) shell.add(segments(major, inkLine(0.16)));
    }

    for (const wall of geometry.walls) {
      const length = wallLength(wall);
      if (length < 0.05) continue;
      const dir = new THREE.Vector3(wall.end[0] - wall.start[0], 0, wall.end[1] - wall.start[1]).normalize();
      const mid = new THREE.Vector3((wall.start[0] + wall.end[0]) / 2, 0, (wall.start[1] + wall.end[1]) / 2);
      const normal = new THREE.Vector3(dir.z, 0, -dir.x);
      if (normal.x * (mid.x - centroid[0]) + normal.z * (mid.z - centroid[1]) < 0) normal.negate();
      const t = wall.thickness;
      // extend into the corner this wall ends at, so outward-offset walls meet
      const joins = geometry.walls.some((w) => w !== wall && Math.hypot(w.start[0] - wall.end[0], w.start[1] - wall.end[1]) < 1e-3);
      const reach = length + (joins ? t : 0);
      const angle = Math.atan2(-dir.z, dir.x);
      const full = new THREE.Group();
      const stub = new THREE.Group();
      const fill = sheet();
      const piece = (group: THREE.Group, a: number, b: number, y0: number, y1: number) => {
        if (b - a < 0.002 || y1 - y0 < 0.002) return;
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(b - a, y1 - y0, t), fill);
        const along = (a + b) / 2;
        mesh.position.set(
          wall.start[0] + dir.x * along + normal.x * (t / 2),
          (y0 + y1) / 2,
          wall.start[1] + dir.z * along + normal.z * (t / 2),
        );
        mesh.rotation.y = angle;
        mesh.raycast = noRaycast;
        group.add(mesh);
      };
      const cuts = geometry.openings
        .filter((o) => o.wallId === wall.id)
        .sort((a, b) => a.offset - b.offset);
      for (const [group, top] of [
        [full, wall.height],
        [stub, Math.min(STUB, wall.height)],
      ] as const) {
        let cursor = 0;
        for (const o of cuts) {
          const a = Math.max(cursor, o.offset);
          const b = Math.min(length, o.offset + o.width);
          piece(group, cursor, a, 0, top);
          piece(group, a, b, 0, Math.min(o.sillHeight, top));
          piece(group, a, b, Math.min(o.sillHeight + o.height, top), top);
          cursor = Math.max(cursor, b);
        }
        piece(group, cursor, reach, 0, top);
      }
      inkEdges(full, wallLine, 20);
      inkEdges(stub, wallLine, 20);
      shell.add(full, stub);
      walls.push({ full, stub, mid, normal });
    }
  }

  // ---------------------------------------------------------------- decor

  function sizeFor(view: ItemView) {
    const known = knownSize(view.item);
    if (known) return { size: known, measured: true };
    const s = view.box.getSize(new THREE.Vector3());
    return { size: [s.x, s.y, s.z] as Vector3Meters, measured: false };
  }

  function rebuildDecor(view: ItemView) {
    disposeTree(view.decor);
    view.decor.clear();
    view.anchors = [];
    const selected = view.item.id === selectedId;
    const hovered = view.item.id === hoveredId;
    view.fill.color.set(selected ? PICKED_FILL : hovered ? HOVER_FILL : PAPER);
    view.line.opacity = selected ? 1 : hovered ? 0.85 : 0.6;
    const { size, measured } = sizeFor(view);
    const [w, h, d] = size;
    const top = Math.max(h, view.box.max.y);

    if (view.item.locked) {
      const badge = lockBadge(0.15);
      badge.position.set(0, top + 0.16, 0);
      view.decor.add(badge);
      view.decor.add(
        floorLoop(
          [
            [-w / 2, -d / 2],
            [w / 2, -d / 2],
            [w / 2, d / 2],
            [-w / 2, d / 2],
          ],
          dashedLine(0.75, INK, 0.05),
          0.006,
        ),
      );
    }

    if (!selected) return;

    // outline of what is drawn
    const b = view.box.clone().expandByScalar(0.015);
    const outlineGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(...b.getSize(new THREE.Vector3()).toArray()));
    const outline = new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({ color: INK, depthTest: false, transparent: true, opacity: 0.9 }));
    outline.position.copy(b.getCenter(new THREE.Vector3()));
    outline.renderOrder = 10;
    outline.raycast = noRaycast;
    view.decor.add(outline);

    // dimension lines at the best known physical size; dashed when only the model's bounds are known
    const mat = measured ? new THREE.LineBasicMaterial({ color: INK, depthTest: false }) : dashedLine(1, INK, 0.035);
    mat.depthTest = false;
    const gap = 0.12;
    const tick = 0.05;
    const pts: THREE.Vector3[] = [];
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const y0 = 0.012;
    // width along the front edge
    pts.push(v(-w / 2, y0, d / 2 + gap), v(w / 2, y0, d / 2 + gap));
    pts.push(v(-w / 2, y0, d / 2 + gap - tick), v(-w / 2, y0, d / 2 + gap + tick));
    pts.push(v(w / 2, y0, d / 2 + gap - tick), v(w / 2, y0, d / 2 + gap + tick));
    // depth along the right edge
    pts.push(v(w / 2 + gap, y0, -d / 2), v(w / 2 + gap, y0, d / 2));
    pts.push(v(w / 2 + gap - tick, y0, -d / 2), v(w / 2 + gap + tick, y0, -d / 2));
    pts.push(v(w / 2 + gap - tick, y0, d / 2), v(w / 2 + gap + tick, y0, d / 2));
    // height up the front right corner
    pts.push(v(w / 2 + gap, 0, d / 2 + gap), v(w / 2 + gap, h, d / 2 + gap));
    pts.push(v(w / 2 + gap - tick, h, d / 2 + gap), v(w / 2 + gap + tick, h, d / 2 + gap));
    const dims = segments(pts, mat);
    dims.renderOrder = 11;
    view.decor.add(dims);
    const anchor = (axis: Axis, x: number, y: number, z: number) => {
      const o = new THREE.Object3D();
      o.position.set(x, y, z);
      view.decor.add(o);
      view.anchors.push({ axis, object: o });
    };
    anchor("width", 0, y0, d / 2 + gap);
    anchor("depth", w / 2 + gap, y0, 0);
    anchor("height", w / 2 + gap, h / 2, d / 2 + gap);
    const tagAnchor = new THREE.Object3D();
    tagAnchor.position.set(0, top + 0.18, 0);
    tagAnchor.name = "tag";
    view.decor.add(tagAnchor);
  }

  function rebuildAllDecor() {
    for (const v of views.values()) rebuildDecor(v);
  }

  // ---------------------------------------------------------------- ghosts

  function ghostSize(source: RoomPlan, item: PlacedItem): [number, number] {
    const s = dimensionSource(source, item);
    if (s.kind !== "unknown") return [s.size[0], s.size[2]];
    const view = views.get(item.id);
    if (view?.body) {
      const v = view.box.getSize(new THREE.Vector3());
      return [v.x, v.z];
    }
    return [0.5, 0.5];
  }

  function rebuildGhosts() {
    disposeTree(ghosts);
    ghosts.clear();
    if (!plan) return;

    // the original spot of a piece being dragged, so the move reads as a preview
    if (preview) {
      const item = plan.items.find((i) => i.id === preview!.itemId);
      if (item) {
        const [w, d] = ghostSize(plan, item);
        ghosts.add(floorLoop(footprint(item.position, item.rotationY, w, d), dashedLine(0.8, INK, 0.05), 0.008));
        ghosts.add(
          segments(
            [new THREE.Vector3(item.position[0], 0.008, item.position[2]), new THREE.Vector3(preview.position[0], 0.008, preview.position[2])],
            dashedLine(0.8, INK, 0.05),
          ),
        );
      }
    }

    if (!previous || !showChanges) return;
    for (const change of diffPlans(previous, plan).changes) {
      if (change.kind === "removed") {
        const [w, d] = ghostSize(previous, change.item);
        const corners = footprint(change.item.position, change.item.rotationY, w, d);
        ghosts.add(floorLoop(corners, dashedLine(1, CHANGE, 0.06), 0.009));
        ghosts.add(
          segments(
            [
              new THREE.Vector3(corners[0][0], 0.009, corners[0][1]),
              new THREE.Vector3(corners[2][0], 0.009, corners[2][1]),
              new THREE.Vector3(corners[1][0], 0.009, corners[1][1]),
              new THREE.Vector3(corners[3][0], 0.009, corners[3][1]),
            ],
            inkLine(0.9, CHANGE),
          ),
        );
        continue;
      }
      const [w, d] = ghostSize(plan, change.item);
      ghosts.add(floorLoop(footprint(change.item.position, change.item.rotationY, w + 0.06, d + 0.06), inkLine(1, CHANGE), 0.01));
      if (change.kind === "changed" && (change.moved || change.rotated)) {
        const [bw, bd] = ghostSize(previous, change.before);
        ghosts.add(floorLoop(footprint(change.before.position, change.before.rotationY, bw, bd), dashedLine(1, CHANGE, 0.06), 0.009));
        ghosts.add(
          segments(
            [
              new THREE.Vector3(change.before.position[0], 0.01, change.before.position[2]),
              new THREE.Vector3(change.item.position[0], 0.01, change.item.position[2]),
            ],
            dashedLine(1, CHANGE, 0.05),
          ),
        );
      }
    }
  }

  // ---------------------------------------------------------------- placement

  function placementOf(view: ItemView) {
    if (preview && preview.itemId === view.item.id) return { position: preview.position, rotationY: preview.rotationY };
    return { position: view.item.position, rotationY: view.item.rotationY };
  }

  function applyTransform(view: ItemView) {
    const { position, rotationY } = placementOf(view);
    view.root.position.set(position[0], position[1], position[2]);
    view.root.rotation.set(0, rotationY, 0);
  }

  function insideRoom(item: PlacedItem, position: Vector3Meters, rotationY: number) {
    if (!plan) return null;
    const room = plan.geometry.rooms.find((r) => r.id === item.roomId);
    const size = knownSize(item);
    if (!room || !size) return null;
    return footprintInside(footprint(position, rotationY, size[0], size[2]), room.floorPolygon);
  }

  function setPreview(itemId: string, position: Vector3Meters, rotationY: number) {
    if (!plan) return;
    const view = views.get(itemId);
    if (!view || view.item.locked || !editable) return;
    preview = {
      itemId,
      baseRevision: plan.revision,
      position: [round(position[0], SNAP), position[1], round(position[2], SNAP)],
      rotationY,
      insideRoom: insideRoom(view.item, position, rotationY),
    };
    applyTransform(view);
    rebuildGhosts();
    events.preview(preview);
  }

  function clearPreview() {
    if (!preview) return;
    const view = views.get(preview.itemId);
    preview = null;
    if (view) applyTransform(view);
    rebuildGhosts();
    events.preview(null);
  }

  // ---------------------------------------------------------------- camera

  function frameRoom() {
    if (!plan || !plan.geometry.rooms.length) return;
    const pts = plan.geometry.rooms.flatMap((r) => r.floorPolygon);
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), 2);
    const aspect = camera.aspect || 1;
    // pull back on tall screens so the whole room still fits across
    const distance = (span * 1.45) / Math.pow(Math.min(aspect, 1), 0.55);
    controls.target.set(cx, 0.4, cz);
    camera.position.set(cx, 0.4 + distance * 0.66, cz + distance * 0.75);
    controls.update();
    framed = true;
  }

  const focus = { target: null as THREE.Vector3 | null };

  // ---------------------------------------------------------------- pointer

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let hoverDirty = false;
  let down: { x: number; y: number; t: number; id: number } | null = null;
  let drag: { pointerId: number; dx: number; dz: number } | null = null;

  function toNdc(e: PointerEvent) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  function pickables() {
    const out: THREE.Object3D[] = [];
    for (const v of views.values()) if (v.body) out.push(v.body);
    return out;
  }

  function itemFromHit(hits: THREE.Intersection[]) {
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData.itemId === undefined) o = o.parent;
      if (o) return o.userData.itemId as string;
    }
    return null;
  }

  function pickScreen() {
    ray.setFromCamera(ndc, camera);
    return itemFromHit(ray.intersectObjects(pickables(), true));
  }

  function floorAtPointer() {
    ray.setFromCamera(ndc, camera);
    const hit = ray.ray.intersectPlane(floorPlane, new THREE.Vector3());
    return hit ? world.worldToLocal(hit) : null;
  }

  function setHover(id: string | null) {
    if (id === hoveredId) return;
    const before = hoveredId ? views.get(hoveredId) : undefined;
    hoveredId = id;
    if (before) rebuildDecor(before);
    const after = id ? views.get(id) : undefined;
    if (after) rebuildDecor(after);
    canvas.style.cursor = id ? (id === selectedId && editable && !after?.item.locked ? "grab" : "pointer") : "";
    events.hover(id);
  }

  function onDown(e: PointerEvent) {
    if (renderer.xr.isPresenting || !e.isPrimary) return;
    toNdc(e);
    down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    if (!editable || !selectedId) return;
    const view = views.get(selectedId);
    if (!view || view.item.locked || pickScreen() !== selectedId) return;
    const p = floorAtPointer();
    if (!p) return;
    const { position } = placementOf(view);
    drag = { pointerId: e.pointerId, dx: position[0] - p.x, dz: position[2] - p.z };
    e.stopImmediatePropagation();
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  }

  function onMove(e: PointerEvent) {
    if (renderer.xr.isPresenting) return;
    toNdc(e);
    if (drag && e.pointerId === drag.pointerId && selectedId) {
      const p = floorAtPointer();
      const view = views.get(selectedId);
      if (p && view) {
        const { position, rotationY } = placementOf(view);
        setPreview(selectedId, [p.x + drag.dx, position[1], p.z + drag.dz], rotationY);
      }
      return;
    }
    if (e.pointerType === "mouse" && e.buttons === 0) hoverDirty = true;
  }

  function onUp(e: PointerEvent) {
    if (drag && e.pointerId === drag.pointerId) {
      drag = null;
      canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = "grab";
      down = null;
      return;
    }
    if (!down || down.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 600;
    down = null;
    if (moved > 6 || !quick) return;
    toNdc(e);
    events.select(pickScreen());
  }

  function onCancel(e: PointerEvent) {
    if (drag && e.pointerId === drag.pointerId) drag = null;
    down = null;
  }

  function onLeave(e: PointerEvent) {
    if (e.pointerType === "mouse" && !drag) setHover(null);
  }

  // ---------------------------------------------------------------- xr

  const xrStatus: XRStatus = { presenting: false, mode: null, alignment: "default" };
  let saved: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  let alignA: THREE.Vector3 | null = null;
  const aligned = { position: new THREE.Vector3(), yaw: 0, done: false };

  const controllers = [0, 1].map((i) => {
    const c = renderer.xr.getController(i);
    const rayLine = segments([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)], inkLine(0.85));
    rayLine.scale.z = 4;
    c.add(rayLine);
    c.userData.ray = rayLine;
    c.addEventListener("connected", (e) => {
      c.userData.handedness = (e as unknown as { data: XRInputSource }).data.handedness;
      attachHint();
    });
    c.addEventListener("disconnected", () => {
      c.userData.handedness = null;
      attachHint();
    });
    c.addEventListener("select", () => onXRSelect(c));
    c.addEventListener("squeeze", () => onXRSqueeze());
    scene.add(c);
    return c;
  });

  const hint = createPanel(0.42, 0.15);
  // floats just above the controller and turns to face the wearer every frame
  hint.mesh.position.set(0, 0.12, -0.06);
  hint.mesh.visible = false;
  const info = createPanel(0.5, 0.19);
  info.mesh.visible = false;
  scene.add(info.mesh);

  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: CHANGE, depthTest: false, transparent: true }),
  );
  reticle.renderOrder = 12;
  reticle.visible = false;
  reticle.raycast = noRaycast;
  scene.add(reticle);
  const cornerMark = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 1.2, 16).translate(0, 0.6, 0),
    new THREE.MeshBasicMaterial({ color: CHANGE, transparent: true, opacity: 0.85 }),
  );
  cornerMark.visible = false;
  cornerMark.raycast = noRaycast;
  world.add(cornerMark);

  function attachHint() {
    hint.mesh.removeFromParent();
    // prefer the left hand so the right can point
    const host =
      controllers.find((c) => c.userData.handedness === "left") ?? controllers.find((c) => c.userData.handedness);
    if (host) host.add(hint.mesh);
  }

  function emitXR() {
    events.xr({ ...xrStatus });
    drawHint();
  }

  function drawHint() {
    const lines: PanelLine[] =
      xrStatus.alignment === "pick-corner"
        ? [
            { text: "Line up the room", size: 46 },
            { text: "Point at the floor where the", muted: true, size: 37 },
            { text: "orange post should be. Trigger.", muted: true, size: 37 },
            { text: "Grip cancels.", muted: true, size: 37 },
          ]
        : xrStatus.alignment === "pick-wall"
          ? [
              { text: "Now the wall direction", size: 46 },
              { text: "Point further along that same", muted: true, size: 37 },
              { text: "wall, at least 30 cm. Trigger.", muted: true, size: 37 },
              { text: "Grip cancels.", muted: true, size: 37 },
            ]
          : [
              { text: xrStatus.alignment === "aligned" ? "Aligned for this session" : "Room at a default spot", size: 43 },
              { text: "Trigger: select a piece", muted: true, size: 37 },
              { text: "Grip: line it up with your floor", muted: true, size: 37 },
              { text: "Not saved to the plan", muted: true, size: 37 },
            ];
    hint.draw(lines);
  }

  function defaultPlacement() {
    // stand the viewer near the middle of the first room, at real scale
    const room = plan?.geometry.rooms[0];
    const [cx, cz] = room ? polygonCentroid(room.floorPolygon) : [0, 0];
    world.rotation.set(0, 0, 0);
    world.position.set(-cx, 0, -cz);
  }

  function applyAlignment() {
    if (aligned.done) {
      world.rotation.set(0, aligned.yaw, 0);
      world.position.copy(aligned.position);
    } else {
      defaultPlacement();
    }
  }

  function xrFloorHit(controller: THREE.Object3D) {
    ray.setFromXRController(controller as THREE.XRTargetRaySpace);
    return ray.ray.intersectPlane(floorPlane, new THREE.Vector3());
  }

  function onXRSelect(controller: THREE.Object3D) {
    if (!renderer.xr.isPresenting || !plan) return;
    const room = plan.geometry.rooms[0];
    if (xrStatus.alignment === "pick-corner") {
      const hit = xrFloorHit(controller);
      if (!hit) return;
      alignA = hit;
      xrStatus.alignment = "pick-wall";
      emitXR();
      return;
    }
    if (xrStatus.alignment === "pick-wall" && alignA && room) {
      const hit = xrFloorHit(controller);
      if (!hit || hit.distanceTo(alignA) < 0.3) return;
      const [p0, p1] = room.floorPolygon;
      // yaw that turns the room's first wall onto the direction the user pointed
      const roomAngle = Math.atan2(-(p1[1] - p0[1]), p1[0] - p0[0]);
      const realAngle = Math.atan2(-(hit.z - alignA.z), hit.x - alignA.x);
      const yaw = realAngle - roomAngle;
      const corner = new THREE.Vector3(p0[0], 0, p0[1]).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      aligned.yaw = yaw;
      aligned.position.set(alignA.x - corner.x, 0, alignA.z - corner.z);
      aligned.done = true;
      alignA = null;
      xrStatus.alignment = "aligned";
      applyAlignment();
      emitXR();
      return;
    }
    ray.setFromXRController(controller as THREE.XRTargetRaySpace);
    events.select(itemFromHit(ray.intersectObjects(pickables(), true)));
  }

  function onXRSqueeze() {
    if (!renderer.xr.isPresenting || !plan?.geometry.rooms[0]) return;
    if (xrStatus.alignment === "pick-corner" || xrStatus.alignment === "pick-wall") {
      alignA = null;
      xrStatus.alignment = aligned.done ? "aligned" : "default";
    } else {
      xrStatus.alignment = "pick-corner";
    }
    emitXR();
  }

  renderer.xr.addEventListener("sessionstart", () => {
    const session = renderer.xr.getSession();
    xrStatus.presenting = true;
    // the session object does not report its mode, so enterXR records it
    if (!session) return;
    saved = { position: camera.position.clone(), target: controls.target.clone() };
    controls.enabled = false;
    setHover(null);
    events.overlay(null);
    const passthrough = xrStatus.mode === "immersive-ar";
    scene.background = passthrough ? null : new THREE.Color(PAPER);
    renderer.setClearAlpha(passthrough ? 0 : 1);
    for (const f of floors) f.visible = !passthrough;
    applyAlignment();
    hint.mesh.visible = true;
    emitXR();
  });

  renderer.xr.addEventListener("sessionend", () => {
    xrStatus.presenting = false;
    xrStatus.mode = null;
    if (xrStatus.alignment !== "aligned") xrStatus.alignment = aligned.done ? "aligned" : "default";
    world.position.set(0, 0, 0);
    world.rotation.set(0, 0, 0);
    scene.background = new THREE.Color(PAPER);
    renderer.setClearAlpha(1);
    for (const f of floors) f.visible = true;
    hint.mesh.visible = false;
    info.mesh.visible = false;
    reticle.visible = false;
    cornerMark.visible = false;
    if (saved) {
      camera.position.copy(saved.position);
      controls.target.copy(saved.target);
      camera.quaternion.identity();
      camera.lookAt(saved.target);
    }
    controls.enabled = true;
    resize();
    emitXR();
    syncLoop();
  });

  async function enterXR(mode: XRMode) {
    if (!navigator.xr) throw new Error("WebXR is not available in this browser.");
    xrStatus.mode = mode;
    const session = await navigator.xr.requestSession(mode, { optionalFeatures: XR_FEATURES });
    await renderer.xr.setSession(session);
    syncLoop();
  }

  function infoLines(view: ItemView): PanelLine[] {
    if (!plan) return [];
    const source = dimensionSource(plan, view.item);
    const lines: PanelLine[] = [{ text: view.item.label, size: 60 }];
    if (source.kind === "unknown") {
      const s = view.state.meshSize;
      lines.push({ text: "Size unknown", size: 46 });
      if (s) lines.push({ text: `Model bounds ${cm(s[0])} x ${cm(s[2])} x ${cm(s[1])} cm`, muted: true, size: 38 });
    } else {
      const [w, h, d] = source.size;
      lines.push({ text: `W ${cm(w)}  D ${cm(d)}  H ${cm(h)} cm`, size: 46 });
      lines.push({ text: source.status, muted: true, size: 38 });
    }
    const change = previous && showChanges ? diffPlans(previous, plan).changes.find((c) => c.id === view.item.id) : null;
    const flags = [view.item.locked ? "Locked" : null, change ? describeChange(change) : null].filter(Boolean).join(" · ");
    if (flags) lines.push({ text: flags, muted: true, size: 38 });
    return lines;
  }

  function updateXR() {
    const head = renderer.xr.getCamera();
    const headPos = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);

    // walls stay up inside the headset; passthrough shows the real ones instead
    const passthrough = xrStatus.mode === "immersive-ar";
    for (const w of walls) {
      w.full.visible = !passthrough;
      w.stub.visible = false;
    }

    if (hint.mesh.parent) hint.mesh.lookAt(headPos);

    const aligning = xrStatus.alignment === "pick-corner" || xrStatus.alignment === "pick-wall";
    reticle.visible = false;
    if (aligning) {
      const pointer = controllers.find((c) => c.userData.handedness === "right") ?? controllers.find((c) => c.userData.handedness);
      const hit = pointer ? xrFloorHit(pointer) : null;
      if (hit) {
        reticle.position.copy(hit).setY(0.005);
        reticle.visible = true;
      }
    }
    const room = plan?.geometry.rooms[0];
    cornerMark.visible = aligning && !!room;
    if (room) cornerMark.position.set(room.floorPolygon[0][0], 0, room.floorPolygon[0][1]);

    const view = selectedId ? views.get(selectedId) : undefined;
    if (view?.body) {
      const top = new THREE.Vector3(0, Math.max(view.box.max.y, sizeFor(view).size[1]) + 0.32, 0);
      view.root.localToWorld(top);
      info.mesh.position.copy(top);
      info.mesh.lookAt(headPos);
      info.draw(infoLines(view));
      info.mesh.visible = true;
    } else {
      info.mesh.visible = false;
    }
  }

  // ---------------------------------------------------------------- frame loop

  const projected = new THREE.Vector3();
  let lastOverlay = "";

  function project(o: THREE.Object3D) {
    o.getWorldPosition(projected).project(camera);
    return {
      x: (projected.x * 0.5 + 0.5) * canvas.clientWidth,
      y: (-projected.y * 0.5 + 0.5) * canvas.clientHeight,
      behind: projected.z > 1,
    };
  }

  function emitOverlay() {
    const view = selectedId ? views.get(selectedId) : undefined;
    if (!view || !view.body) {
      if (lastOverlay) {
        lastOverlay = "";
        events.overlay(null);
      }
      return;
    }
    const tagObject = view.decor.getObjectByName("tag");
    const tag = tagObject ? project(tagObject) : { x: 0, y: 0, behind: true };
    const labels = view.anchors
      .map((a) => ({ axis: a.axis, ...project(a.object) }))
      .filter((l) => !l.behind)
      .map(({ axis, x, y }) => ({ axis, x: Math.round(x), y: Math.round(y) }));
    const frame: OverlayFrame = { itemId: view.item.id, tag: { x: Math.round(tag.x), y: Math.round(tag.y) }, labels };
    const key = JSON.stringify(frame);
    if (key === lastOverlay) return;
    lastOverlay = key;
    events.overlay(frame);
  }

  function tick() {
    if (disposed) return;
    if (renderer.xr.isPresenting) {
      updateXR();
      renderer.render(scene, camera);
      return;
    }
    if (focus.target) {
      const step = focus.target.clone().sub(controls.target).multiplyScalar(0.14);
      controls.target.add(step);
      camera.position.add(step);
      if (step.lengthSq() < 1e-7) focus.target = null;
    }
    controls.update();
    // dollhouse cutaway: drop any wall standing between the camera and the room
    for (const w of walls) {
      const outside = (camera.position.x - w.mid.x) * w.normal.x + (camera.position.z - w.mid.z) * w.normal.z > 0;
      w.full.visible = !outside;
      w.stub.visible = outside;
    }
    if (hoverDirty && !drag) {
      hoverDirty = false;
      setHover(pickScreen());
    }
    renderer.render(scene, camera);
    emitOverlay();
  }

  function syncLoop() {
    const run = !disposed && (renderer.xr.isPresenting || (visible && !document.hidden));
    if (run === looping) return;
    looping = run;
    renderer.setAnimationLoop(run ? tick : null);
  }

  function resize() {
    if (renderer.xr.isPresenting) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = camera.aspect < 1 ? 55 : 45;
    camera.updateProjectionMatrix();
    if (!framed) frameRoom();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    syncLoop();
  });
  io.observe(canvas);
  document.addEventListener("visibilitychange", syncLoop);
  resize();
  syncLoop();

  // ---------------------------------------------------------------- api

  return {
    /** Render a plan. Pass the prior accepted revision to show what changed. */
    setPlan(next: RoomPlan, prior: RoomPlan | null = null) {
      const revisionChanged = plan?.revision !== next.revision || plan?.projectId !== next.projectId;
      plan = next;
      previous = prior;
      const key = JSON.stringify(next.geometry);
      if (key !== shellKey) {
        shellKey = key;
        buildShell(next);
        if (renderer.xr.isPresenting) applyAlignment();
      }
      const seen = new Set<string>();
      for (const item of next.items) {
        seen.add(item.id);
        let view = views.get(item.id);
        const k = itemKey(item);
        if (view && view.key !== k) {
          removeView(view);
          view = undefined;
        }
        if (!view) {
          view = createView(item);
          views.set(item.id, view);
        }
        view.item = item;
      }
      for (const view of [...views.values()]) if (!seen.has(view.item.id)) removeView(view);
      // a preview is tied to the revision it was made on
      if (preview && (revisionChanged || !views.has(preview.itemId))) {
        preview = null;
        events.preview(null);
      }
      for (const view of views.values()) applyTransform(view);
      rebuildAllDecor();
      rebuildGhosts();
      emitItems();
      if (!framed) frameRoom();
    },
    setSelected(id: string | null) {
      if (id === selectedId) return;
      const before = selectedId ? views.get(selectedId) : undefined;
      selectedId = id;
      if (preview && preview.itemId !== id) clearPreview();
      if (before) rebuildDecor(before);
      const after = id ? views.get(id) : undefined;
      if (after) rebuildDecor(after);
    },
    /** Move the orbit target to an item, for selections made outside the canvas. */
    focus(id: string) {
      const view = views.get(id);
      if (!view || renderer.xr.isPresenting) return;
      const { position } = placementOf(view);
      focus.target = new THREE.Vector3(position[0], Math.min(0.6, sizeFor(view).size[1] / 2), position[2]);
    },
    setEditable(next: boolean) {
      editable = next;
      if (!next) clearPreview();
    },
    setShowChanges(next: boolean) {
      showChanges = next;
      rebuildGhosts();
    },
    /** Nudge the selected piece's local preview, in meters and radians. */
    nudge(dx: number, dz: number, turn = 0) {
      if (!selectedId) return;
      const view = views.get(selectedId);
      if (!view) return;
      const { position, rotationY } = placementOf(view);
      setPreview(selectedId, [position[0] + dx, position[1], position[2] + dz], rotationY + turn);
    },
    clearPreview,
    enterXR,
    async exitXR() {
      await renderer.xr.getSession()?.end();
    },
    resetAlignment() {
      aligned.done = false;
      alignA = null;
      xrStatus.alignment = "default";
      if (renderer.xr.isPresenting) applyAlignment();
      emitXR();
    },
    reframe() {
      framed = false;
      frameRoom();
    },
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      renderer.xr.getSession()?.end().catch(() => {});
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", syncLoop);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      controls.dispose();
      for (const view of [...views.values()]) removeView(view);
      hint.mesh.removeFromParent();
      disposeTree(hint.mesh);
      disposeTree(scene);
      for (const pending of templates.values()) pending.then(disposeTree, () => {});
      templates.clear();
      disposeLockTexture();
      renderer.dispose();
    },
  };
}

export type Viewer = ReturnType<typeof createViewer>;
