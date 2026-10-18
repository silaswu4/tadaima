import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { checkWorkspaceXRSupport, createWorkspaceXR, readXRThumbstick, snapTurnXR, teleportXR, walkXR } from "../room/workspace-xr.ts";
import { XR_MENU_WIDTH, XR_MENU_HEIGHT } from "../room/workspace-xr-menu.ts";

const drawnText = [];
const canvasContext = new Proxy({ clearRect() {}, fillRect() {}, fillText(text) { drawnText.push(text); }, measureText(text) { return { width: text.length * 15 }; } }, { get: (target, key) => key in target ? target[key] : () => {} });
globalThis.document = { body: {}, createElement: () => ({ width: 0, height: 0, getContext: () => canvasContext }) };
globalThis.getComputedStyle = () => ({ fontFamily: "monospace" });

function environment({ failSetSession = false } = {}) {
  const controllers = [new THREE.Group(), new THREE.Group()];
  const events = new THREE.EventDispatcher();
  const head = new THREE.PerspectiveCamera();
  head.position.set(.25, 1.72, -.4);
  let session, cameraUpdates = 0;
  const system = {
    async isSessionSupported() { return true; },
    async requestSession(mode, features) {
      assert.equal(mode, "immersive-vr");
      assert.deepEqual(features.requiredFeatures, ["local-floor"]);
      session = new EventTarget();
      session.end = async () => { session.dispatchEvent(new Event("end")); events.dispatchEvent({ type: "sessionend" }); };
      return session;
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { isSecureContext: true } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { xr: system } });
  const xrManager = Object.assign(events, {
    enabled: false, setReferenceSpaceType(type) { assert.equal(type, "local-floor"); },
    setFramebufferScaleFactor() {}, getController: (i) => controllers[i], getCamera: () => head,
    updateCamera(camera) {
      cameraUpdates++;
      if (camera.parent?.name === "workspace-xr-rig") {
        head.position.copy(new THREE.Vector3(.25, 1.72, -.4).applyMatrix4(camera.parent.matrixWorld));
        head.updateMatrixWorld();
      }
    },
    async setSession() { if (failSetSession) throw new Error("WebGL session failed"); },
  });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(47, 1.8, .1, 200);
  const cameraParent = new THREE.Group();
  scene.add(cameraParent); cameraParent.add(camera);
  camera.position.set(6, 9, 3); camera.rotation.set(.3, .8, .1);
  const original = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), parent: camera.parent };
  const changes = [], selected = [], floorSelections = [];
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  scene.add(floor);
  const plan = { geometry: { rooms: [{ floorPolygon: [[-5, -5], [5, -5], [5, 5], [-5, 5]] }] } };
  const options = {
    locomotion: "teleport",
    renderer: { xr: xrManager }, scene, camera, getPlan: () => plan,
    getFloorMeshes: () => [floor], getItemRoots: () => [],
    getSpawnPoint: () => new THREE.Vector3(1, 0, 2), isFloorSpotValid: (p) => Math.abs(p.x) < 4 && Math.abs(p.z) < 4,
    onSessionChange: (value) => changes.push(value), onSelectItem: (id) => selected.push(id),
    onFloorSelect: (point) => floorSelections.push(point),
  };
  return { options, controllers, changes, selected, floorSelections, original, head, xrManager, system,
    getSession: () => session, getCameraUpdates: () => cameraUpdates };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function pointControllerAt(controller, object, scene) {
  scene.updateMatrixWorld(true);
  const target = object.getWorldPosition(new THREE.Vector3());
  const origin = target.clone().add(new THREE.Vector3(0, 0, .4));
  controller.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(origin, target, new THREE.Vector3(0, 1, 0)));
  controller.parent.worldToLocal(origin); controller.position.copy(origin);
  scene.updateMatrixWorld(true);
  controller.dispatchEvent({ type: "select" });
}

