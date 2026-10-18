import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { canNavigateAt, createFirstPersonNavigation, createNavigationWorld, findNavigationSpawn, isNavigationInputTarget, moveNavigation } from "../room/navigation.ts";

function plan({ polygon = [[0, 0], [10, 0], [10, 10], [0, 10]], walls = [], openings = [], items = [] } = {}) {
  return { geometry: { rooms: [{ id: "room", height: 3, floorPolygon: polygon }], walls, openings }, items, products: [] };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const wall = { id: "partition", start: [0, 5], end: [10, 5], height: 3, thickness: .1 };
const chair = { id: "chair", position: [5, 0, 5], rotationY: Math.PI / 4, dimensions: [2, 1, 1], stored: false };

test("movement is 2 m/s, Y-up and independent of normal frame frequency", () => {
  const world = createNavigationWorld(plan());
  const walk = (fps) => { let p = [5, 1.6, 5]; for (let i = 0; i < fps; i++) p = moveNavigation(world, p, { forward: 1, right: 0, yaw: 0 }, 1 / fps); return p; };
  const slow = walk(30), fast = walk(120);
  slow.forEach((n, i) => near(n, fast[i])); near(slow[0], 5); near(slow[1], 1.6); near(slow[2], 3);
  const diagonal = moveNavigation(world, [5, 1.6, 5], { forward: 1, right: 1, yaw: 0 }, .1);
  near(Math.hypot(diagonal[0] - 5, diagonal[2] - 5), .2);
  const rotated = moveNavigation(world, [5, 1.6, 5], { forward: 1, right: 0, yaw: Math.PI / 2 }, .1);
  near(rotated[0], 4.8); near(rotated[2], 5);
});

test("paused frame is capped and sprint cannot tunnel through a thin wall", () => {
  const world = createNavigationWorld(plan({ walls: [wall] }));
  let p = [5, 1.6, 4.7];
  for (let i = 0; i < 20; i++) p = moveNavigation(world, p, { forward: -1, right: 0, yaw: 0, sprint: true }, 8);
  assert.ok(p[2] <= 4.77 + 1e-7); assert.ok(canNavigateAt(world, [p[0], p[2]]));
  const empty = createNavigationWorld(plan());
  const capped = moveNavigation(empty, [5, 1.6, 5], { forward: 1, right: 0, yaw: 0 }, 9);
  near(capped[2], 4.8);
});

test("a standing-height door allows passage, a window and low lintel block it", () => {
  const opening = { id: "door", wallId: wall.id, kind: "door", offset: 4.5, width: 1, height: 2.1, sillHeight: 0 };
  const walkThrough = (world) => { let p = [5, 1.6, 4.5]; for (let i = 0; i < 20; i++) p = moveNavigation(world, p, { forward: -1, right: 0, yaw: 0 }, 1 / 30); return p; };
  const world = createNavigationWorld(plan({ walls: [wall], openings: [opening] }));
  assert.ok(walkThrough(world)[2] > 5.5);
  assert.ok(!canNavigateAt(world, [4.55, 5]), "body radius clears the door jamb");
  for (const adjusted of [{ ...opening, kind: "window" }, { ...opening, height: 1.4 }, { ...opening, sillHeight: .5 }]) {
    assert.ok(walkThrough(createNavigationWorld(plan({ walls: [wall], openings: [adjusted] })))[2] < 5);
  }
});

test("oriented furniture collision follows bottom-center dimensions and slides along sides", () => {
  const world = createNavigationWorld(plan({ items: [chair] }));
  assert.equal(canNavigateAt(world, [5, 5]), false);
  assert.equal(canNavigateAt(world, [5.7, 4.3]), false, "long axis rotates toward -Z");
  assert.equal(canNavigateAt(world, [5.8, 5.8]), true, "short axis is not replaced by an overlarge axis-aligned box");
  const straight = createNavigationWorld(plan({ items: [{ ...chair, rotationY: 0 }] }));
  let p = [3.7, 1.6, 5.5];
  for (let i = 0; i < 30; i++) p = moveNavigation(straight, p, { forward: 1, right: 1, yaw: 0 }, 1 / 60);
  assert.ok(canNavigateAt(straight, [p[0], p[2]])); assert.ok(p[2] < 5); assert.ok(p[0] <= 3.82 + 1e-7);
});

test("stored pieces, flat rugs and overhead fixtures do not block walking", () => {
  for (const item of [{ ...chair, stored: true }, { ...chair, dimensions: [2, .02, 2] }, { ...chair, position: [5, 2, 5] }]) {
    assert.equal(canNavigateAt(createNavigationWorld(plan({ items: [item] })), [5, 5]), true);
  }
});

test("collision uses product dimensions when available and does not mutate the plan", () => {
  const raw = plan({ items: [{ ...chair, productId: "sku", dimensions: [.1, 1, .1], rotationY: 0 }] });
  raw.products = [{ id: "sku", dimensions: [2, 1, 2] }];
  const before = structuredClone(raw), world = createNavigationWorld(raw);
  assert.equal(canNavigateAt(world, [5.8, 5]), false);
  raw.items[0].position[0] = 1;
  assert.equal(canNavigateAt(world, [5, 5]), false, "world is a snapshot");
  raw.items[0].position[0] = 5; assert.deepEqual(raw, before);
});

test("spawn finds supported free floor in a concave room despite occupied or outside centroid", () => {
  const raw = plan({ polygon: [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]], items: [{ ...chair, position: [1, 0, 1], rotationY: 0, dimensions: [1.5, 1, 1.5] }] });
  const world = createNavigationWorld(raw), spawn = findNavigationSpawn(world);
  assert.equal(spawn.ok, true); assert.ok(canNavigateAt(world, [spawn.position[0], spawn.position[2]])); near(spawn.position[1], 1.6);
  assert.equal(canNavigateAt(world, [3, 3]), false); assert.equal(canNavigateAt(world, [.1, 3]), false, "body must stay on the floor");
  assert.deepEqual(findNavigationSpawn(world, [1, 4]), { ok: true, position: [1, 1.6, 4] });
});

