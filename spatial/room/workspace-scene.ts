import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { RoomPlan, PlacedItem } from "../../backend/contracts";
import { makeExplodeController, type ExplodeController } from "./explode";
import { makeWorkspaceDemo } from "./workspace-fixture";
import { block, rug, standingLamp, surface } from "./parts";
import { createRoomLighting, setMetricSurfaceUVs } from "./lighting";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { insideFloor, planWindowDaylight } from "./window-daylight";
import { createFurnitureProxy, placeFurnitureModel } from "./furniture-model";

export type WorkspaceItem = {
  id: string;
  label: string;
  /** Local model bounds, not retailer-verified dimensions. */
  size: [number, number, number];
  modelAvailable: boolean;
  representation: "detected_size_proxy" | "demo_model" | "demo_proxy";
  locked: boolean;
  evidence: string[];
};
export type WorkspaceScene = {
  ready: Promise<void>;
  setExploded(value: boolean): void;
  selectItem(id: string | null): void;
  resetCamera(): void;
  dispose(): void;
};
type Callbacks = {
  onReady(items: WorkspaceItem[]): void;
  onSelect(id: string | null): void;
  onError(message: string): void;
};

/** Release GPU resources, including embedded ImageBitmaps from loaded GLBs. */
function release(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh || node instanceof THREE.LineSegments)) return;
    geometries.add(node.geometry);
    const list = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of list) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  const images = new Set<ImageBitmap>();
  for (const texture of textures) {
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) images.add(texture.image);
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const material of materials) material.dispose();
}

