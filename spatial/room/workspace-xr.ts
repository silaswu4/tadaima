import * as THREE from "three";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import type { FurnitureCategory, ProductCandidate, RoomPlan, Vector3Meters } from "../../backend/contracts";
import { createXRMenu, XR_MENU_INK } from "./workspace-xr-menu";
import type { XRMenuRuntime } from "./workspace-xr-menu";
import { insideFloor } from "./window-daylight";

/**
 * The menu rests low and angled up toward the eyes, like a tablet held in front of the chest,
 * so the room stays clear straight ahead. Glance down to use it; left grip brings it back.
 */
export const XR_HUD_DISTANCE = 1.0, XR_HUD_DROP = .42, XR_HUD_SCALE = .85;

export type WorkspaceXRSupport = { supported: boolean; reason: string };
/** Display-only offers supplied by the application's shopping state. */
export type WorkspaceXROffer = { id: string; label: string; detail?: string; product?: ProductCandidate; fits?: boolean; withinBudget?: boolean | null; problems?: string[]; source?: "catalog" | "live" };
export type WorkspaceXRItem = { id: string; label: string; category?: FurnitureCategory; dimensions: Vector3Meters | null; priceMinor?: number | null; currency?: string | null; imageUrl?: string | null; stored?: boolean; locked?: boolean; selected?: boolean };
export type WorkspaceXRAction = { id: string; label: string; detail?: string; disabled?: boolean };
export type WorkspaceXRLocomotion = "walk" | "teleport";
export type WorkspaceXRShopping = {
  offers: WorkspaceXROffer[];
  inventory?: WorkspaceXRItem[];
  basket?: WorkspaceXRItem[];
  basketTotal?: string;
  roomLabel?: string;
  actions?: WorkspaceXRAction[];
  selectedItemLabel?: string;
  status?: string;
  pendingOfferId?: string | null;
  canConfirm?: boolean;
  basketLabel?: string;
  selectedItemLocked?: boolean;
  busy?: boolean;
  agent?: { available: boolean; status: string; caption?: string; listening: boolean; connected: boolean; error?: string; activity?: string; transcript?: string };
};
export type WorkspaceXROptions = {
  /** Test/diagnostic adapter; production uses the real React DOM surface. */
  menuRuntime?: XRMenuRuntime;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  getPlan(): RoomPlan;
  getFloorMeshes(): THREE.Object3D[];
  getItemRoots(): Array<{ id: string; object: THREE.Object3D }>;
  /** All blocking scene surfaces, including walls; excludes the HUD. */
  getOccluders?(): THREE.Object3D[];
  getSpawnPoint?(): THREE.Vector3 | null;
  isFloorSpotValid?(point: THREE.Vector3): boolean;
  /** Shared swept collision solver; only horizontal rig translation is accepted. */
  moveFloor?(head: THREE.Vector3, input: { forward: number; right: number; yaw: number }, deltaSeconds: number): THREE.Vector3;
  locomotion?: WorkspaceXRLocomotion;
  onSelectItem(id: string | null): void;
  onFloorSelect?(point: THREE.Vector3): void;
  onPreviewOffer?(id: string): void;
  /** Confirms a placement preview, never a purchase. */
  onConfirmOffer?(): void;
  onAction?(id: string): void;
  onSessionChange?(presenting: boolean): void;
  onError?(message: string): void;
};

/** Offset a metric rig so that the tracked head's floor projection lands at target. */
export function teleportXR(rig: THREE.Object3D, headPosition: THREE.Vector3, target: THREE.Vector3) {
  rig.position.x += target.x - headPosition.x;
  rig.position.z += target.z - headPosition.z;
  rig.updateMatrixWorld(true);
}

/** Rotate around the wearer, without swinging their position around the room origin. */
export function snapTurnXR(rig: THREE.Object3D, headPosition: THREE.Vector3, radians: number) {
  const offset = rig.position.clone().sub(headPosition).applyAxisAngle(new THREE.Vector3(0, 1, 0), radians);
  rig.position.x = headPosition.x + offset.x;
  rig.position.z = headPosition.z + offset.z;
  rig.rotation.y += radians;
  rig.updateMatrixWorld(true);
}