test("adjacent floor polygons support doorway crossing without a fake internal boundary", () => {
  const raw = plan({ walls: [wall], openings: [{ wallId: wall.id, kind: "door", offset: 4, width: 2, height: 2.2, sillHeight: 0 }] });
  raw.geometry.rooms = [{ height: 3, floorPolygon: [[0, 0], [10, 0], [10, 5], [0, 5]] }, { height: 3, floorPolygon: [[0, 5], [10, 5], [10, 10], [0, 10]] }];
  assert.ok(canNavigateAt(createNavigationWorld(raw), [5, 5]));
});

test("no safe standing position and too-low ceilings explicitly disable navigation", () => {
  const blocked = createNavigationWorld(plan({ items: [{ ...chair, rotationY: 0, dimensions: [10, 2, 10] }] }));
  assert.equal(findNavigationSpawn(blocked).ok, false);
  const raw = plan(); raw.geometry.rooms[0].height = 1.5;
  assert.match(findNavigationSpawn(createNavigationWorld(raw)).reason, /no supported floor/);
});

test("invalid move input cannot poison the camera position", () => {
  const world = createNavigationWorld(plan()), p = [5, 1.6, 5];
  assert.deepEqual(moveNavigation(world, p, { forward: NaN, right: 0, yaw: 0 }, .01), p);
  assert.deepEqual(moveNavigation(world, p, { forward: 1, right: 0, yaw: Infinity }, .01), p);
  assert.deepEqual(moveNavigation(world, p, { forward: 1, right: 0, yaw: 0 }, -1), p);
});

class Surface extends EventTarget {
  constructor() { super(); this.tabIndex = -1; this.listeners = new Map(); }
  addEventListener(type, listener, options) { super.addEventListener(type, listener, options); if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener, options) { super.removeEventListener(type, listener, options); this.listeners.get(type)?.delete(listener); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  setPointerCapture() {}
  closest() { return null; }
}
function fixtureController(sharedDocument, callbacks = {}) {
  const doc = sharedDocument ?? new Surface(), win = doc.defaultView ?? new Surface(), canvas = new Surface();
  doc.defaultView = win; canvas.ownerDocument = doc; doc.pointerLockElement = null;
  doc.exitPointerLock = () => { doc.pointerLockElement = null; doc.dispatchEvent(new Event("pointerlockchange")); };
  canvas.requestPointerLock = () => { doc.pointerLockElement = canvas; doc.dispatchEvent(new Event("pointerlockchange")); return Promise.resolve(); };
  const camera = { position: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } }, rotation: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } } };
  const controller = createFirstPersonNavigation(camera, canvas, createNavigationWorld(plan()), callbacks);
  const send = (target, type, values = {}) => { const event = new Event(type, { cancelable: true }); Object.assign(event, values); target.dispatchEvent(event); return event; };
  return { controller, doc, win, canvas, camera, send };
}