export function createFurnitureWorkspace(
  canvas: HTMLCanvasElement,
  callbacks: Callbacks,
  options: { lite?: boolean; reducedMotion?: boolean; plan?: RoomPlan } = {},
): WorkspaceScene {
  // Snapshot canonical input; presentation transforms belong only to Object3Ds.
  const plan = structuredClone(options.plan ?? makeWorkspaceDemo());
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.lite ? 1.5 : 2));
  renderer.setClearColor("#f5f2eb");
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene();
  const lighting = createRoomLighting(renderer, scene, options.lite);
  const camera = new THREE.PerspectiveCamera(42, 1, .1, 200);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = !options.reducedMotion;
  controls.dampingFactor = .09;
  controls.minPolarAngle = .15;
  controls.maxPolarAngle = Math.PI / 2 - .04;
  controls.minDistance = 2;
  controls.maxDistance = 80;
  controls.enablePan = true;
  const shell = new THREE.Group();
  scene.add(shell);
  scene.add(new THREE.HemisphereLight("#eaf0ff", "#b4a18a", .45));
  const windows = planWindowDaylight(plan.geometry, options.lite ? 4 : 8);
  if (windows.length) RectAreaLightUniformsLib.init();
  for (const window of windows) {
    const light = new THREE.RectAreaLight("#f1f5ff", 6, window.width, window.height);
    light.position.fromArray(window.position);
    light.lookAt(light.position.clone().add(new THREE.Vector3(...window.inward)));
    scene.add(light);
  }
  // RectAreaLight supplies window-sized soft PBR illumination, but does not
  // cast shadows. One window-aligned directional proxy supplies contact shade;
  // its downward angle is a presentation assumption, never a solar estimate.
  const sun = new THREE.DirectionalLight(windows.length ? "#edf3ff" : "#fff1da", windows.length ? 1.4 : 2.6);
  sun.position.set(-5, 10, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(options.lite ? 1024 : 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -18;
  sun.shadow.camera.right = sun.shadow.camera.top = 18;
  sun.shadow.radius = 3;
  sun.shadow.normalBias = .015;
  sun.shadow.bias = -.0001;
  scene.add(sun);
  scene.add(sun.target);

  const wallViews: { material: THREE.MeshStandardMaterial; meshes: THREE.Mesh[]; midpoint: THREE.Vector3; outward: THREE.Vector3; interior: boolean }[] = [];
  const roomCenter = new THREE.Vector3();
  const appearances = new Map(plan.appearance?.surfaces.map((entry) => [entry.entityId, entry]) ?? []);
  for (const room of plan.geometry.rooms) {
    const appearance = appearances.get(room.id);
    const shape = new THREE.Shape(room.floorPolygon.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: .1, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);
    setMetricSurfaceUVs(geometry, appearance?.tileMeters ?? 1.2, appearance?.rotationDegrees);
    const floor = new THREE.Mesh(geometry, lighting.makeSurface("floor", appearance));
    floor.position.y = -.1;
    floor.receiveShadow = true;
    shell.add(floor);
  }
  const floorBounds = new THREE.Box3().setFromObject(shell);
  if (floorBounds.isEmpty()) {
    lighting.dispose();
    release(shell);
    controls.dispose();
    renderer.dispose();
    throw new Error("A room floor is required for the furniture workspace.");
  }
  floorBounds.getCenter(roomCenter);
  for (const wall of plan.geometry.walls) {
    const dx = wall.end[0] - wall.start[0], dz = wall.end[1] - wall.start[1];
    const length = Math.hypot(dx, dz);
    if (length <= 0) continue;
    const appearance = appearances.get(wall.id);
    const material = lighting.makeSurface("wall", appearance);
    material.transparent = true;
    const midpoint = new THREE.Vector3((wall.start[0] + wall.end[0]) / 2, 0, (wall.start[1] + wall.end[1]) / 2);
    const outward = new THREE.Vector3(dz, 0, -dx).normalize();
    // Probe the polygon on each side; a concave room's bounding-box center
    // can sit outside its floor and would reverse reentrant wall normals.
    const plusInside = insideFloor([midpoint.x + outward.x * .01, midpoint.z + outward.z * .01], plan.geometry);
    const minusInside = insideFloor([midpoint.x - outward.x * .01, midpoint.z - outward.z * .01], plan.geometry);
    if (plusInside && !minusInside) outward.negate();
    const meshes: THREE.Mesh[] = [];
    wallViews.push({ material, meshes, midpoint, outward, interior: plusInside && minusInside });
    const openings = plan.geometry.openings.filter((opening) => opening.wallId === wall.id);
    // Split at every aperture edge, so doors/windows are actual holes.
    const cuts = [...new Set([0, length, ...openings.flatMap((o) => [
      THREE.MathUtils.clamp(o.offset, 0, length), THREE.MathUtils.clamp(o.offset + o.width, 0, length),
    ])])].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1], middle = (a + b) / 2;
      const apertures = openings.filter((o) => middle > o.offset && middle < o.offset + o.width)
        .map((o) => [Math.max(0, o.sillHeight), Math.min(wall.height, o.sillHeight + o.height)])
        .sort((a, b) => a[0] - b[0]);
      let bottom = 0;
      const spans: number[][] = [];
      for (const [low, high] of apertures) {
        if (low > bottom) spans.push([bottom, low]);
        bottom = Math.max(bottom, high);
      }
      if (bottom < wall.height) spans.push([bottom, wall.height]);
      for (const [low, high] of spans) {
        if (high <= low || b <= a) continue;
        const mesh = block(b - a, high - low, wall.thickness, material, 0);
        setMetricSurfaceUVs(mesh.geometry, appearance?.tileMeters ?? 1, appearance?.rotationDegrees, [middle, low]);
        mesh.position.set(wall.start[0] + dx * middle / length, low, wall.start[1] + dz * middle / length);
        mesh.rotation.y = -Math.atan2(dz, dx);
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        meshes.push(mesh);
        shell.add(mesh);
      }
    }
  }
  const roomBounds = new THREE.Box3().setFromObject(shell);
  const assembledBounds = roomBounds.clone();
  // Extend beyond the camera's far plane so portrait overviews never reveal
  // the edge of the presentation ground behind the room.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), surface("#f5f2eb", 1));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(roomCenter.x, -.115, roomCenter.z);
  ground.receiveShadow = true;
  scene.add(ground);
  const inventoryMaterial = surface("#e9e3d8", 1);
  inventoryMaterial.transparent = true;
  inventoryMaterial.opacity = 0;
  const inventoryPad = new THREE.Mesh(new THREE.BoxGeometry(1, .025, 1), inventoryMaterial);
  inventoryPad.visible = false;
  inventoryPad.receiveShadow = true;
  scene.add(inventoryPad);
  const selection = new THREE.Box3Helper(new THREE.Box3(), "#a95431");
  selection.visible = false;
  (selection.material as THREE.LineBasicMaterial).depthTest = false;
  selection.renderOrder = 10;
  scene.add(selection);

  const roots = new Map<string, THREE.Group>();
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  let controller: ExplodeController | null = null;
  let selectedId: string | null = null;
  let exploded = false;
  let disposed = false;
  let raf = 0;
  let padOpacity = 0;
  let previousTime = performance.now();
  let cameraMove: { start: number; position: THREE.Vector3; target: THREE.Vector3; endPosition: THREE.Vector3; endTarget: THREE.Vector3 } | null = null;

  function fit(animate: boolean, reset = false, focus?: THREE.Box3) {
    const bounds = focus?.clone() ?? assembledBounds.clone();
    if (!focus && exploded && controller) bounds.union(controller.inventoryBounds);
    const target = bounds.getCenter(new THREE.Vector3());
    const direction = reset || camera.position.distanceTo(controls.target) < .1
      ? new THREE.Vector3(1, 1.05, 1.35).normalize()
      : camera.position.clone().sub(controls.target).normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tanH = tanV * camera.aspect;
    let distance = 2;
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const corner = new THREE.Vector3(x, y, z).sub(target);
      distance = Math.max(distance, corner.dot(direction) + Math.abs(corner.dot(right)) / tanH,
        corner.dot(direction) + Math.abs(corner.dot(up)) / tanV);
    }
    const position = target.clone().addScaledVector(direction, distance * 1.15);
    if (animate && !options.reducedMotion) {
      cameraMove = { start: performance.now(), position: camera.position.clone(), target: controls.target.clone(), endPosition: position, endTarget: target };
    } else {
      cameraMove = null;
      camera.position.copy(position);
      controls.target.copy(target);
      controls.update();
    }
  }

  function resize() {
    if (disposed) return;
    const { width, height } = canvas.getBoundingClientRect();
    renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    camera.aspect = Math.max(1, width) / Math.max(1, height);
    const span = roomBounds.getSize(new THREE.Vector3()).length();
    controls.maxDistance = Math.max(80, span * 20);
    camera.far = Math.max(200, span * 40);
    camera.updateProjectionMatrix();
    fit(false);
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  function cancelCameraMove() { cameraMove = null; }
  controls.addEventListener("start", cancelCameraMove);

  function selectItem(id: string | null) {
    const next = id !== null && roots.has(id) ? id : null;
    // A full room + inventory overview is necessarily small on a phone.
    // Inspecting a settled inventory piece frames it without resizing it.
    if (next && exploded && controller && !controller.transitioning) {
      fit(true, false, new THREE.Box3().setFromObject(roots.get(next)!, true).expandByScalar(.2));
    }
    if (next === selectedId) return;
    selectedId = next;
    callbacks.onSelect(next);
  }
  const raycaster = new THREE.Raycaster();
  let pointerDown: { x: number; y: number; id: number } | null = null;
  function down(event: PointerEvent) {
    if (pointerDown || !event.isPrimary) { pointerDown = null; return; }
    pointerDown = { x: event.clientX, y: event.clientY, id: event.pointerId };
  }
  function up(event: PointerEvent) {
    const start = pointerDown;
    pointerDown = null;
    if (!start || start.id !== event.pointerId || event.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = raycaster.intersectObjects([...roots.values()], true)[0];
    let object: THREE.Object3D | undefined = hit?.object;
    while (object && !object.userData.workspaceItemId) object = object.parent ?? undefined;
    selectItem(object?.userData.workspaceItemId ?? null);
  }
  function cancelPointer() { pointerDown = null; }
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancelPointer);

  async function loadItem(item: PlacedItem): Promise<WorkspaceItem | null> {
    let model: THREE.Object3D;
    let available = true;
    try {
      if (item.assetUrl) model = (await loader.loadAsync(item.assetUrl)).scene;
      else if (plan.projectId === "furniture-workspace-demo" && item.id === "demo-rug") model = rug(3, 2.1, "#d6cab6");
      else if (plan.projectId === "furniture-workspace-demo" && item.id === "demo-lamp") model = standingLamp();
      else throw new Error("No furniture asset");
    } catch {
      available = false;
      model = createFurnitureProxy(item.dimensions ?? [1, 1, 1]);
    }
    if (disposed) { release(model); return null; }
    const { root, size } = placeFurnitureModel(item, model);
    root.traverse((node) => {
      if (node instanceof THREE.Mesh) { node.castShadow = true; node.receiveShadow = true; }
    });
    roots.set(item.id, root);
    scene.add(root);
    return { id: item.id, label: item.label, size, modelAvailable: available,
      representation: item.origin === "existing_owned" && plan.projectId !== "furniture-workspace-demo" && !available ? "detected_size_proxy" : available ? "demo_model" : "demo_proxy",
      locked: item.locked,
      evidence: (item.evidenceIds ?? []).flatMap((id) => {
        const observation = plan.evidence.find((entry) => entry.id === id);
        return observation ? [observation.claim] : [];
      }) };
  }

  function frame(now: number) {
    if (disposed) return;
    const delta = Math.min(100, now - previousTime);
    previousTime = now;
    controller?.update(now);
    if (cameraMove) {
      const t = Math.min(1, (now - cameraMove.start) / 750);
      const eased = t * t * (3 - 2 * t);
      camera.position.lerpVectors(cameraMove.position, cameraMove.endPosition, eased);
      controls.target.lerpVectors(cameraMove.target, cameraMove.endTarget, eased);
      if (t === 1) cameraMove = null;
    }
    controls.update();
    for (const wall of wallViews) {
      const near = wall.interior || wall.outward.dot(camera.position.clone().sub(wall.midpoint)) > 0;
      wall.material.opacity = near ? .075 : 1;
      wall.material.depthWrite = !near;
      // A presentation cutaway should not leave an opaque wall's shadow behind.
      for (const mesh of wall.meshes) mesh.castShadow = !near;
    }
    padOpacity = options.reducedMotion ? (exploded ? 1 : 0)
      : THREE.MathUtils.damp(padOpacity, exploded ? 1 : 0, 6, delta / 1000);
    inventoryMaterial.opacity = padOpacity;
    inventoryPad.visible = padOpacity > .005;
    const selected = selectedId ? roots.get(selectedId) : null;
    selection.visible = !!selected;
    if (selected) selection.box.setFromObject(selected, true).expandByScalar(.025);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  resize();
  raf = requestAnimationFrame(frame);
  const ready = Promise.all([Promise.all(plan.items.map(loadItem)), lighting.ready]).then(([items]) => {
    if (disposed) return;
    controller = makeExplodeController(plan.items.map((item) => ({ id: item.id, object: roots.get(item.id)! })), roomBounds, {
      reducedMotion: options.reducedMotion, floorY: 0, gap: .75,
    });
    assembledBounds.union(controller.getDisplayBounds());
    if (exploded) controller.setExploded(true, performance.now());
    const bounds = controller.inventoryBounds;
    if (!bounds.isEmpty()) {
      const size = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      inventoryPad.scale.set(size.x + .5, 1, size.z + .5);
      inventoryPad.position.set(center.x, -.03, center.z);
    }
    // Fit a single stable shadow frustum around both layouts. This keeps contact
    // shadows on exploded pieces without moving the light during a transition.
    const shadowBounds = assembledBounds.clone().union(bounds);
    const lightTarget = shadowBounds.getCenter(new THREE.Vector3());
    sun.target.position.copy(lightTarget);
    const primary = windows[0];
    const direction = primary ? new THREE.Vector3(-primary.inward[0], .7, -primary.inward[2]).normalize()
      : new THREE.Vector3(-8, 12, 10).normalize();
    const lightDistance = Math.max(20, shadowBounds.getSize(new THREE.Vector3()).length() * 1.5);
    sun.position.copy(lightTarget).addScaledVector(direction, lightDistance);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);
    const lightBounds = shadowBounds.clone().applyMatrix4(sun.shadow.camera.matrixWorldInverse);
    const shadowCamera = sun.shadow.camera;
    shadowCamera.left = lightBounds.min.x - .5;
    shadowCamera.right = lightBounds.max.x + .5;
    shadowCamera.bottom = lightBounds.min.y - .5;
    shadowCamera.top = lightBounds.max.y + .5;
    shadowCamera.near = Math.max(.1, -lightBounds.max.z - 2);
    shadowCamera.far = Math.max(shadowCamera.near + 1, -lightBounds.min.z + 2);
    shadowCamera.updateProjectionMatrix();
    fit(false, true);
    callbacks.onReady(items.filter((item): item is WorkspaceItem => item !== null));
  }).catch(() => {
    if (!disposed) {
      dispose();
      callbacks.onError("The furniture scene could not be prepared. Refresh to try again.");
    }
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    resizeObserver.disconnect();
    controls.removeEventListener("start", cancelCameraMove);
    controls.dispose();
    canvas.removeEventListener("pointerdown", down);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", cancelPointer);
    controller?.dispose();
    lighting.dispose();
    release(scene);
    sun.shadow.dispose();
    renderer.dispose();
    roots.clear();
  }
  return {
    ready,
    setExploded(value) {
      if (disposed || exploded === value) return;
      exploded = value;
      controller?.setExploded(value, performance.now());
      fit(true);
    },
    selectItem,
    resetCamera() { if (!disposed) fit(true, true); },
    dispose,
  };
}