function pointMenuPixel(controller, xr, scene, x, y) {
  const mesh = scene.getObjectByName("workspace-xr-menu"), anchor = new THREE.Object3D();
  anchor.position.set((x / XR_MENU_WIDTH - .5) * 1.04, (.5 - y / XR_MENU_HEIGHT) * 1.04 * XR_MENU_HEIGHT / XR_MENU_WIDTH, 0);
  mesh.add(anchor); pointControllerAt(controller, anchor, scene); anchor.removeFromParent();
}
function pointMenu(controller, xr, scene, id) {
  const target = xr.menuTargets.find((item) => item.id === id);
  assert.ok(target, `missing visible menu target ${id}`);
  pointMenuPixel(controller, xr, scene, target.x + target.width / 2, target.y + target.height / 2);
}

test("metric teleport compensates tracked physical head offset without changing height or scale", () => {
  const rig = new THREE.Group(); rig.position.set(2, 0, 4);
  teleportXR(rig, new THREE.Vector3(2.4, 1.7, 3.8), new THREE.Vector3(8, -.1, -3));
  assert.ok(rig.position.distanceTo(new THREE.Vector3(7.6, 0, -2.8)) < 1e-10);
  assert.deepEqual(rig.scale.toArray(), [1, 1, 1]);
});

test("snap turn preserves the tracked head pivot at room scale", () => {
  const rig = new THREE.Group(); rig.position.set(1, 0, 2);
  const physicalOffset = new THREE.Vector3(.4, 1.6, -.2);
  const headBefore = physicalOffset.clone().applyMatrix4(rig.matrixWorld);
  rig.updateMatrixWorld(); headBefore.copy(physicalOffset).applyMatrix4(rig.matrixWorld);
  snapTurnXR(rig, headBefore, Math.PI / 6);
  assert.ok(physicalOffset.clone().applyMatrix4(rig.matrixWorld).distanceTo(headBefore) < 1e-10);
});

test("support explains insecure contexts, missing APIs, unsupported and permitted devices", async () => {
  environment();
  window.isSecureContext = false;
  assert.match((await checkWorkspaceXRSupport()).reason, /HTTPS/);
  window.isSecureContext = true; delete navigator.xr;
  assert.match((await checkWorkspaceXRSupport()).reason, /Quest Browser/);
  navigator.xr = { isSessionSupported: async () => false };
  assert.equal((await checkWorkspaceXRSupport()).supported, false);
  navigator.xr.isSessionSupported = async () => true;
  assert.equal((await checkWorkspaceXRSupport()).supported, true);
});

test("session entry spawns at floor scale, and exit restores the exact desktop camera and removes owned resources", async () => {
  const env = environment();
  const xr = createWorkspaceXR(env.options);
  await xr.enter(); xr.update();
  assert.equal(xr.active, true);
  assert.equal(env.options.camera.position.y, 0); // tracked 1.72m, never another 1.6m added
  assert.ok(Math.abs(env.head.position.x - 1) < 1e-10);
  assert.ok(Math.abs(env.head.position.z - 2) < 1e-10);
  assert.ok(Math.abs(env.head.position.y - 1.72) < 1e-10);
  const hud = env.options.scene.getObjectByName("workspace-xr-shopping");
  assert.ok(Math.abs(Math.hypot(hud.position.x - env.head.position.x, hud.position.z - env.head.position.z) - 1.25) < 1e-10);
  assert.ok(Math.abs(hud.position.y - (env.head.position.y - .12)) < 1e-10);
  await xr.exit();
  assert.equal(xr.active, false);
  assert.equal(env.options.camera.parent, env.original.parent);
  assert.ok(env.options.camera.position.equals(env.original.position));
  assert.ok(env.options.camera.quaternion.equals(env.original.quaternion));
  assert.equal(env.options.camera.fov, 47);
  assert.deepEqual(env.changes, [true, false]);
  xr.dispose(); xr.dispose();
  assert.equal(env.options.scene.getObjectByName("workspace-xr-rig"), undefined);
  assert.equal(env.options.scene.getObjectByName("workspace-xr-shopping"), undefined);
  assert.ok(env.controllers.every((controller) => controller.parent === null && !controller.children.length));
});