test("browser controller handles WASD, mobile input, Escape release, blur clearing and disposal", () => {
  const { controller, doc, win, canvas, camera, send } = fixtureController();
  controller.enter([5, 5]); near(camera.position.y, 1.6);
  const key = send(doc, "keydown", { code: "KeyW" }); assert.ok(key.defaultPrevented);
  controller.update(.1); near(camera.position.z, 4.8);
  send(win, "blur"); controller.update(.1); near(camera.position.z, 4.8);
  controller.setMoveInput(0, 1); controller.update(.1); near(camera.position.x, 5.2);
  controller.lookBy(100, 100000); assert.ok(camera.rotation.x > -Math.PI / 2); near(camera.rotation.y, -.2);
  controller.requestPointerLock(); assert.equal(doc.pointerLockElement, canvas);
  send(doc, "keydown", { code: "Escape" }); assert.equal(doc.pointerLockElement, null);
  const snapshot = { ...camera.position }; controller.dispose(); send(doc, "keydown", { code: "KeyW" }); controller.update(.1);
  near(camera.position.x, snapshot.x); near(camera.position.z, snapshot.z); assert.equal(controller.enter().ok, false);
});

test("product/text controls block navigation keystrokes, and focusing them clears held movement", () => {
  for (const target of [{ isContentEditable: true }, { closest: () => ({ tagName: "INPUT" }) }, { closest: () => ({ tagName: "BUTTON" }) }]) assert.equal(isNavigationInputTarget(target), true);
  assert.equal(isNavigationInputTarget({ closest: () => null }), false);
  const { controller, doc, camera, send } = fixtureController();
  controller.enter([5, 5]); doc.closest = () => ({ tagName: "INPUT" });
  assert.equal(send(doc, "keydown", { code: "KeyW" }).defaultPrevented, false); controller.update(.1); near(camera.position.z, 5);
  doc.closest = () => null; send(doc, "keydown", { code: "KeyW" });
  doc.closest = () => ({ tagName: "BUTTON" }); send(doc, "focusin"); controller.update(.1); near(camera.position.z, 5);
  controller.dispose();
});

for (const [code, axis, amount] of [["KeyW", "z", -.2], ["KeyS", "z", .2], ["KeyA", "x", -.2], ["KeyD", "x", .2], ["ArrowUp", "z", -.2], ["ArrowDown", "z", .2], ["ArrowLeft", "x", -.2], ["ArrowRight", "x", .2]]) {
  test(`${code} moves the correct axis and keyup stops immediately`, () => {
    const { controller, doc, camera, send } = fixtureController();
    controller.enter([5, 5]); send(doc, "keydown", { code }); controller.update(.1); near(camera.position[axis], 5 + amount);
    send(doc, "keyup", { code }); controller.update(.1); near(camera.position[axis], 5 + amount); controller.dispose();
  });
}

test("opposing keys cancel, aliases do not double speed, Shift is released independently", () => {
  const { controller, doc, camera, send } = fixtureController();
  controller.enter([5, 5]);
  send(doc, "keydown", { code: "KeyW" }); send(doc, "keydown", { code: "ArrowUp" }); controller.update(.1); near(camera.position.z, 4.8);
  send(doc, "keydown", { code: "KeyS" }); controller.update(.1); near(camera.position.z, 4.8);
  send(doc, "keyup", { code: "KeyS" }); send(doc, "keydown", { code: "ShiftRight" }); controller.update(.1); near(camera.position.z, 4.48);
  send(doc, "keyup", { code: "ShiftRight" }); controller.update(.1); near(camera.position.z, 4.28); controller.dispose();
});

test("browser shortcuts and already-handled keys never start movement", () => {
  const { controller, doc, camera, send } = fixtureController(); controller.enter([5, 5]);
  for (const modifier of ["altKey", "metaKey", "ctrlKey"]) { send(doc, "keydown", { code: "KeyW", [modifier]: true }); controller.update(.1); near(camera.position.z, 5); }
  const event = new Event("keydown", { cancelable: true }); Object.assign(event, { code: "KeyW" }); event.preventDefault(); doc.dispatchEvent(event); controller.update(.1); near(camera.position.z, 5);
  controller.dispose();
});

