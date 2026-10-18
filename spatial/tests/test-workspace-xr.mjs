import { createXRDOMFixture } from "./xr-menu-dom-fixture.mjs";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import * as THREE from "three";
import { checkWorkspaceXRSupport, createWorkspaceXR, readXRThumbstick, snapTurnXR, teleportXR, walkXR, XR_HUD_DISTANCE, XR_HUD_DROP } from "../room/workspace-xr.ts";
import { XR_MENU_WIDTH, XR_MENU_HEIGHT } from "../room/workspace-xr-menu.ts";


const dom = createXRDOMFixture();
after(() => dom.close());

function environment({ failSetSession = false, realTracking = false } = {}) {
  const controllers = [new THREE.Group(), new THREE.Group()];
  const events = new THREE.EventDispatcher();
  const head = realTracking ? new THREE.ArrayCamera() : new THREE.PerspectiveCamera();
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
  window.isSecureContext = true;
  Object.defineProperty(navigator, "xr", { configurable: true, writable: true, value: system });
  const xrManager = Object.assign(events, {
    enabled: false, setReferenceSpaceType(type) { assert.equal(type, "local-floor"); },
    setFramebufferScaleFactor() {}, getController: (i) => controllers[i], getCamera: () => head,
    updateCamera(camera) {
      cameraUpdates++;
      if (camera.parent?.name === "workspace-xr-rig") {
        if (realTracking) {
          // Real WebXR keeps an unparented ArrayCamera's local tracked pose,
          // while updateCamera writes its rig-adjusted world matrix directly.
          // Calling getWorldPosition/getWorldQuaternion here would erase that
          // distinction and mask an XR-only rig/menu transform regression.
          head.updateMatrix();
          head.matrixWorld.multiplyMatrices(camera.parent.matrixWorld, head.matrix);
          head.matrixWorldInverse.copy(head.matrixWorld).invert();
        } else {
          head.position.copy(new THREE.Vector3(.25, 1.72, -.4).applyMatrix4(camera.parent.matrixWorld));
          head.updateMatrixWorld();
        }
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
    locomotion: "teleport", menuRuntime: dom.runtime,
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
async function pointMenu(controller, xr, scene, id) {
  await xr.menuWhenIdle();
  const target = xr.menuTargets.find((item) => item.id === id);
  assert.ok(target, `missing visible menu target ${id}`);
  pointMenuPixel(controller, xr, scene, target.x + target.width / 2, target.y + target.height / 2);
  await xr.menuWhenIdle();
}

async function openShop(env, xr) {
  await pointMenu(env.controllers[1], xr, env.options.scene, "tab-shop");
  assert.equal(xr.menuTab, "shop");
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
  assert.equal(xr.menuTab, "agent", "the existing voice agent is the default VR interface");
  assert.equal(env.options.camera.position.y, 0); // tracked 1.72m, never another 1.6m added
  assert.ok(Math.abs(env.head.position.x - 1) < 1e-10);
  assert.ok(Math.abs(env.head.position.z - 2) < 1e-10);
  assert.ok(Math.abs(env.head.position.y - 1.72) < 1e-10);
  const hud = env.options.scene.getObjectByName("workspace-xr-shopping");
  assert.ok(Math.abs(Math.hypot(hud.position.x - env.head.position.x, hud.position.z - env.head.position.z) - XR_HUD_DISTANCE) < 1e-10);
  assert.ok(Math.abs(hud.position.y - (env.head.position.y - XR_HUD_DROP)) < 1e-10);
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
  const offer = { id: "sku-1", label: "Measured chair", detail: "$80 / 0.5m wide" };
  xr.setShoppingState({ offers: [offer] });
  await xr.enter(); xr.update();
  const controller = env.controllers[1];
  await openShop(env, xr);
  await pointMenu(controller, xr, env.options.scene, "preview:sku-1");
  assert.deepEqual(previews, ["sku-1"]);
  assert.deepEqual(confirmations, []);
  assert.ok(!xr.menuTargets.some((target) => target.id === "confirm"));
  xr.setShoppingState({ offers: [offer], pendingOfferId: offer.id, canConfirm: true });
  await pointMenu(controller, xr, env.options.scene, "confirm");
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
  xr.setShoppingState(state);
  const hud = env.options.scene.getObjectByName("workspace-xr-shopping");
  const panel = hud.getObjectByName("workspace-xr-menu"), texture = panel.material.map;
  assert.equal(hud.children.length, 3); // one menu texture + two pointer dots
  await xr.enter(); xr.update(); await openShop(env, xr);
  assert.equal(xr.menuTargets.filter((target) => target.id.startsWith("preview:")).length, 24);
  assert.ok(!xr.menuTargets.some((target) => target.id === "confirm"));
  assert.ok([...dom.document.querySelectorAll('[data-xr-id^="preview:"]')].every((button) => button.textContent.length < 700), "retailer text stays bounded in real DOM buttons");
  const version = texture.version; xr.setShoppingState(state); await xr.menuWhenIdle();
  assert.equal(texture.version, version); // no redraws for identical state
  await pointMenu(env.controllers[1], xr, env.options.scene, "preview:sku-2");
  assert.deepEqual(confirms, []);
  let disposedGeometry = 0; panel.geometry.addEventListener("dispose", () => disposedGeometry++);
  xr.setShoppingState({ offers: [], canConfirm: true });
  assert.equal(disposedGeometry, 0); assert.equal(hud.children.length, 3);
  xr.dispose(); assert.equal(disposedGeometry, 1);
});

test("a valid pending offer beyond the 24-offer cap remains visible and confirmable in VR", async () => {
  const env = environment(); const previews = [], confirms = [];
  env.options.onPreviewOffer = (id) => previews.push(id); env.options.onConfirmOffer = () => confirms.push(true);
  const xr = createWorkspaceXR(env.options);
  xr.setShoppingState({ offers: Array.from({ length: 50 }, (_, i) => ({ id: `sku-${i}`, label: `Chair ${i}` })), pendingOfferId: "sku-49", canConfirm: true });
  await xr.enter(); xr.update(); await openShop(env, xr);
  assert.ok(xr.menuTargets.some((target) => target.id === "preview:sku-49"));
  await pointMenu(env.controllers[1], xr, env.options.scene, "preview:sku-49");
  assert.deepEqual(previews, [], "an already-previewed pending offer cannot be previewed again");
  assert.equal(xr.menuTargets.find((target) => target.id === "preview:sku-49").disabled, true);
  assert.deepEqual(confirms, []);
  await pointMenu(env.controllers[1], xr, env.options.scene, "confirm");
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
  await xr.enter(); xr.update(); await openShop(env, xr);
  assert.ok(xr.menuTargets.length <= 20, "only known category/action controls render from an unbounded action list");
  await pointMenu(env.controllers[1], xr, env.options.scene, "action:search-chair");
  assert.deepEqual(actions, ["search-chair"]);
  await pointMenu(env.controllers[1], xr, env.options.scene, "action:search-rug");
  // Whitespace inside the catalog drawer is painted UI: it never selects the floor behind it.
  pointMenuPixel(env.controllers[1], xr, env.options.scene, 1200, 70);
  assert.deepEqual(actions, ["search-chair"]); assert.equal(env.floorSelections.length, 0);
  await pointMenu(env.controllers[1], xr, env.options.scene, "tab-controls");
  const before = dom.document.querySelector('[data-xr-id="locomotion"]').textContent;
  await pointMenu(env.controllers[1], xr, env.options.scene, "locomotion");
  // The control names the other mode, so a working toggle must change its label.
  assert.notEqual(dom.document.querySelector('[data-xr-id="locomotion"]').textContent, before);
  assert.match(dom.document.querySelector('[data-xr-id="locomotion"]').textContent, /walk|teleport/i);
  await pointMenu(env.controllers[1], xr, env.options.scene, "exit");
  await Promise.resolve(); assert.equal(xr.active, false); xr.dispose();
});


function trackedWorldPosition(head) {
  return new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
}

function assertMenuFollowsHead(env) {
  const hud = env.options.scene.getObjectByName("workspace-xr-shopping");
  const head = trackedWorldPosition(env.head);
  assert.ok(Math.abs(Math.hypot(hud.position.x - head.x, hud.position.z - head.z) - XR_HUD_DISTANCE) < 1e-8,
    "menu keeps its distance from the rig-adjusted tracked head");
  assert.ok(Math.abs(hud.position.y - head.y + XR_HUD_DROP) < 1e-8, "menu rests below tracked eye height");
  // It faces the eyes: its normal points from the panel back up to the head.
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(hud.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(normal.angleTo(head.clone().sub(hud.position).normalize()) < 1e-6, "menu is tilted to face the wearer");
  // The tablet tilt is fixed by the rest position; looking up or down never changes it, and it never rolls.
  const euler = new THREE.Euler().setFromQuaternion(hud.quaternion, "YXZ");
  assert.ok(Math.abs(euler.x + Math.atan2(XR_HUD_DROP, XR_HUD_DISTANCE)) < 1e-8 && Math.abs(euler.z) < 1e-8, "head pitch never tilts menu");
  return hud;
}

test("real ArrayCamera local tracking stays distinct from world pose through spawn, physical motion and walking", async () => {
  const env = environment({ realTracking: true }); delete env.options.locomotion;
  const localStart = env.head.position.clone();
  const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update();
  const spawnHead = trackedWorldPosition(env.head);
  assert.ok(spawnHead.distanceTo(new THREE.Vector3(1, 1.72, 2)) < 1e-8);
  assert.ok(env.head.position.equals(localStart), "XR local position is not rewritten into world coordinates");
  const hud = assertMenuFollowsHead(env), beforeMenu = hud.position.clone();
  // Natural sway while aiming must not slide buttons out from under the ray.
  env.head.position.add(new THREE.Vector3(.05, -.02, .04)); xr.update(.05);
  assert.ok(hud.position.distanceTo(beforeMenu) < 1e-8, "a few centimetres of head sway leaves the menu still");
  // A real step moves it: it glides after the head and settles at the usual offset.
  env.head.position.add(new THREE.Vector3(.17, -.06, -.16));
  for (let frame = 0; frame < 60; frame++) xr.update(.05);
  assertMenuFollowsHead(env);
  const beforeWalk = trackedWorldPosition(env.head);
  env.controllers[0].dispatchEvent({ type: "connected", data: { handedness: "left", gamepad: { axes: [0, 0, 0, -1] } } });
  xr.update(.05);
  const afterWalk = trackedWorldPosition(env.head);
  assert.ok(afterWalk.distanceTo(beforeWalk.clone().add(new THREE.Vector3(0, 0, -.065))) < 1e-8, "walking still moves one step per frame");
  for (let frame = 0; frame < 20; frame++) xr.update(.05);
  env.controllers[0].dispatchEvent({ type: "connected", data: { handedness: "left", gamepad: { axes: [0, 0, 0, 0] } } });
  for (let frame = 0; frame < 60; frame++) xr.update(.05);
  assertMenuFollowsHead(env); xr.dispose();
});

test("real tracked yaw follows outside the menu deadzone while small turns and pitch preserve aim", async () => {
  const env = environment({ realTracking: true });
  const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update();
  const hud = assertMenuFollowsHead(env), initialPosition = hud.position.clone(), initialRotation = hud.quaternion.clone();
  env.head.quaternion.setFromEuler(new THREE.Euler(.35, .06, 0, "YXZ"));
  xr.update(.05);
  assert.ok(hud.position.distanceTo(initialPosition) < 1e-8, "small glance does not make targets chase the pointer");
  assert.ok(hud.quaternion.angleTo(initialRotation) < 1e-8);
  env.head.quaternion.setFromEuler(new THREE.Euler(.35, .8, 0, "YXZ"));
  for (let frame = 0; frame < 120; frame++) xr.update(1 / 72);
  assert.ok(hud.position.distanceTo(initialPosition) > .25, "larger turn brings menu around automatically");
  assertMenuFollowsHead(env);
  const offset = hud.position.clone().sub(trackedWorldPosition(env.head)); offset.y = 0; offset.normalize();
  const forward = new THREE.Vector3(0, 0, -1).transformDirection(env.head.matrixWorld); forward.y = 0; forward.normalize();
  assert.ok(offset.angleTo(forward) < .25, "menu settles within the documented yaw deadzone");
  xr.dispose();
});

test("real XR walking and snap-turn preserve head pivot and immediately recenter the following menu", async () => {
  const env = environment({ realTracking: true }); delete env.options.locomotion;
  const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update();
  env.controllers[0].dispatchEvent({ type: "connected", data: { handedness: "left", gamepad: { axes: [0, 0, 0, -1] } } });
  env.controllers[1].dispatchEvent({ type: "connected", data: { handedness: "right", gamepad: { axes: [0, 0, 1, 0] } } });
  const before = trackedWorldPosition(env.head); xr.update(.05);
  const after = trackedWorldPosition(env.head);
  assert.ok(after.distanceTo(before.clone().add(new THREE.Vector3(0, 0, -.065))) < 1e-8, "snap pivots around the moved head");
  const hud = assertMenuFollowsHead(env), offset = hud.position.clone().sub(after); offset.y = 0; offset.normalize();
  const forward = new THREE.Vector3(0, 0, -1).transformDirection(env.head.matrixWorld); forward.y = 0; forward.normalize();
  assert.ok(offset.angleTo(forward) < 1e-8, "snap turn recenters menu immediately rather than waiting for yaw damping");
  xr.dispose();
});

test("real XR teleport release moves the menu with the wearer in the same frame", async () => {
  const env = environment({ realTracking: true });
  const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update();
  const controller = env.controllers[0], source = { handedness: "left", gamepad: { axes: [0, 0, 0, -1] } };
  controller.position.set(0, 1, 0); controller.rotation.x = -Math.PI / 4;
  controller.dispatchEvent({ type: "connected", data: source });
  const before = trackedWorldPosition(env.head); xr.update(.05);
  assert.equal(env.options.scene.getObjectByName("workspace-xr-teleport-target").visible, true);
  source.gamepad.axes[3] = 0; xr.update(.05);
  assert.ok(trackedWorldPosition(env.head).distanceTo(before) > .1);
  assertMenuFollowsHead(env); xr.dispose();
});

test("pitched tracked controller beam, menu cursor and activated target share the exact world hit", async () => {
  const env = environment({ realTracking: true }), previews = [];
  env.options.onPreviewOffer = (id) => previews.push(id);
  const xr = createWorkspaceXR(env.options);
  xr.setShoppingState({ offers: [{ id: "sku:pitch-test", label: "Measured chair" }] });
  await xr.enter(); xr.update(); await openShop(env, xr);
  const controller = env.controllers[1];
  controller.dispatchEvent({ type: "connected", data: { handedness: "right", gamepad: { axes: [0, 0, 0, 0] } } });
  const rig = env.options.scene.getObjectByName("workspace-xr-rig");
  snapTurnXR(rig, trackedWorldPosition(env.head), Math.PI / 5);
  for (let frame = 0; frame < 120; frame++) xr.update(1 / 72);
  await xr.menuWhenIdle();
  const menu = env.options.scene.getObjectByName("workspace-xr-menu");
  const target = xr.menuTargets.find((item) => item.id === "preview:sku:pitch-test");
  assert.ok(target);
  menu.updateWorldMatrix(true, false);
  const targetLocal = new THREE.Vector3(((target.x + target.width / 2) / XR_MENU_WIDTH - .5) * 1.04,
    (.5 - (target.y + target.height / 2) / XR_MENU_HEIGHT) * 1.04 * XR_MENU_HEIGHT / XR_MENU_WIDTH, 0);
  const expectedHit = menu.localToWorld(targetLocal.clone());
  const origin = menu.localToWorld(targetLocal.clone().add(new THREE.Vector3(.24, -.2, .55)));
  const trackedWorld = new THREE.Matrix4().lookAt(origin, expectedHit, new THREE.Vector3(0, 1, 0));
  trackedWorld.setPosition(origin);
  controller.matrixAutoUpdate = false;
  controller.matrix.copy(controller.parent.matrixWorld).invert().multiply(trackedWorld);
  controller.matrixWorldNeedsUpdate = true;
  // Do not traverse scene: the next update must use this frame's tracked matrix.
  xr.update();
  const line = controller.getObjectByName("workspace-xr-controller-ray"); assert.ok(line, "controller owns the visual laser");
  line.updateWorldMatrix(true, false);
  const endpoint = line.localToWorld(new THREE.Vector3(0, 0, -1));
  const hud = env.options.scene.getObjectByName("workspace-xr-shopping");
  const dot = hud.children.find((child) => child.geometry?.type === "CircleGeometry" && child.visible);
  assert.ok(dot, "visible cursor belongs to the current hit");
  assert.ok(endpoint.distanceTo(expectedHit) < 1e-8, "laser ends on the exact panel hit");
  assert.ok(dot.getWorldPosition(new THREE.Vector3()).distanceTo(expectedHit) < 1e-8, "cursor matches the laser without panel-normal offset");
  assert.equal(line.material.depthTest, false); assert.equal(line.renderOrder, 21);
  assert.equal(line.material.transparent, true, "laser shares the transparent overlay render queue with the menu");
  assert.equal(dot.material.transparent, true, "cursor is rendered after the transparent menu");
  controller.dispatchEvent({ type: "select" }); assert.deepEqual(previews, ["sku:pitch-test"]);
  controller.matrix.makeTranslation(0, 1, 1); controller.matrixWorldNeedsUpdate = true;
  xr.update();
  assert.equal(line.scale.z, 6); assert.equal(line.material.depthTest, true); assert.equal(line.renderOrder, 0);
  assert.equal(dot.visible, false); xr.dispose();
});


test("Agent remains the default VR interface and confirms an arriving placement without navigating to Shop", async () => {
  const env = environment(), confirmations = [];
  env.options.onConfirmOffer = () => confirmations.push(true);
  const xr = createWorkspaceXR(env.options);
  await xr.enter(); xr.update();
  assert.equal(xr.menuTab, "agent");
  xr.setShoppingState({ offers: [{ id: "agent:chair", label: "Agent-selected chair" }],
    pendingOfferId: "agent:chair", canConfirm: true });
  await xr.menuWhenIdle();
  assert.equal(xr.menuTab, "agent", "an agent placement preview never redirects the wearer to manual catalog browsing");
  const confirm = xr.menuTargets.find((target) => target.id === "confirm");
  assert.ok(confirm && !confirm.disabled, "the placement confirmation is available directly in Agent");
  await pointMenu(env.controllers[1], xr, env.options.scene, "confirm");
  assert.deepEqual(confirmations, [true]);
  assert.equal(xr.menuTab, "agent"); xr.dispose();
});

function aimControllerAtMenu(env, index) {
  const menu = env.options.scene.getObjectByName("workspace-xr-menu"), controller = env.controllers[index];
  menu.updateWorldMatrix(true, false);
  const target = menu.localToWorld(new THREE.Vector3(0, 0, 0));
  const origin = menu.localToWorld(new THREE.Vector3(.12, -.1, .6));
  const world = new THREE.Matrix4().lookAt(origin, target, new THREE.Vector3(0, 1, 0)); world.setPosition(origin);
  controller.matrixAutoUpdate = false;
  controller.matrix.copy(controller.parent.matrixWorld).invert().multiply(world); controller.matrixWorldNeedsUpdate = true;
  return controller;
}
function scrollableDOMPanel() {
  const scroller = dom.document.querySelector("[data-xr-scroll]"); assert.ok(scroller, "real mounted panel has a scroll container");
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1600 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
  return scroller;
}

test("aiming at the real DOM panel scrolls with the right stick without snap-turning while left walking remains available", async () => {
  const env = environment({ realTracking: true }); delete env.options.locomotion;
  const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update(); await xr.menuWhenIdle();
  // Lists scroll inside a drawer, as on the website; the open room has nothing to scroll.
  xr.setShoppingState({ offers: [{ id: "sku-1", label: "Chair" }] }); await openShop(env, xr);
  const scroller = scrollableDOMPanel();
  aimControllerAtMenu(env, 1);
  env.controllers[1].dispatchEvent({ type: "connected", data: { handedness: "right", gamepad: { axes: [0, 0, 1, 1] } } });
  env.controllers[0].dispatchEvent({ type: "connected", data: { handedness: "left", gamepad: { axes: [0, 0, 0, -1] } } });
  const before = trackedWorldPosition(env.head); xr.update(.05);
  assert.equal(scroller.scrollTop, 26, "right vertical stick scrolls in CSS pixels at the bounded frame delta");
  assert.equal(env.options.scene.getObjectByName("workspace-xr-rig").rotation.y, 0, "horizontal right input cannot turn the room while pointing at menu");
  assert.ok(trackedWorldPosition(env.head).distanceTo(before.clone().add(new THREE.Vector3(0, 0, -.065))) < 1e-8);
  await xr.menuWhenIdle(); xr.dispose();
});

test("browser focus recovery requires a neutral right stick before panel scrolling resumes", async () => {
  const env = environment({ realTracking: true });
  const xr = createWorkspaceXR(env.options); await xr.enter(); xr.update(); await xr.menuWhenIdle();
  // Lists scroll inside a drawer, as on the website; the open room has nothing to scroll.
  xr.setShoppingState({ offers: [{ id: "sku-1", label: "Chair" }] }); await openShop(env, xr);
  const scroller = scrollableDOMPanel(), source = { handedness: "right", gamepad: { axes: [0, 0, 0, 1] } };
  aimControllerAtMenu(env, 1); env.controllers[1].dispatchEvent({ type: "connected", data: source });
  env.getSession().visibilityState = "visible-blurred"; xr.update(.05);
  env.getSession().visibilityState = "visible"; xr.update(.05);
  assert.equal(scroller.scrollTop, 0, "held browser/system stick input cannot scroll on resume");
  source.gamepad.axes[3] = 0; xr.update(.05);
  source.gamepad.axes[3] = 1; xr.update(.05); assert.equal(scroller.scrollTop, 26);
  await xr.menuWhenIdle(); xr.dispose();
});

test("holding A or X talks to the agent and releasing sends, without aiming at the menu", async () => {
  const env = environment(); const actions = []; env.options.onAction = (id) => actions.push(id);
  const xr = createWorkspaceXR(env.options);
  const voice = (disabled = false) => xr.setShoppingState({ offers: [], actions: [{ id: "voice-toggle", label: "Talk", disabled }],
    agent: { available: true, connected: false, listening: false, status: "" } });
  voice(); await xr.enter(); xr.update();
  const buttons = Array.from({ length: 6 }, () => ({ pressed: false })), source = { handedness: "right", gamepad: { axes: [0, 0, 0, 0], buttons } };
  env.controllers[1].dispatchEvent({ type: "connected", data: source });
  // The voice session's own hold-to-talk: one press while held (it stays open through connecting), one release.
  buttons[4].pressed = true; xr.update(1 / 72); xr.update(1 / 72);
  assert.deepEqual(actions, ["voice-press"]);
  buttons[4].pressed = false; xr.update(1 / 72); xr.update(1 / 72);
  assert.deepEqual(actions, ["voice-press", "voice-release"]);
  // A system prompt (microphone permission) taking focus mid-hold ends the hold cleanly, once.
  buttons[4].pressed = true; xr.update(1 / 72);
  env.getSession().visibilityState = "visible-blurred"; xr.update(1 / 72); xr.update(1 / 72);
  assert.deepEqual(actions.slice(2), ["voice-press", "voice-release"]);
  env.getSession().visibilityState = "visible"; buttons[4].pressed = false; xr.update(1 / 72);
  assert.equal(actions.length, 4, "a release after the prompt is not sent twice");
  // Voice unavailable on this server: the button does nothing, and no orphan release follows.
  voice(true); buttons[4].pressed = true; xr.update(1 / 72); buttons[4].pressed = false; xr.update(1 / 72);
  assert.equal(actions.length, 4); xr.dispose();
});