test("failed XR initialization restores camera without leaving a half-open session", async () => {
  const env = environment({ failSetSession: true });
  const xr = createWorkspaceXR(env.options);
  await assert.rejects(xr.enter(), /WebGL session failed/);
  assert.equal(xr.presenting, false);
  assert.equal(env.options.camera.parent, env.original.parent);
  assert.ok(env.options.camera.position.equals(env.original.position));
  xr.dispose();
});

test("controller selection uses real nearest surfaces and will not select through a wall", async () => {
  const env = environment();
  const item = new THREE.Mesh(new THREE.BoxGeometry(.8, .8, .8), new THREE.MeshBasicMaterial());
  item.position.set(0, 1, -3); env.options.scene.add(item);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 2, .1), new THREE.MeshBasicMaterial());
  wall.position.set(0, 1, -2); env.options.scene.add(wall);
  env.options.getItemRoots = () => [{ id: "chair-a", object: item }];
  env.options.getOccluders = () => [wall];
  const xr = createWorkspaceXR(env.options);
  await xr.enter();
  const controller = env.controllers[1]; controller.position.set(0, 1, 0);
  env.options.scene.updateMatrixWorld(true);
  controller.dispatchEvent({ type: "select" });
  assert.deepEqual(env.selected, []);
  wall.visible = false;
  controller.dispatchEvent({ type: "select" });
  assert.deepEqual(env.selected, ["chair-a"]);
  xr.dispose();
});

test("in-headset shopping buttons call preview and explicit placement confirmation only", async () => {
  const env = environment(); const previews = [], confirmations = [];
  env.options.onPreviewOffer = (id) => previews.push(id);
  env.options.onConfirmOffer = () => confirmations.push(true);
  const xr = createWorkspaceXR(env.options);
  xr.setShoppingState({ offers: [{ id: "sku-1", label: "Measured chair", detail: "$80 / 0.5m wide" }], pendingOfferId: "sku-1", canConfirm: true });
  await xr.enter(); xr.update();
  const controller = env.controllers[1];
  pointMenu(controller, xr, env.options.scene, "preview:sku-1");
  assert.deepEqual(previews, ["sku-1"]);
  assert.deepEqual(confirmations, []);
  pointMenu(controller, xr, env.options.scene, "confirm");
  assert.deepEqual(confirmations, [true]);
  xr.dispose();
});

test("teleport commits on stick release, while tracking loss cancels the target", async () => {
  const env = environment();
  const xr = createWorkspaceXR(env.options);
  await xr.enter(); xr.update();
  const controller = env.controllers[0];
  const source = { handedness: "left", gamepad: { axes: [0, 0, 0, -1] } };
  controller.position.set(0, 1, 0); controller.rotation.x = -Math.PI / 4;
  controller.dispatchEvent({ type: "connected", data: source });
  env.options.scene.getObjectByName("workspace-xr-shopping").visible = false;
  env.options.scene.updateMatrixWorld(true);
  const before = env.head.position.clone();
  xr.update();
  assert.equal(env.options.scene.getObjectByName("workspace-xr-teleport-target").visible, true);
  assert.ok(env.head.position.equals(before));
  source.gamepad.axes[3] = 0;
  xr.update();
  assert.ok(env.head.position.distanceTo(before) > .2);
  const afterTeleport = env.head.position.clone();
  source.gamepad.axes[3] = -1; env.options.scene.updateMatrixWorld(true); xr.update();
  controller.dispatchEvent({ type: "disconnected" }); xr.update();
  assert.ok(env.head.position.equals(afterTeleport));
  xr.dispose();
});