test("keyboard ownership follows the focused canvas on a shared document", () => {
  const first = fixtureController(), second = fixtureController(first.doc);
  first.controller.enter([5, 5]); second.controller.enter([5, 5]);
  first.send(first.doc, "keydown", { code: "KeyW" }); first.controller.update(.1); second.controller.update(.1);
  near(first.camera.position.z, 5); near(second.camera.position.z, 4.8);
  first.controller.dispose();
  second.send(second.doc, "keyup", { code: "KeyW" }); second.send(second.doc, "keydown", { code: "KeyD" }); second.controller.update(.1); near(second.camera.position.x, 5.2);
  second.controller.dispose();
  for (const listeners of second.doc.listeners.values()) assert.equal(listeners.size, 0, "all document handlers removed");
  for (const listeners of second.win.listeners.values()) assert.equal(listeners.size, 0, "all window handlers removed");
  for (const listeners of first.canvas.listeners.values()) assert.equal(listeners.size, 0, "old canvas handlers removed");
});

test("focus loss, hidden document and exit clear keyboard and mobile movement", () => {
  for (const cause of ["focusin", "visibilitychange", "blur", "exit"]) {
    const { controller, doc, win, camera, send } = fixtureController(); controller.enter([5, 5]);
    send(doc, "keydown", { code: "KeyW" }); controller.setMoveInput(0, 1);
    if (cause === "exit") controller.exit();
    else if (cause === "blur") send(win, "blur");
    else { if (cause === "visibilitychange") doc.hidden = true; send(doc, cause); }
    controller.update(.1); near(camera.position.x, 5); near(camera.position.z, 5); controller.dispose();
  }
});

test("disposing one canvas cannot release another canvas's mouse lock", () => {
  const first = fixtureController(), second = fixtureController(first.doc);
  first.controller.enter([5, 5]); second.controller.enter([5, 5]); second.controller.requestPointerLock();
  first.controller.dispose(); assert.equal(second.doc.pointerLockElement, second.canvas);
  second.send(second.doc, "keydown", { code: "KeyW" }); second.controller.update(.1); near(second.camera.position.z, 4.8);
  second.controller.dispose(); assert.equal(second.doc.pointerLockElement, null);
});

test("a delayed pointer-lock rejection after disposal does not call back into an unmounted UI", async () => {
  const errors = [], state = fixtureController(undefined, { onError: (message) => errors.push(message) });
  let reject;
  state.canvas.requestPointerLock = () => new Promise((_resolve, rejectRequest) => { reject = rejectRequest; });
  state.controller.enter([5, 5]); state.controller.requestPointerLock(); state.controller.dispose(); reject(new Error("Denied"));
  await Promise.resolve(); assert.deepEqual(errors, []);
});

test("mouse-lock denial retains drag look and touch look ignores other pointers and cancellation", async () => {
  const errors = [], { controller, canvas, camera, send } = fixtureController(undefined, { onError: (message) => errors.push(message) });
  controller.enter([5, 5]); canvas.requestPointerLock = () => Promise.reject(new Error("No permission"));
  send(canvas, "pointerdown", { button: 0, pointerType: "mouse", pointerId: 1, clientX: 100, clientY: 100 }); await Promise.resolve();
  assert.equal(errors.length, 1); send(canvas, "pointermove", { pointerId: 1, clientX: 150, clientY: 120 }); near(camera.rotation.y, -.1); near(camera.rotation.x, -.04);
  send(canvas, "pointerup", { pointerId: 1 }); send(canvas, "pointermove", { pointerId: 1, clientX: 200, clientY: 150 }); near(camera.rotation.y, -.1);
  send(canvas, "pointerdown", { button: 0, pointerType: "touch", pointerId: 2, clientX: 10, clientY: 10 });
  send(canvas, "pointerdown", { button: 0, pointerType: "touch", pointerId: 3, clientX: 100, clientY: 100, isPrimary: false });
  send(canvas, "pointermove", { pointerId: 3, clientX: 100, clientY: 100 }); near(camera.rotation.y, -.1);
  send(canvas, "pointermove", { pointerId: 2, clientX: 20, clientY: 30 }); near(camera.rotation.y, -.12);
  send(canvas, "pointercancel", { pointerId: 2 }); send(canvas, "pointermove", { pointerId: 2, clientX: 60, clientY: 30 }); near(camera.rotation.y, -.12);
  controller.dispose();
});

test("enter flattens the actual quaternion heading left by orbit controls", () => {
  const { controller, camera } = fixtureController();
  camera.quaternion = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
  camera.rotation.y = 0;
  controller.enter([5, 5]); near(camera.rotation.y, Math.PI / 2); controller.setMoveInput(1, 0); controller.update(.1);
  near(camera.position.x, 4.8); near(camera.position.z, 5); controller.dispose();
});