/** xr-standard puts the thumbstick on axes 2/3; normalize drift and diagonals. */
export function readXRThumbstick(axes: readonly number[] | undefined): { right: number; forward: number } | null {
  if (!axes || axes.length < 2 || axes.some((axis) => !Number.isFinite(axis))) return null;
  const x = axes.length >= 4 ? axes[2] : axes[0], y = axes.length >= 4 ? axes[3] : axes[1];
  const magnitude = Math.hypot(x, y);
  if (magnitude < .2) return { right: 0, forward: 0 };
  const strength = Math.min(1, (magnitude - .2) / .8);
  return { right: x / magnitude * strength, forward: -y / magnitude * strength };
}

/** Head-relative walking keeps sensor eye height and uses swept room clearance. */
export function walkXR(rig: THREE.Object3D, head: THREE.Vector3, orientation: THREE.Quaternion,
  stick: { right: number; forward: number }, deltaSeconds: number, valid: (point: THREE.Vector3) => boolean,
  moveFloor?: WorkspaceXROptions["moveFloor"]) {
  if (![stick.right, stick.forward, deltaSeconds, head.x, head.y, head.z].every(Number.isFinite) || deltaSeconds <= 0 || !Math.hypot(stick.right, stick.forward)) return;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(orientation); forward.y = 0;
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1).applyQuaternion(rig.quaternion);
  forward.y = 0; forward.normalize();
  const yaw = Math.atan2(-forward.x, -forward.z), dt = Math.min(deltaSeconds, .05);
  if (moveFloor) {
    const target = moveFloor(head.clone(), { ...stick, yaw }, dt);
    if ([target.x, target.z].every(Number.isFinite) && valid(new THREE.Vector3(target.x, 0, target.z))) teleportXR(rig, head, target);
    return;
  }
  const right = forward.clone().cross(new THREE.Vector3(0, 1, 0));
  const delta = forward.multiplyScalar(stick.forward).addScaledVector(right, stick.right).multiplyScalar(1.3 * dt);
  const point = new THREE.Vector3(head.x, 0, head.z), count = Math.max(1, Math.ceil(delta.length() / .025));
  delta.divideScalar(count);
  for (let step = 0; step < count; step++) {
    const candidate = point.clone().add(delta);
    if (valid(candidate)) point.copy(candidate);
    else {
      const x = point.clone().add(new THREE.Vector3(delta.x, 0, 0));
      if (valid(x)) point.copy(x);
      const z = point.clone().add(new THREE.Vector3(0, 0, delta.z));
      if (valid(z)) point.copy(z);
    }
  }
  teleportXR(rig, head, point);
}

/** Feature detection is separate from entry: requestSession must remain in a user gesture. */
export async function checkWorkspaceXRSupport(): Promise<WorkspaceXRSupport> {
  if (typeof window === "undefined" || !window.isSecureContext) {
    return { supported: false, reason: "VR needs HTTPS or localhost. On Quest use USB port forwarding or a trusted HTTPS address." };
  }
  if (!navigator.xr) return { supported: false, reason: "Open this page in Meta Quest Browser to enter VR." };
  try {
    const supported = await navigator.xr.isSessionSupported("immersive-vr");
    return { supported, reason: supported ? "Quest VR is available." : "This browser has no available immersive VR headset." };
  } catch {
    return { supported: false, reason: "VR support could not be checked. Check the browser's immersive experience permissions." };
  }
}

/**
 * WebXR interactions for the PBR workspace. The owner must use renderer.setAnimationLoop,
 * call update before render, disable desktop controls, and retain full-height walls in XR.
 * This module owns only its rig/HUD/controllers, never canonical geometry or commerce.
 */