test("trigger chooses a shopping floor spot without teleporting, including before an offer is selected", async () => {
  const env = environment(); const xr = createWorkspaceXR(env.options);
  await xr.enter(); xr.update();
  env.options.scene.getObjectByName("workspace-xr-shopping").visible = false;
  const controller = env.controllers[1];
  controller.position.set(0, 1, 0); controller.rotation.x = -Math.PI / 4;
  env.options.scene.updateMatrixWorld(true);
  const before = env.head.position.clone();
  controller.dispatchEvent({ type: "select" });
  assert.equal(env.floorSelections.length, 1);
  xr.update();
  assert.ok(env.head.position.equals(before));
  xr.setShoppingState({ offers: [{ id: "sku-1", label: "Chair" }], pendingOfferId: "sku-1" });
  controller.dispatchEvent({ type: "select" });
  assert.equal(env.floorSelections.length, 2);
  xr.update();
  assert.ok(env.head.position.equals(before));
  xr.dispose();
});

test("right stick snap turn latches until recentered", async () => {
  const env = environment(); const xr = createWorkspaceXR(env.options);
  await xr.enter(); xr.update();
  const source = { handedness: "right", gamepad: { axes: [0, 0, 1, 0] } };
  env.controllers[1].dispatchEvent({ type: "connected", data: source });
  xr.update();
  const rig = env.options.scene.getObjectByName("workspace-xr-rig");
  assert.ok(Math.abs(rig.rotation.y + Math.PI / 6) < 1e-10);
  xr.update(); xr.update();
  assert.ok(Math.abs(rig.rotation.y + Math.PI / 6) < 1e-10);
  source.gamepad.axes[2] = 0; xr.update();
  source.gamepad.axes[2] = 1; xr.update();
  assert.ok(Math.abs(rig.rotation.y + Math.PI / 3) < 1e-10);
  xr.dispose();
});

test("entry requests the session synchronously in the user gesture without awaiting support detection", async () => {
  const env = environment(); let requested = false;
  env.system.isSessionSupported = () => { throw new Error("must not check support during entry"); };
  const originalRequest = env.system.requestSession;
  env.system.requestSession = (...args) => { requested = true; return originalRequest(...args); };
  const xr = createWorkspaceXR(env.options);
  const entering = xr.enter();
  assert.equal(requested, true);
  await entering; xr.dispose();
});

test("unsafe rooms reject entry before requesting a browser session", async () => {
  const env = environment(); let requested = false;
  env.options.isFloorSpotValid = () => false;
  env.system.requestSession = async () => { requested = true; throw new Error("unexpected request"); };
  const xr = createWorkspaceXR(env.options);
  await assert.rejects(xr.enter(), /No clear floor/);
  assert.equal(requested, false); assert.equal(xr.active, false);
  assert.equal(env.options.camera.parent, env.original.parent);
  xr.dispose();
});

test("external session end restores state once and reentry reuses exactly two controller listeners", async () => {
  const env = environment(); const xr = createWorkspaceXR(env.options);
  await xr.enter(); xr.update();
  await env.getSession().end();
  assert.deepEqual(env.changes, [true, false]);
  assert.equal(xr.active, false);
  await xr.enter(); xr.update();
  const rig = env.options.scene.getObjectByName("workspace-xr-rig");
  assert.equal(rig.children.filter((node) => env.controllers.includes(node)).length, 2);
  assert.ok(env.controllers.every((c) => c._listeners.select.length === 1));
  assert.ok(Math.abs(env.head.position.y - 1.72) < 1e-10);
  await xr.exit(); assert.deepEqual(env.changes, [true, false, true, false]);
  xr.dispose();
});