test("diagonal scanned walls let a single movement key slide along the wall without crossing", () => {
  const diagonal = { ...wall, start: [1, 1], end: [9, 9], thickness: .01 };
  const world = createNavigationWorld(plan({ walls: [diagonal] }));
  let p = [4, 1.6, 4.4];
  for (let i = 0; i < 60; i++) {
    p = moveNavigation(world, p, { forward: 1, right: 0, yaw: 0, sprint: true }, 1 / 60);
    assert.ok(canNavigateAt(world, [p[0], p[2]])); assert.ok(p[2] > p[0]);
  }
  assert.ok(p[0] < 3.5 && p[2] < 3.9, "movement continues along the diagonal rather than sticking");
});

test("rotated furniture lets a single movement key slide along its edge", () => {
  const world = createNavigationWorld(plan({ items: [{ ...chair, dimensions: [6, 1, 1] }] }));
  let p = [4, 1.6, 4.9];
  assert.ok(canNavigateAt(world, [p[0], p[2]]));
  for (let i = 0; i < 40; i++) { p = moveNavigation(world, p, { forward: 0, right: 1, yaw: 0 }, 1 / 60); assert.ok(canNavigateAt(world, [p[0], p[2]])); }
  assert.ok(p[2] < 4.7 && p[0] > 4.5, "motion deflects along the rotated furniture edge");
});

test("sprinting with extreme input cannot cross millimeter-thin furniture or walls", () => {
  for (const raw of [plan({ walls: [{ ...wall, thickness: .001 }] }), plan({ items: [{ ...chair, position: [5, 0, 5], rotationY: 0, dimensions: [10, 1, .001] }] })]) {
    const world = createNavigationWorld(raw); let p = [5, 1.6, 4.7];
    for (let i = 0; i < 100; i++) { p = moveNavigation(world, p, { forward: -1e10, right: 0, yaw: 0, sprint: true }, 100); assert.ok(canNavigateAt(world, [p[0], p[2]])); }
    assert.ok(p[2] <= 5 - world.radius - .0005 + 1e-7);
  }
});

test("multiple overlapping door intervals merge while untyped openings stay solid", () => {
  const base = { wallId: wall.id, kind: "door", height: 2.1, sillHeight: 0 };
  const merged = createNavigationWorld(plan({ walls: [wall], openings: [{ ...base, offset: 4, width: 1.1 }, { ...base, offset: 4.8, width: 1.2 }] }));
  assert.ok(canNavigateAt(merged, [5.1, 5]));
  const generic = createNavigationWorld(plan({ walls: [wall], openings: [{ ...base, kind: "opening", offset: 4, width: 2 }] }));
  assert.equal(canNavigateAt(generic, [5, 5]), false, "only explicit door contract grants passage");
});

test("narrow doorway, disconnected room gap and invalid body settings cannot yield a walkable shortcut", () => {
  const narrow = createNavigationWorld(plan({ walls: [wall], openings: [{ wallId: wall.id, kind: "door", offset: 4.9, width: .2, height: 2.2, sillHeight: 0 }] }));
  assert.equal(canNavigateAt(narrow, [5, 5]), false);
  const raw = plan(); raw.geometry.rooms = [{ height: 3, floorPolygon: [[0, 0], [3, 0], [3, 3], [0, 3]] }, { height: 3, floorPolygon: [[3.3, 0], [6, 0], [6, 3], [3.3, 3]] }];
  assert.equal(canNavigateAt(createNavigationWorld(raw), [3.15, 1.5]), false);
  for (const options of [{ radius: 0 }, { radius: NaN }, { eyeHeight: Infinity }, { eyeHeight: 0 }]) assert.throws(() => createNavigationWorld(raw, options), /dimensions/);
});

test("committed reconstruction fixture supports a finite standing spawn and a sustained collision-safe walk", () => {
  const request = JSON.parse(readFileSync(new URL("../../reconstruction/fixtures/living-room.request.json", import.meta.url), "utf8"));
  const world = createNavigationWorld({ ...request, products: [], items: request.items ?? [] });
  const spawn = findNavigationSpawn(world); assert.equal(spawn.ok, true);
  let p = spawn.position;
  for (let i = 0; i < 720; i++) {
    p = moveNavigation(world, p, { forward: 1, right: i % 120 < 60 ? .5 : -.5, yaw: i * .012 }, 1 / 60);
    assert.ok(canNavigateAt(world, [p[0], p[2]])); assert.ok(p.every(Number.isFinite)); near(p[1], 1.6);
  }
});
