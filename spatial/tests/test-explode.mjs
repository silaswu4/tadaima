import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { makeExplodeController, makeInventoryLayout } from "../room/explode.ts";

const ROOM = new THREE.Box3(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 2.7, 3));

function item(id, size, centerOffset = [0, 0, 0]) {
  return { id, size, centerOffset };
}

function boxAt(target, specification) {
  return new THREE.Box3().setFromCenterAndSize(
    target.clone().add(new THREE.Vector3(...specification.centerOffset)),
    new THREE.Vector3(...specification.size),
  );
}

function near(actual, expected, epsilon = 1e-10) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} should equal ${expected}`);
}

function mesh(size = [1, 1, 1], offset = [0, 0.5, 0]) {
  const geometry = new THREE.BoxGeometry(...size);
  geometry.translate(...offset);
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

function pose(object) {
  return { position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray() };
}

function setup() {
  const a = mesh([2.4, 0.8, 1.1], [0.3, 0.4, -0.1]);
  a.position.set(-1.5, 0.06, -1.3);
  a.rotation.set(0, 0.63, 0);
  a.scale.set(1.1, 0.95, 0.9);
  const b = mesh([0.45, 2.1, 0.35], [-0.1, 1.05, 0.2]);
  b.position.set(1.1, 0.02, 0.7);
  b.rotation.set(0, -0.8, 0);
  return [{ id: "sofa", object: a }, { id: "lamp", object: b }];
}

test("inventory preserves dimensions, odd pivots, floor placement, and a clear room gap", () => {
  const items = [
    item("wide-sofa", [7.3, 0.8, 1.2], [0.5, 0.4, -0.1]),
    item("tiny-tall", [0.02, 30, 0.03], [-0.8, 14.7, 0.4]),
    item("deep-table", [0.8, 0.7, 9], [0, 0.35, 0]),
    item("dresser", [2.3, 1.1, 0.6], [1.1, -0.4, 0.6]),
    item("vase", [0.2, 0.4, 0.2], [0, 0.2, 0]),
    item("rug", [5, 0.01, 3], [0, 0.005, 0]),
  ];
  const layout = makeInventoryLayout(items, ROOM, { gap: 0.65 });
  const boxes = [];
  for (const specification of items) {
    const box = boxAt(layout.positions.get(specification.id), specification);
    near(box.min.y, 0);
    assert.ok(box.min.x >= ROOM.max.x + 0.65 - 1e-10);
    assert.ok(layout.bounds.containsBox(box));
    assert.deepEqual(box.getSize(new THREE.Vector3()).toArray().map((x) => +x.toFixed(8)), specification.size);
    for (const other of boxes) assert.equal(box.intersectsBox(other), false);
    boxes.push(box);
  }
  near(layout.bounds.max.y, 30);
});

test("layout is deterministic in caller order and does not mutate frozen inputs or room bounds", () => {
  const items = Object.freeze([
    Object.freeze(item("one", Object.freeze([2, 1, 1]), Object.freeze([0, 0.5, 0]))),
    Object.freeze(item("two", Object.freeze([1, 2, 2]), Object.freeze([0.1, 1, 0]))),
  ]);
  const originalRoom = ROOM.clone();
  const first = makeInventoryLayout(items, ROOM);
  const second = makeInventoryLayout(items, ROOM);
  assert.deepEqual([...first.positions].map(([id, vector]) => [id, vector.toArray()]),
    [...second.positions].map(([id, vector]) => [id, vector.toArray()]));
  assert.ok(ROOM.equals(originalRoom));
  assert.deepEqual([...first.positions.keys()], ["one", "two"]);
});

test("empty inventory returns an empty union and a usable empty controller", () => {
  const layout = makeInventoryLayout([], ROOM);
  assert.equal(layout.positions.size, 0);
  assert.equal(layout.bounds.isEmpty(), true);
  const controller = makeExplodeController([], ROOM);
  controller.setExploded(true, 0);
  assert.equal(controller.update(1), false);
  assert.equal(controller.isExploded, true);
  assert.ok(controller.getDisplayBounds().equals(ROOM));
});

test("invalid dimensions, offsets, IDs, gaps, and room bounds fail explicitly", () => {
  for (const size of [[0, 1, 1], [-1, 1, 1], [1, NaN, 1], [1, Infinity, 1], [true, 1, 1], [1, 1]]) {
    assert.throws(() => makeInventoryLayout([item("bad", size)], ROOM));
  }
  assert.throws(() => makeInventoryLayout([item("bad", [1, 1, 1], [0, NaN, 0])], ROOM));
  assert.throws(() => makeInventoryLayout([item("", [1, 1, 1])], ROOM));
  assert.throws(() => makeInventoryLayout([item("same", [1, 1, 1]), item("same", [2, 1, 1])], ROOM), /Duplicate/);
  assert.throws(() => makeInventoryLayout([], new THREE.Box3()), /nonempty/);
  assert.throws(() => makeInventoryLayout([], new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(0, 1, 1))), /footprint/);
  assert.throws(() => makeInventoryLayout([], ROOM, { gap: 0 }), /positive/);
  assert.throws(() => makeInventoryLayout([], ROOM, { gap: Infinity }), /finite/);
  assert.throws(() => makeInventoryLayout([], ROOM, { floorY: NaN }), /finite/);
});

test("animated explode uses rotated and scaled mesh bounds without resizing geometry", () => {
  const entries = setup();
  const originalPoses = entries.map(({ object }) => pose(object));
  const geometry = entries.map(({ object }) => Array.from(object.geometry.attributes.position.array));
  const controller = makeExplodeController(entries, ROOM, { durationMs: 750 });
  controller.setExploded(true, 100);
  assert.equal(controller.isExploded, true);
  assert.equal(controller.transitioning, true);
  assert.equal(controller.update(475), true);
  for (let index = 0; index < entries.length; index++) {
    assert.notDeepEqual(entries[index].object.position.toArray(), originalPoses[index].position);
    assert.deepEqual(entries[index].object.quaternion.toArray(), originalPoses[index].quaternion);
    assert.deepEqual(entries[index].object.scale.toArray(), originalPoses[index].scale);
  }
  assert.equal(controller.update(850), false);
  assert.equal(controller.transitioning, false);
  const boxes = entries.map(({ object }) => new THREE.Box3().setFromObject(object, true));
  for (const box of boxes) {
    assert.ok(box.min.x >= ROOM.max.x + 0.8 - 1e-8);
    near(box.min.y, ROOM.min.y);
  }
  assert.equal(boxes[0].intersectsBox(boxes[1]), false);
  for (let index = 0; index < entries.length; index++) {
    assert.deepEqual(Array.from(entries[index].object.geometry.attributes.position.array), geometry[index]);
  }
  assert.ok(controller.getDisplayBounds().containsBox(controller.inventoryBounds));
});

test("restore copies original positions, rotations, and scales exactly after repeated toggles", () => {
  const entries = setup();
  const originals = entries.map(({ object }) => pose(object));
  const controller = makeExplodeController(entries, ROOM, { durationMs: 30 });
  let now = 0;
  for (let cycle = 0; cycle < 12; cycle++) {
    controller.setExploded(true, now);
    controller.update(now + 30);
    controller.setExploded(false, now + 31);
    controller.update(now + 61);
    assert.equal(controller.transitioning, false);
    entries.forEach(({ object }, index) => assert.deepEqual(pose(object), originals[index]));
    now += 62;
  }
});

test("mid-transition reversal samples current time and never jumps at retarget", () => {
  const entries = setup();
  const originals = entries.map(({ object }) => pose(object));
  const controller = makeExplodeController(entries, ROOM, { durationMs: 1000 });
  controller.setExploded(true, 0);
  controller.update(400);
  const before = entries.map(({ object }) => object.position.toArray());
  controller.setExploded(false, 400);
  entries.forEach(({ object }, index) => assert.deepEqual(object.position.toArray(), before[index]));
  controller.update(600);
  const halfwayBack = entries.map(({ object }) => object.position.toArray());
  controller.setExploded(true, 600);
  entries.forEach(({ object }, index) => assert.deepEqual(object.position.toArray(), halfwayBack[index]));
  controller.update(1600);
  controller.setExploded(false, 1700);
  controller.update(2700);
  entries.forEach(({ object }, index) => assert.deepEqual(pose(object), originals[index]));
});

test("a redundant toggle does not restart or prolong an existing transition", () => {
  const controller = makeExplodeController(setup(), ROOM, { durationMs: 100 });
  controller.setExploded(true, 0);
  controller.setExploded(true, 50);
  assert.equal(controller.update(100), false);
});

test("reduced motion and zero duration place and restore immediately", () => {
  for (const options of [{ reducedMotion: true }, { durationMs: 0 }]) {
    const entries = setup();
    const originals = entries.map(({ object }) => pose(object));
    const controller = makeExplodeController(entries, ROOM, options);
    controller.setExploded(true, 0);
    assert.equal(controller.transitioning, false);
    assert.equal(controller.update(1), false);
    assert.ok(new THREE.Box3().setFromObject(entries[0].object, true).min.x > ROOM.max.x);
    controller.setExploded(false, 2);
    entries.forEach(({ object }, index) => assert.deepEqual(pose(object), originals[index]));
  }
});

test("world target positions work beneath a translated, rotated, scaled parent", () => {
  const parent = new THREE.Group();
  parent.position.set(-2, 0.5, 1);
  parent.rotation.set(0, 0.41, 0);
  parent.scale.set(1.3, 0.8, 1.1);
  const entries = setup();
  entries.forEach(({ object }) => parent.add(object));
  const originals = entries.map(({ object }) => pose(object));
  const controller = makeExplodeController(entries, ROOM, { reducedMotion: true, floorY: 0.2 });
  controller.setExploded(true, 0);
  const boxes = entries.map(({ object }) => new THREE.Box3().setFromObject(object, true));
  for (const box of boxes) {
    near(box.min.y, 0.2);
    assert.ok(box.min.x >= ROOM.max.x + 0.8 - 1e-8);
  }
  assert.equal(boxes[0].intersectsBox(boxes[1]), false);
  controller.setExploded(false, 1);
  entries.forEach(({ object }, index) => assert.deepEqual(pose(object), originals[index]));
});

test("public bounds are defensive copies and disposal restores without disposing caller assets", () => {
  const entries = setup();
  const originals = entries.map(({ object }) => pose(object));
  let geometryDisposals = 0;
  entries[0].object.geometry.addEventListener("dispose", () => geometryDisposals++);
  const controller = makeExplodeController(entries, ROOM);
  controller.roomBounds.min.set(-100, -100, -100);
  assert.ok(controller.roomBounds.equals(ROOM));
  const actualInventory = controller.inventoryBounds.clone();
  controller.inventoryBounds.makeEmpty();
  assert.ok(controller.inventoryBounds.equals(actualInventory));
  controller.setExploded(true, 0);
  controller.update(350);
  controller.dispose();
  controller.dispose();
  entries.forEach(({ object }, index) => assert.deepEqual(pose(object), originals[index]));
  assert.equal(controller.isExploded, false);
  assert.equal(controller.transitioning, false);
  assert.equal(controller.update(1000), false);
  assert.equal(geometryDisposals, 0);
  assert.throws(() => controller.setExploded(true, 1001), /disposed/);
});

test("clock validation rejects invalid timestamps and a stale frame cannot rewind animation", () => {
  const entries = setup();
  const controller = makeExplodeController(entries, ROOM, { durationMs: 1000 });
  for (const time of [NaN, Infinity, -1, "100"]) assert.throws(() => controller.update(time));
  controller.setExploded(true, 0);
  controller.update(500);
  const before = entries.map(({ object }) => object.position.toArray());
  controller.update(100);
  entries.forEach(({ object }, index) => assert.deepEqual(object.position.toArray(), before[index]));
});

test("invalid controllers reject duplicate objects, nested roots, unloaded geometry and invalid transforms", () => {
  const object = mesh();
  assert.throws(() => makeExplodeController([{ id: "one", object }, { id: "two", object }], ROOM), /unique/);
  assert.throws(() => makeExplodeController([{ id: "same", object }, { id: "same", object: mesh() }], ROOM), /Duplicate/);
  const child = mesh();
  object.add(child);
  assert.throws(() => makeExplodeController([{ id: "parent", object }, { id: "child", object: child }], ROOM), /ancestors/);
  assert.throws(() => makeExplodeController([{ id: "empty", object: new THREE.Group() }], ROOM), /loaded geometry/);
  const invalid = mesh();
  invalid.scale.set(0, 1, 1);
  assert.throws(() => makeExplodeController([{ id: "collapsed", object: invalid }], ROOM), /positive/);
  invalid.position.x = NaN;
  assert.throws(() => makeExplodeController([{ id: "nan", object: invalid }], ROOM), /finite/);
  assert.throws(() => makeExplodeController([], ROOM, { durationMs: -1 }), /negative/);
});