test("disposing while browser permission is pending ends the late session without reparenting the camera", async () => {
  const env = environment(); const gate = deferred();
  const request = env.system.requestSession;
  let lateSession, endCount = 0;
  env.system.requestSession = async (...args) => {
    lateSession = await request(...args);
    const end = lateSession.end; lateSession.end = async () => { endCount++; await end(); };
    await gate.promise; return lateSession;
  };
  const xr = createWorkspaceXR(env.options); const entering = xr.enter();
  xr.dispose(); gate.resolve(); await entering;
  assert.equal(endCount, 1); assert.equal(xr.active, false);
  assert.equal(env.options.camera.parent, env.original.parent);
  assert.ok(env.options.camera.position.equals(env.original.position));
  assert.equal(env.options.scene.getObjectByName("workspace-xr-rig"), undefined);
  assert.deepEqual(env.changes, []);
});

test("disposing while renderer initialization is pending restores camera and prevents late activation", async () => {
  const env = environment(); const gate = deferred(), enteredRenderer = deferred();
  env.xrManager.setSession = async () => { enteredRenderer.resolve(); await gate.promise; };
  const xr = createWorkspaceXR(env.options); const entering = xr.enter();
  await enteredRenderer.promise; xr.dispose(); gate.resolve(); await entering;
  assert.equal(xr.active, false);
  assert.equal(env.options.camera.parent, env.original.parent);
  assert.ok(env.options.camera.position.equals(env.original.position));
  assert.ok(!env.changes.includes(true));
  assert.equal(env.options.scene.getObjectByName("workspace-xr-shopping"), undefined);
});

test("concurrent entry attempts request one session, and inactive/disposed frames do no camera work", async () => {
  const env = environment(); const gate = deferred(); const request = env.system.requestSession;
  let requests = 0;
  env.system.requestSession = async (...args) => { requests++; const session = await request(...args); await gate.promise; return session; };
  const xr = createWorkspaceXR(env.options); xr.update();
  assert.equal(env.getCameraUpdates(), 0);
  const first = xr.enter(), second = xr.enter(); gate.resolve(); await Promise.all([first, second]);
  assert.equal(requests, 1); xr.update(); assert.ok(env.getCameraUpdates() > 0);
  await xr.exit(); const count = env.getCameraUpdates(); xr.update(); assert.equal(env.getCameraUpdates(), count);
  xr.dispose(); xr.update(); assert.equal(env.getCameraUpdates(), count);
  await assert.rejects(xr.enter(), /closed/);
});

test("lost controller pose cannot select a stale ray or commit an armed teleport", async () => {
  const env = environment(); const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update();
  const controller = env.controllers[0], source = { handedness: "left", gamepad: { axes: [0, 0, 0, -1] } };
  controller.position.set(0, 1, 0); controller.rotation.x = -Math.PI / 4;
  controller.dispatchEvent({ type: "connected", data: source });
  env.options.scene.getObjectByName("workspace-xr-shopping").visible = false;
  const before = env.head.position.clone(); xr.update();
  assert.equal(env.options.scene.getObjectByName("workspace-xr-teleport-target").visible, true);
  controller.visible = false; source.gamepad.axes[3] = 0;
  controller.dispatchEvent({ type: "select" }); xr.update();
  assert.equal(env.floorSelections.length, 0);
  assert.ok(env.head.position.equals(before));
  assert.equal(env.options.scene.getObjectByName("workspace-xr-teleport-target").visible, false);
  xr.dispose();
});

test("current tracked controller matrix is used without waiting for renderer traversal", async () => {
  const env = environment(); const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update();
  env.options.scene.getObjectByName("workspace-xr-shopping").visible = false;
  const controller = env.controllers[1]; controller.matrixAutoUpdate = false;
  controller.matrix.makeRotationX(-Math.PI / 4); controller.matrix.setPosition(0, 1, 0);
  controller.matrixWorldNeedsUpdate = true;
  controller.dispatchEvent({ type: "select" });
  assert.equal(env.floorSelections.length, 1);
  xr.dispose();
});