export function createWorkspaceXR(options: WorkspaceXROptions) {
  const { renderer, scene, camera } = options;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType("local-floor");
  renderer.xr.setFramebufferScaleFactor(1);
  const rig = new THREE.Group();
  rig.name = "workspace-xr-rig";
  scene.add(rig);
  const hud = new THREE.Group();
  hud.scale.setScalar(XR_HUD_SCALE);
  hud.name = "workspace-xr-shopping";
  hud.visible = false;
  scene.add(hud);
  const ray = new THREE.Raycaster();
  ray.far = 20;
  const reticle = new THREE.Mesh(new THREE.RingGeometry(.11, .14, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: "#3dba95", depthWrite: false, side: THREE.DoubleSide }));
  reticle.name = "workspace-xr-teleport-target";
  reticle.visible = false;
  reticle.raycast = () => {};
  scene.add(reticle);
  const controllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
  const sourceByController = new Map<THREE.Object3D, XRInputSource>();
  const cleanups: Array<() => void> = [];
  let shopping: WorkspaceXRShopping = { offers: [] };
  let presenting = false, disposed = false, entering = false;
  let saved: { parent: THREE.Object3D | null; position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3; fov: number; aspect: number } | null = null;
  let activeSession: XRSession | null = null;
  let initialHeadPlaced = false;
  let teleportHeld = false, snapLatched = false;
  let teleportTarget: THREE.Vector3 | null = null;
  let hudVisible = true;
  let shoppingKey = "";
  let locomotion: WorkspaceXRLocomotion = options.locomotion ?? "walk";
  let resumeNeutral = false;
  // Push-to-talk on A/X: hold to speak, release to send, wherever the wearer is looking.
  let talkButtonHeld = false, sendOnListen = false;
  const menu = createXRMenu({
    onPreviewOffer: (id) => options.onPreviewOffer?.(id), onConfirmOffer: () => options.onConfirmOffer?.(),
    onAction: (id) => options.onAction?.(id),
    onLocomotionToggle: () => {
      locomotion = locomotion === "walk" ? "teleport" : "walk";
      teleportHeld = false; teleportTarget = null; reticle.visible = false;
      menu.setState(shopping, locomotion);
    },
    onExit: () => { void activeSession?.end().catch(() => options.onError?.("Use the Quest browser controls to exit VR.")); },
    onClose: () => { hudVisible = false; hud.visible = false; },
  }, options.menuRuntime);
  // This is the wearer's menu, rendered as an overlay so nearby room geometry
  // cannot cut holes through the controls. World selection remains occluded.
  menu.mesh.material.depthTest = false;
  hud.add(menu.mesh);
  let hudYaw = 0, hudTurning = false;
  const menuPointers = controllers.map(() => {
    const dot = new THREE.Mesh(new THREE.CircleGeometry(.006, 16), new THREE.MeshBasicMaterial({ color: XR_MENU_INK, transparent: true, depthTest: false, depthWrite: false }));
    dot.visible = false; dot.renderOrder = 22; dot.raycast = () => {};
    hud.add(dot); return dot;
  });

  function inputAvailable() {
    return presenting && (!activeSession?.visibilityState || activeSession.visibilityState === "visible");
  }

  // WebXRManager writes a rig-adjusted matrixWorld onto an unparented
  // ArrayCamera. Its getWorld* methods would recompute and erase that transform.
  function headPosition() { return new THREE.Vector3().setFromMatrixPosition(renderer.xr.getCamera().matrixWorld); }
  function headOrientation() {
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(renderer.xr.getCamera().matrixWorld));
  }
  function headYaw() {
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(headOrientation());
    return Math.hypot(direction.x, direction.z) > 1e-5 ? Math.atan2(-direction.x, -direction.z) : hudYaw;
  }
  function positionHud() {
    const head = headPosition();
    hud.position.copy(head).add(new THREE.Vector3(-Math.sin(hudYaw) * XR_HUD_DISTANCE, -XR_HUD_DROP, -Math.cos(hudYaw) * XR_HUD_DISTANCE));
    // Face the eyes squarely: yaw toward the head, then tip the top back by the viewing angle.
    hud.lookAt(new THREE.Vector3(head.x, hud.position.y, head.z));
    hud.rotateX(-Math.atan2(XR_HUD_DROP, XR_HUD_DISTANCE));
    hud.updateWorldMatrix(true, true);
  }
  function placeHud() {
    hudYaw = headYaw(); hudTurning = false; positionHud();
  }
  function followHud(deltaSeconds: number) {
    if (!hud.visible) return;
    const difference = Math.atan2(Math.sin(headYaw() - hudYaw), Math.cos(headYaw() - hudYaw));
    if (Math.abs(difference) > Math.PI / 15) hudTurning = true;
    if (hudTurning) {
      hudYaw += difference * (1 - Math.exp(-10 * Math.min(Math.max(deltaSeconds, 0), .05)));
      if (Math.abs(difference) < .01) hudTurning = false;
    }
    // Translation follows immediately. A yaw dead zone keeps small aiming
    // movements from dragging buttons away from the controller ray.
    positionHud();
  }

  function menuHit(controller: THREE.XRTargetRaySpace) {
    if (!hud.visible) return null;
    controller.updateWorldMatrix(true, false); hud.updateWorldMatrix(true, true);
    ray.setFromXRController(controller);
    const hit = ray.intersectObject(menu.mesh, false)[0];
    // Only painted UI owns the ray; the transparent gaps between cards show (and select) the room.
    return hit?.uv && menu.covers(hit.uv) ? hit : null;
  }

  function updateMenuPointers() {
    const hovered: THREE.Vector2[] = [];
    controllers.forEach((controller, index) => {
      const hit = controller.visible && inputAvailable() ? menuHit(controller) : null;
      const pointer = menuPointers[index]; pointer.visible = !!hit?.uv;
      const line = controller.getObjectByName("workspace-xr-controller-ray") as THREE.Line | undefined;
      if (line) {
        line.scale.z = hit?.uv ? hit.distance : 6;
        const material = line.material as THREE.LineBasicMaterial;
        material.depthTest = !hit?.uv;
        line.renderOrder = hit?.uv ? 21 : 0;
      }
      if (hit?.uv) {
        pointer.position.copy(hud.worldToLocal(hit.point.clone()));
        hovered.push(hit.uv);
      }
    });
    menu.setHovered(hovered);
  }

  function pushToTalk(held: boolean) {
    const toggle = shopping.actions?.find((action) => action.id === "voice-toggle");
    const listening = Boolean(shopping.agent?.listening);
    if (held && !talkButtonHeld) {
      sendOnListen = false;
      if (toggle && !toggle.disabled && !listening) options.onAction?.("voice-toggle");
    } else if (!held && talkButtonHeld) {
      // Releasing sends. If the first press is still connecting, send as soon as listening starts.
      if (listening) options.onAction?.("voice-toggle"); else sendOnListen = true;
    } else if (!held && sendOnListen && listening) {
      sendOnListen = false; options.onAction?.("voice-toggle");
    }
    talkButtonHeld = held;
  }

  function validFloor(point: THREE.Vector3) {
    if (![point.x, point.y, point.z].every(Number.isFinite)) return false;
    return options.isFloorSpotValid?.(point) ?? insideFloor([point.x, point.z], options.getPlan().geometry);
  }

  function findSpawn(): THREE.Vector3 | null {
    const proposed = options.getSpawnPoint?.();
    if (proposed && validFloor(proposed)) return proposed.clone();
    // A bounded grid also handles concave rooms whose polygon average lies outside.
    for (const room of options.getPlan().geometry.rooms) {
      const xs = room.floorPolygon.map((p) => p[0]), zs = room.floorPolygon.map((p) => p[1]);
      const minX = Math.min(...xs), minZ = Math.min(...zs);
      const width = Math.max(...xs) - minX, depth = Math.max(...zs) - minZ;
      for (let row = 1; row < 20; row++) for (let col = 1; col < 20; col++) {
        const point = new THREE.Vector3(minX + width * col / 20, 0, minZ + depth * row / 20);
        if (validFloor(point)) return point;
      }
    }
    return null;
  }

  function pick(controller: THREE.XRTargetRaySpace) {
    // The overlay owns its full rectangle, including disabled controls and
    // whitespace. A menu click must never hit furniture or floor behind it.
    const overlay = menuHit(controller);
    if (overlay?.uv) return { kind: "menu" as const, uv: overlay.uv };
    // Three.js updates tracked local matrices before the animation callback;
    // world matrices otherwise wait until render, leaving a stale picking ray.
    controller.updateWorldMatrix(true, false);
    hud.updateWorldMatrix(true, true);
    ray.setFromXRController(controller);
    const items = options.getItemRoots();
    const floors = options.getFloorMeshes();
    const targets = [...items.map((i) => i.object), ...floors, ...(options.getOccluders?.() ?? [])];
    const hits = ray.intersectObjects(targets, true).filter((hit) => {
      let node: THREE.Object3D | null = hit.object;
      while (node) { if (!node.visible) return false; node = node.parent; }
      return true;
    });
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        const item = items.find((candidate) => candidate.object === node);
        if (item) return { kind: "item" as const, id: item.id };
        if (floors.includes(node)) return validFloor(hit.point) ? { kind: "floor" as const, point: hit.point.clone() } : null;
        node = node.parent;
      }
      // The nearest wall/surface blocks selection and teleporting through it.
      return null;
    }
    return null;
  }

  function select(controller: THREE.XRTargetRaySpace) {
    if (!inputAvailable() || !controller.visible) return;
    renderer.xr.updateCamera(camera);
    const hit = pick(controller);
    if (hit?.kind === "menu") menu.activate(hit.uv);
    else if (hit?.kind === "item") options.onSelectItem(hit.id);
    else if (hit?.kind === "floor") {
      options.onFloorSelect?.(hit.point.clone());
    }
  }

  // Real Touch controller models (fetched from the WebXR input-profiles CDN on connect), so the
  // wearer sees their hands instead of bare rays. Grip spaces are absent in headless test renderers.
  const grips: THREE.Object3D[] = [];
  if (typeof renderer.xr.getControllerGrip === "function") {
    const modelFactory = new XRControllerModelFactory();
    for (const index of [0, 1]) {
      const grip = renderer.xr.getControllerGrip(index);
      grip.add(modelFactory.createControllerModel(grip));
      rig.add(grip); grips.push(grip);
    }
  }

  for (const controller of controllers) {
    rig.add(controller);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: XR_MENU_INK, transparent: true, depthWrite: false }));
    line.name = "workspace-xr-controller-ray";
    line.scale.z = 6;
    line.visible = false;
    controller.add(line);
    const connected = (event: { data: XRInputSource }) => { sourceByController.set(controller, event.data); line.visible = presenting; };
    const disconnected = () => {
      sourceByController.delete(controller); line.visible = false;
      // Losing tracking is not the intentional release that commits a teleport.
      teleportHeld = false; teleportTarget = null; reticle.visible = false;
    };
    const onSelect = () => select(controller);
    const onSqueeze = () => { if (inputAvailable() && controller.visible) { renderer.xr.updateCamera(camera); hudVisible = sourceByController.get(controller)?.handedness === "left" || !hudVisible; hud.visible = hudVisible; if (hudVisible) placeHud(); } };
    controller.addEventListener("connected", connected);
    controller.addEventListener("disconnected", disconnected);
    controller.addEventListener("select", onSelect);
    controller.addEventListener("squeezestart", onSqueeze);
    cleanups.push(() => {
      controller.removeEventListener("connected", connected);
      controller.removeEventListener("disconnected", disconnected);
      controller.removeEventListener("select", onSelect);
      controller.removeEventListener("squeezestart", onSqueeze);
      line.geometry.dispose(); line.material.dispose(); line.removeFromParent(); controller.removeFromParent();
    });
  }

  function restore() {
    if (!presenting && !saved) return;
    presenting = false;
    activeSession?.removeEventListener("end", restore);
    activeSession = null;
    if (saved) {
      camera.removeFromParent();
      saved.parent?.add(camera);
      camera.position.copy(saved.position);
      camera.quaternion.copy(saved.quaternion);
      camera.scale.copy(saved.scale);
      camera.fov = saved.fov;
      camera.aspect = saved.aspect;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      saved = null;
    }
    hud.visible = reticle.visible = false;
    menu.setHovered([]); menuPointers.forEach((pointer) => { pointer.visible = false; });
    rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0);
    initialHeadPlaced = teleportHeld = snapLatched = false;
    talkButtonHeld = sendOnListen = false;
    resumeNeutral = false;
    teleportTarget = null;
    for (const controller of controllers) for (const child of controller.children) child.visible = false;
    options.onSessionChange?.(false);
  }

  renderer.xr.addEventListener("sessionend", restore);
  menu.setState(shopping, locomotion);

  return {
    checkSupport: checkWorkspaceXRSupport,
    get presenting() { return presenting; },
    get active() { return presenting; },
    /** Read-only semantic hit regions for interaction/QA adapters, in menu pixels. */
    get menuTargets() { return menu.targets; },
    get menuTab() { return menu.activeTab; },
    /** Resolve after the React layout and its matching texture are ready. */
    menuWhenIdle() { return menu.whenIdle(); },
    setShoppingState(state: WorkspaceXRShopping) {
      if (disposed) return;
      // The shared UI can scroll its catalog. Bound merchant data while keeping
      // the active preview reachable even when it came from Fetch.
      const offerView = (offer: WorkspaceXROffer): WorkspaceXROffer => ({ ...offer,
        label: offer.label.slice(0, 200), detail: offer.detail?.slice(0, 300), problems: offer.problems?.slice(0, 3).map((problem) => problem.slice(0, 200)),
      });
      const offers = state.offers.slice(0, 24).filter((offer, i, list) => offer.id && offer.id.length <= 256
        && list.findIndex((other) => other.id === offer.id) === i)
        .map(offerView);
      const selectedOffer = state.offers.find((offer) => offer.id === state.pendingOfferId && offer.id.length <= 256);
      if (selectedOffer && !offers.some((offer) => offer.id === selectedOffer.id)) {
        if (offers.length === 24) offers.pop();
        offers.push(offerView(selectedOffer));
      }
      const pendingOfferId = offers.some((offer) => offer.id === state.pendingOfferId) ? state.pendingOfferId : null;
      const itemView = (item: WorkspaceXRItem): WorkspaceXRItem => ({ ...item, label: item.label.slice(0, 200) });
      const next: WorkspaceXRShopping = { offers,
        inventory: state.inventory?.slice(0, 100).map(itemView), basket: state.basket?.slice(0, 100).map(itemView),
        basketTotal: state.basketTotal?.slice(0, 80), roomLabel: state.roomLabel?.slice(0, 160),
        selectedItemLabel: state.selectedItemLabel?.slice(0, 200), status: state.status?.slice(0, 300),
        pendingOfferId, canConfirm: !!pendingOfferId && state.canConfirm === true,
        basketLabel: state.basketLabel?.slice(0, 80), selectedItemLocked: state.selectedItemLocked === true, busy: state.busy === true,
        agent: state.agent ? { available: state.agent.available === true, status: state.agent.status.slice(0, 120), caption: state.agent.caption?.slice(0, 600), listening: state.agent.listening === true, connected: state.agent.connected === true, error: state.agent.error?.slice(0, 300), activity: state.agent.activity?.slice(0, 160), transcript: state.agent.transcript?.slice(0, 300) } : undefined,
        actions: (state.actions ?? []).slice(0, 256).filter((action, i, list) => action.id && action.id.length <= 280 && list.findIndex((other) => other.id === action.id) === i)
          .map((action) => ({ id: action.id, label: action.label.slice(0, 80), detail: action.detail?.slice(0, 140), disabled: action.disabled === true })) };
      const key = JSON.stringify(next);
      if (key === shoppingKey) return;
      shoppingKey = key;
      shopping = next;
      menu.setState(shopping, locomotion);
    },
    async enter() {
      if (disposed) throw new Error("The room viewer was closed.");
      if (presenting || entering) return;
      if (!window.isSecureContext || !navigator.xr) throw new Error("Open Meta Quest Browser using HTTPS or USB-forwarded localhost to enter VR.");
      if (!findSpawn()) throw new Error("No clear floor position is available for VR entry.");
      entering = true;
      let session: XRSession | null = null;
      try {
        // Do not await support detection here: the browser requires a live user gesture.
        session = await navigator.xr.requestSession("immersive-vr", { requiredFeatures: ["local-floor"], optionalFeatures: ["bounded-floor"] });
        if (disposed) { await session.end(); return; }
        saved = { parent: camera.parent, position: camera.position.clone(), quaternion: camera.quaternion.clone(), scale: camera.scale.clone(), fov: camera.fov, aspect: camera.aspect };
        rig.add(camera);
        camera.position.set(0, 0, 0); camera.quaternion.identity(); camera.scale.set(1, 1, 1);
        activeSession = session;
        session.addEventListener("end", restore);
        await renderer.xr.setSession(session);
        if (disposed || activeSession !== session) { await session.end().catch(() => {}); restore(); return; }
        presenting = true;
        menu.focusAgent();
        for (const controller of controllers) for (const child of controller.children) child.visible = true;
        options.onSessionChange?.(true);
      } catch (error) {
        await session?.end().catch(() => {});
        restore();
        const message = error instanceof Error ? error.message : "Could not start immersive VR.";
        options.onError?.(message);
        throw error;
      } finally { entering = false; }
    },
    async exit() { await activeSession?.end(); },
    update(deltaSeconds = 1 / 72) {
      if (!presenting || disposed) return;
      if (!inputAvailable()) {
        teleportHeld = false; teleportTarget = null; reticle.visible = false;
        resumeNeutral = true;
        updateMenuPointers();
        return;
      }
      // WebXRManager's tracked pose is current before the animation callback;
      // apply the rig before reading its world-space position for locomotion.
      renderer.xr.updateCamera(camera);
      if (!initialHeadPlaced) {
        const spawn = findSpawn();
        if (spawn) teleportXR(rig, headPosition(), spawn);
        renderer.xr.updateCamera(camera);
        initialHeadPlaced = true;
        hudVisible = true; hud.visible = true; placeHud();
      }
      let held = false;
      let turn = 0;
      let panelScroll = 0;
      let menuStickHeld = false;
      let walk = { right: 0, forward: 0 };
      let talkHeld = false;
      for (const controller of controllers) {
        const source = sourceByController.get(controller);
        // xr-standard button 4 is A (right) / X (left) on Touch controllers.
        if (controller.visible && source?.gamepad?.buttons?.[4]?.pressed) talkHeld = true;
        const axes = source?.gamepad?.axes;
        if (!controller.visible || !axes || axes.length < 2 || axes.some((axis) => !Number.isFinite(axis))) {
          if (source?.handedness === "left") { teleportHeld = false; teleportTarget = null; }
          continue;
        }
        // xr-standard reserves axes 0/1 for touchpad, 2/3 for the thumbstick.
        const x = axes.length >= 4 ? axes[2] : axes[0], y = axes.length >= 4 ? axes[3] : axes[1];
        if (source.handedness === "left") walk = readXRThumbstick(axes) ?? walk;
        if (locomotion === "teleport" && source.handedness === "left" && y < -.65) {
          held = true;
          const hit = pick(controller);
          teleportTarget = hit?.kind === "floor" ? hit.point : null;
        }
        if (source.handedness === "right") {
          // Aiming at the panel makes the right stick scroll it. Never turn the
          // room while the wearer is trying to browse; left-stick walking stays available.
          if (menuHit(controller)) {
            menuStickHeld = Math.hypot(x, y) > .3;
            if (Math.abs(y) > .2) panelScroll = y;
          } else turn = x;
        }
      }
      pushToTalk(talkHeld);
      if (resumeNeutral) {
        if (Math.hypot(walk.forward, walk.right) > 0 || Math.abs(turn) > .3 || menuStickHeld) { followHud(deltaSeconds); updateMenuPointers(); return; }
        resumeNeutral = false;
      }
      if (panelScroll) menu.scroll(panelScroll * 520 * Math.min(Math.max(deltaSeconds, 0), .05));
      if (locomotion === "walk") walkXR(rig, headPosition(), headOrientation(), walk, deltaSeconds, validFloor, options.moveFloor);
      reticle.visible = held && !!teleportTarget;
      if (reticle.visible && teleportTarget) reticle.position.copy(teleportTarget).add(new THREE.Vector3(0, .015, 0));
      if (!held && teleportHeld && teleportTarget && validFloor(teleportTarget)) {
        teleportXR(rig, headPosition(), teleportTarget); teleportTarget = null;
        renderer.xr.updateCamera(camera); if (hud.visible) placeHud();
      }
      teleportHeld = held;
      // Walking/teleporting translated the rig. Snap-turn must pivot around the
      // resulting tracked head, rather than the position from before that move.
      renderer.xr.updateCamera(camera);
      if (Math.abs(turn) < .3) snapLatched = false;
      if (Math.abs(turn) > .7 && !snapLatched) {
        snapTurnXR(rig, headPosition(), -Math.sign(turn) * Math.PI / 6);
        renderer.xr.updateCamera(camera); if (hud.visible) placeHud();
        snapLatched = true;
      }
      renderer.xr.updateCamera(camera);
      followHud(deltaSeconds);
      updateMenuPointers();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      void activeSession?.end().catch(() => {});
      restore();
      renderer.xr.removeEventListener("sessionend", restore);
      for (const cleanup of cleanups) cleanup();
      sourceByController.clear(); menu.dispose();
      grips.forEach((grip) => grip.removeFromParent());
      menuPointers.forEach((pointer) => { pointer.geometry.dispose(); pointer.material.dispose(); pointer.removeFromParent(); });
      reticle.geometry.dispose(); reticle.material.dispose();
      rig.removeFromParent(); hud.removeFromParent(); reticle.removeFromParent();
    },
  };
}
