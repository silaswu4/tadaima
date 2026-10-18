import * as THREE from "three";
import type { RoomPlan } from "../../backend/contracts";
import { createPanel } from "./labels";
import { insideFloor } from "./window-daylight";

export type WorkspaceXRSupport = { supported: boolean; reason: string };
/** Display-only offers supplied by the application's shopping state. */
export type WorkspaceXROffer = { id: string; label: string; detail?: string };
export type WorkspaceXRShopping = {
  offers: WorkspaceXROffer[];
  selectedItemLabel?: string;
  status?: string;
  pendingOfferId?: string | null;
  canConfirm?: boolean;
};
export type WorkspaceXROptions = {
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
  onSelectItem(id: string | null): void;
  onFloorSelect?(point: THREE.Vector3): void;
  onPreviewOffer?(id: string): void;
  /** Confirms a placement preview, never a purchase. */
  onConfirmOffer?(): void;
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
  hud.name = "workspace-xr-shopping";
  hud.visible = false;
  scene.add(hud);
  const cards: Array<{ panel: ReturnType<typeof createPanel>; action?: () => void }> = [];
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

  function inputAvailable() {
    return presenting && (!activeSession?.visibilityState || activeSession.visibilityState === "visible");
  }

  function clearCards() {
    for (const { panel } of cards) {
      panel.mesh.removeFromParent();
      panel.mesh.geometry.dispose();
      panel.mesh.material.map?.dispose();
      panel.mesh.material.dispose();
    }
    cards.length = 0;
  }

  function drawShopping() {
    clearCards();
    const add = (y: number, height: number, lines: string[], action?: () => void) => {
      const panel = createPanel(.72, height, 1400);
      panel.mesh.position.y = y;
      panel.mesh.material.depthTest = true;
      panel.mesh.material.side = THREE.DoubleSide;
      if (action) panel.mesh.raycast = THREE.Mesh.prototype.raycast;
      panel.draw(lines.map((text, i) => ({ text, size: i ? 28 : 34, muted: i > 0 })));
      hud.add(panel.mesh);
      cards.push({ panel, action });
    };
    add(.33, .23, [shopping.selectedItemLabel ?? "Tadaima / room shop", shopping.status ?? "Trigger: select furniture or a floor spot", "Left stick: teleport / right stick: turn / grip: menu"]);
    const offers = shopping.offers.slice(0, 3);
    offers.forEach((offer, index) => add(.09 - index * .16, .145,
      [`${shopping.pendingOfferId === offer.id ? "Selected: " : "Try: "}${offer.label}`, offer.detail ?? "Preview only; no purchase"],
      () => options.onPreviewOffer?.(offer.id)));
    if (shopping.canConfirm && shopping.pendingOfferId) {
      add(.09 - offers.length * .16, .135, ["Confirm placement", "Adds to the room preview, never purchases"], () => options.onConfirmOffer?.());
    }
    if (!offers.length) add(.05, .16, ["No shopping results loaded", "Search for products on the page before entering VR."]);
  }

  function headPosition() { return renderer.xr.getCamera().getWorldPosition(new THREE.Vector3()); }

  function placeHud() {
    const head = renderer.xr.getCamera();
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
    direction.y = 0;
    if (direction.lengthSq() < 1e-6) direction.set(0, 0, -1);
    direction.normalize();
    hud.position.copy(headPosition()).addScaledVector(direction, 1.35);
    hud.position.y -= .12;
    hud.lookAt(headPosition());
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
    // Three.js updates tracked local matrices before the animation callback;
    // world matrices otherwise wait until render, leaving a stale picking ray.
    controller.updateWorldMatrix(true, false);
    hud.updateWorldMatrix(true, true);
    ray.setFromXRController(controller);
    const items = options.getItemRoots();
    const floors = options.getFloorMeshes();
    const targets = [...items.map((i) => i.object), ...floors, ...(options.getOccluders?.() ?? [])];
    if (hud.visible) targets.push(...cards.filter((c) => c.action).map((c) => c.panel.mesh));
    const hits = ray.intersectObjects(targets, true).filter((hit) => {
      let node: THREE.Object3D | null = hit.object;
      while (node) { if (!node.visible) return false; node = node.parent; }
      return true;
    });
    for (const hit of hits) {
      for (const card of cards) if (hit.object === card.panel.mesh) return { kind: "card" as const, card };
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
    const hit = pick(controller);
    if (hit?.kind === "card") hit.card.action?.();
    else if (hit?.kind === "item") options.onSelectItem(hit.id);
    else if (hit?.kind === "floor") {
      options.onFloorSelect?.(hit.point.clone());
    }
  }

  for (const controller of controllers) {
    rig.add(controller);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
      new THREE.LineBasicMaterial({ color: "#8af1cc" }));
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
    const onSqueeze = () => { if (inputAvailable() && controller.visible) { hudVisible = !hudVisible; hud.visible = hudVisible; if (hudVisible) placeHud(); } };
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
    rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0);
    initialHeadPlaced = teleportHeld = snapLatched = false;
    teleportTarget = null;
    for (const controller of controllers) for (const child of controller.children) child.visible = false;
    options.onSessionChange?.(false);
  }

  renderer.xr.addEventListener("sessionend", restore);
  drawShopping();

  return {
    checkSupport: checkWorkspaceXRSupport,
    get presenting() { return presenting; },
    get active() { return presenting; },
    setShoppingState(state: WorkspaceXRShopping) {
      if (disposed) return;
      // The HUD displays a bounded subset, rather than cloning a full search
      // result or allocating textures from unbounded merchant text.
      const offers = state.offers.slice(0, 3).filter((offer, i, list) => offer.id && offer.id.length <= 256
        && list.findIndex((other) => other.id === offer.id) === i)
        .map((offer) => ({ id: offer.id, label: offer.label.slice(0, 200), detail: offer.detail?.slice(0, 300) }));
      const selectedOffer = state.offers.find((offer) => offer.id === state.pendingOfferId && offer.id.length <= 256);
      if (selectedOffer && !offers.some((offer) => offer.id === selectedOffer.id)) {
        if (offers.length === 3) offers.pop();
        offers.push({ id: selectedOffer.id, label: selectedOffer.label.slice(0, 200), detail: selectedOffer.detail?.slice(0, 300) });
      }
      const pendingOfferId = offers.some((offer) => offer.id === state.pendingOfferId) ? state.pendingOfferId : null;
      const next = { offers, selectedItemLabel: state.selectedItemLabel?.slice(0, 200), status: state.status?.slice(0, 300),
        pendingOfferId, canConfirm: !!pendingOfferId && state.canConfirm === true };
      const key = JSON.stringify(next);
      if (key === shoppingKey) return;
      shoppingKey = key;
      shopping = next;
      drawShopping();
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
    update() {
      if (!presenting || disposed) return;
      if (!inputAvailable()) {
        teleportHeld = false; teleportTarget = null; reticle.visible = false;
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
      for (const controller of controllers) {
        const source = sourceByController.get(controller);
        const axes = source?.gamepad?.axes;
        if (!controller.visible || !axes || axes.length < 2 || axes.some((axis) => !Number.isFinite(axis))) {
          if (source?.handedness === "left") { teleportHeld = false; teleportTarget = null; }
          continue;
        }
        // xr-standard reserves axes 0/1 for touchpad, 2/3 for the thumbstick.
        const x = axes.length >= 4 ? axes[2] : axes[0], y = axes.length >= 4 ? axes[3] : axes[1];
        if (source.handedness === "left" && y < -.65) {
          held = true;
          const hit = pick(controller);
          teleportTarget = hit?.kind === "floor" ? hit.point : null;
        }
        if (source.handedness === "right") turn = x;
      }
      reticle.visible = held && !!teleportTarget;
      if (reticle.visible && teleportTarget) reticle.position.copy(teleportTarget).add(new THREE.Vector3(0, .015, 0));
      if (!held && teleportHeld && teleportTarget && validFloor(teleportTarget)) {
        teleportXR(rig, headPosition(), teleportTarget); teleportTarget = null;
      }
      teleportHeld = held;
      if (Math.abs(turn) < .3) snapLatched = false;
      if (Math.abs(turn) > .7 && !snapLatched) {
        snapTurnXR(rig, headPosition(), -Math.sign(turn) * Math.PI / 6);
        snapLatched = true;
      }
      renderer.xr.updateCamera(camera);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      void activeSession?.end().catch(() => {});
      restore();
      renderer.xr.removeEventListener("sessionend", restore);
      for (const cleanup of cleanups) cleanup();
      sourceByController.clear(); clearCards();
      reticle.geometry.dispose(); reticle.material.dispose();
      rig.removeFromParent(); hud.removeFromParent(); reticle.removeFromParent();
    },
  };
}