test("session visibility loss cancels armed teleport and ignores triggers while browser UI has focus", async () => {
  const env = environment(); const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update();
  const controller = env.controllers[0], source = { handedness: "left", gamepad: { axes: [0, 0, 0, -1] } };
  controller.position.set(0, 1, 0); controller.rotation.x = -Math.PI / 4;
  controller.dispatchEvent({ type: "connected", data: source });
  env.options.scene.getObjectByName("workspace-xr-shopping").visible = false;
  const before = env.head.position.clone(); xr.update();
  env.getSession().visibilityState = "visible-blurred"; source.gamepad.axes[3] = 0;
  controller.dispatchEvent({ type: "select" }); xr.update();
  assert.equal(env.floorSelections.length, 0); assert.ok(env.head.position.equals(before));
  env.getSession().visibilityState = "visible"; xr.update();
  assert.ok(env.head.position.equals(before));
  xr.dispose();
});

test("destinations are revalidated on release if a placement blocks the previously clear floor", async () => {
  const env = environment(); const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update();
  const controller = env.controllers[0], source = { handedness: "left", gamepad: { axes: [0, 0, 0, -1] } };
  controller.position.set(0, 1, 0); controller.rotation.x = -Math.PI / 4;
  controller.dispatchEvent({ type: "connected", data: source });
  env.options.scene.getObjectByName("workspace-xr-shopping").visible = false;
  const before = env.head.position.clone(); xr.update();
  env.options.isFloorSpotValid = () => false; source.gamepad.axes[3] = 0; xr.update();
  assert.ok(env.head.position.equals(before));
  controller.dispatchEvent({ type: "select" }); assert.equal(env.floorSelections.length, 0);
  xr.dispose();
});

test("HUD bounds large result sets and text, suppresses unbound confirmation, and deduplicates redraws", async () => {
  const env = environment(); const confirms = []; env.options.onConfirmOffer = () => confirms.push(true);
  const xr = createWorkspaceXR(env.options);
  const state = { offers: Array.from({ length: 10000 }, (_, i) => ({ id: `sku-${i}`, label: "chair".repeat(1000), detail: "merchant".repeat(1000) })),
    selectedItemLabel: "selected".repeat(1000), status: "status".repeat(1000), pendingOfferId: "missing-sku", canConfirm: true };
  drawnText.length = 0; xr.setShoppingState(state);
  const hud = env.options.scene.getObjectByName("workspace-xr-shopping");
  const panel = hud.getObjectByName("workspace-xr-menu"), texture = panel.material.map;
  assert.equal(hud.children.length, 3); // one menu texture + two pointer dots
  assert.equal(xr.menuTargets.filter((target) => target.id.startsWith("preview:")).length, 3);
  assert.ok(!xr.menuTargets.some((target) => target.id === "confirm"));
  assert.ok(drawnText.every((text) => text.length <= 300));
  const version = texture.version; xr.setShoppingState(state);
  assert.equal(texture.version, version); // no redraws for identical state
  await xr.enter(); xr.update(); pointMenu(env.controllers[1], xr, env.options.scene, "preview:sku-2");
  assert.deepEqual(confirms, []);
  let disposedGeometry = 0; panel.geometry.addEventListener("dispose", () => disposedGeometry++);
  xr.setShoppingState({ offers: [], canConfirm: true });
  assert.equal(disposedGeometry, 0); assert.equal(hud.children.length, 3);
  xr.dispose(); assert.equal(disposedGeometry, 1);
});

test("a valid desktop-selected offer beyond the first three remains visible and confirmable in VR", async () => {
  const env = environment(); const previews = [], confirms = [];
  env.options.onPreviewOffer = (id) => previews.push(id); env.options.onConfirmOffer = () => confirms.push(true);
  const xr = createWorkspaceXR(env.options);
  xr.setShoppingState({ offers: Array.from({ length: 6 }, (_, i) => ({ id: `sku-${i}`, label: `Chair ${i}` })), pendingOfferId: "sku-5", canConfirm: true });
  await xr.enter(); xr.update();
  assert.ok(xr.menuTargets.some((target) => target.id === "preview:sku-5"));
  pointMenu(env.controllers[1], xr, env.options.scene, "preview:sku-5");
  assert.deepEqual(previews, ["sku-5"]); assert.deepEqual(confirms, []);
  pointMenu(env.controllers[1], xr, env.options.scene, "confirm");
  assert.deepEqual(confirms, [true]); xr.dispose();
});

test("nonfinite gamepad samples cancel teleport instead of committing the last tracked destination", async () => {
  const env = environment(); const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update();
  const controller = env.controllers[0], source = { handedness: "left", gamepad: { axes: [0, 0, 0, -1] } };
  controller.position.set(0, 1, 0); controller.rotation.x = -Math.PI / 4;
  controller.dispatchEvent({ type: "connected", data: source });
  env.options.scene.getObjectByName("workspace-xr-shopping").visible = false;
  const before = env.head.position.clone(); xr.update();
  source.gamepad.axes[3] = NaN; xr.update();
  assert.ok(env.head.position.equals(before));
  assert.equal(env.options.scene.getObjectByName("workspace-xr-teleport-target").visible, false);
  source.gamepad.axes[3] = 0; xr.update();
  assert.ok(env.head.position.equals(before)); xr.dispose();
});

test("browser support failure is explained and permission denial leaves the viewer usable", async () => {
  const env = environment(); const errors = []; env.options.onError = (error) => errors.push(error);
  env.system.isSessionSupported = async () => { throw new Error("Permission denied"); };
  assert.match((await checkWorkspaceXRSupport()).reason, /permissions/);
  env.system.requestSession = async () => { throw new Error("Immersive permission denied"); };
  const xr = createWorkspaceXR(env.options);
  await assert.rejects(xr.enter(), /permission denied/);
  assert.equal(xr.active, false); assert.equal(env.options.camera.parent, env.original.parent);
  assert.ok(env.options.camera.position.equals(env.original.position));
  assert.deepEqual(errors, ["Immersive permission denied"]);
  assert.deepEqual(env.changes, []); xr.dispose();
});

test("Quest thumbstick reads xr-standard axes, removes drift, caps diagonals and refuses nonfinite input", () => {
  assert.deepEqual(readXRThumbstick([0, 0, 0, -1]), { right: 0, forward: 1 });
  assert.deepEqual(readXRThumbstick([1, 0]), { right: 1, forward: -0 });
  assert.deepEqual(readXRThumbstick([0, 0, .1, -.1]), { right: 0, forward: 0 });
  const diagonal = readXRThumbstick([0, 0, 1, -1]);
  assert.ok(Math.abs(Math.hypot(diagonal.right, diagonal.forward) - 1) < 1e-10);
  assert.equal(readXRThumbstick([0, 0, NaN, -1]), null);
  assert.equal(readXRThumbstick([0]), null);
});

test("default locomotion walks immediately with the left stick, relative to the head, preserving tracked height", async () => {
  const env = environment(); delete env.options.locomotion;
  const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update();
  const source = { handedness: "left", gamepad: { axes: [0, 0, 0, -1] } };
  env.controllers[0].dispatchEvent({ type: "connected", data: source });
  const before = env.head.position.clone(); xr.update(.05);
  assert.ok(env.head.position.z < before.z - .05);
  assert.equal(env.head.position.y, before.y);
  env.head.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const turned = env.head.position.clone(); xr.update(.05);
  assert.ok(env.head.position.x < turned.x - .05);
  assert.ok(Math.abs(env.head.position.z - turned.z) < 1e-10);
  const rig = env.options.scene.getObjectByName("workspace-xr-rig");
  assert.equal(rig.position.y, 0); assert.deepEqual(rig.scale.toArray(), [1, 1, 1]);
  source.gamepad.axes[3] = NaN; const stopped = env.head.position.clone(); xr.update(.05);
  assert.ok(env.head.position.equals(stopped)); xr.dispose();
});

test("walking clamps long frames, slides against blocked floor, and delegates swept collision to the shared solver", () => {
  const rig = new THREE.Group(), head = new THREE.Vector3(0, 1.72, 0), orientation = new THREE.Quaternion();
  walkXR(rig, head, orientation, { forward: 1, right: 0 }, 50, () => true);
  assert.ok(Math.abs(rig.position.z + .065) < 1e-10);
  rig.position.set(0, 0, 0);
  walkXR(rig, head, orientation, { forward: 1, right: 1 }, .05, (point) => point.z >= -.01);
  assert.ok(rig.position.x > 0); assert.equal(rig.position.z, 0);
  let called = false;
  walkXR(rig, head, orientation, { forward: 1, right: 0 }, 1, () => true, (position, input, dt) => {
    called = true; assert.ok(dt <= .05); assert.equal(input.forward, 1); assert.equal(Math.abs(input.yaw), 0);
    return position.clone().add(new THREE.Vector3(.01, 99, -.02));
  });
  assert.ok(called); assert.equal(rig.position.y, 0);
});

test("walking pauses for browser UI and requires a neutral stick before moving again", async () => {
  const env = environment(); delete env.options.locomotion;
  const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update();
  const source = { handedness: "left", gamepad: { axes: [0, 0, 0, -1] } };
  env.controllers[0].dispatchEvent({ type: "connected", data: source }); xr.update(.05);
  const before = env.head.position.clone(); env.getSession().visibilityState = "visible-blurred"; xr.update(.05);
  env.getSession().visibilityState = "visible"; xr.update(.05);
  assert.ok(env.head.position.equals(before));
  source.gamepad.axes[3] = 0; xr.update(.05); source.gamepad.axes[3] = -1; xr.update(.05);
  assert.ok(env.head.position.z < before.z); xr.dispose();
});

test("walking and snap-turning in the same frame rotate around the moved head without lateral drift", async () => {
  const env = environment(); delete env.options.locomotion;
  const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update();
  env.controllers[0].dispatchEvent({ type: "connected", data: { handedness: "left", gamepad: { axes: [0, 0, 0, -1] } } });
  env.controllers[1].dispatchEvent({ type: "connected", data: { handedness: "right", gamepad: { axes: [0, 0, 1, 0] } } });
  const before = env.head.position.clone(); xr.update(.05);
  assert.ok(Math.abs(env.head.position.x - before.x) < 1e-10);
  assert.ok(Math.abs(env.head.position.z - (before.z - .065)) < 1e-10);
  assert.equal(env.head.position.y, before.y); xr.dispose();
});

test("headset actions are bounded, disabled buttons block click-through, and movement/exit remain available", async () => {
  const env = environment(); const actions = []; env.options.onAction = (id) => actions.push(id);
  const xr = createWorkspaceXR(env.options);
  xr.setShoppingState({ offers: [], actions: [{ id: "search-chair", label: "Find chairs" }, { id: "search-rug", label: "Find rugs", disabled: true }, ...Array.from({ length: 1000 }, (_, i) => ({ id: `action-${i}`, label: "Unknown action" }))] });
  await xr.enter(); xr.update();
  assert.ok(xr.menuTargets.length <= 10);
  pointMenu(env.controllers[1], xr, env.options.scene, "action:search-chair");
  assert.deepEqual(actions, ["search-chair"]);
  pointMenu(env.controllers[1], xr, env.options.scene, "action:search-rug");
  pointMenuPixel(env.controllers[1], xr, env.options.scene, 700, 700);
  assert.deepEqual(actions, ["search-chair"]); assert.equal(env.floorSelections.length, 0);
  pointMenu(env.controllers[1], xr, env.options.scene, "tab-controls");
  pointMenu(env.controllers[1], xr, env.options.scene, "locomotion");
  assert.ok(drawnText.some((text) => text === "Use teleport"));
  pointMenu(env.controllers[1], xr, env.options.scene, "exit");
  await Promise.resolve(); assert.equal(xr.active, false); xr.dispose();
});
