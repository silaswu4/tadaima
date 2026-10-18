import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { parseRoomImport } from "../room/import-room.ts";
import { bindTexturedRoom } from "../room/textured-model.ts";
import { prepareWalkSource } from "../room/walk-source.ts";
import { makeExplodeController } from "../room/explode.ts";
function fixture() {
  const request = JSON.parse(readFileSync(new URL("../../reconstruction/fixtures/living-room.request.json", import.meta.url), "utf8"));
  request.items = [{ id: "chair", roomId: "living-room", label: "Synthetic chair", origin: "existing_owned", productId: null, assetUrl: null,
    position: [1, .2, 2], rotationY: .63, dimensions: [.8, 1.2, .9], locked: true, evidenceIds: ["synthetic-reference"] }];
  const plan = parseRoomImport(JSON.stringify(request)), scene = new THREE.Group(), entities = new Map();
  scene.userData = { projectId: plan.projectId, inputRevision: String(plan.revision) };
  function identify(node, id, role) { node.userData = { entityId: id, role }; scene.add(node); entities.set(id, node); return node; }
  const floor = identify(new THREE.Mesh(new THREE.BoxGeometry(4.2, .08, 3.5), new THREE.MeshStandardMaterial()), "living-room", "room_floor");
  floor.position.set(2.1, -.04, 1.75); floor.userData.appearanceStatus = "photo_projected";
  for (const wall of plan.geometry.walls) {
    const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
    const geometry = new THREE.BoxGeometry(length, wall.height, wall.thickness); geometry.translate(length / 2, wall.height / 2, 0);
    const node = identify(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()), wall.id, "wall");
    node.position.set(wall.start[0], 0, wall.start[1]); node.rotation.y = -Math.atan2(wall.end[1] - wall.start[1], wall.end[0] - wall.start[0]);
  }
  for (const opening of plan.geometry.openings) {
    const node = identify(new THREE.Object3D(), opening.id, "opening"), wall = plan.geometry.walls.find(w => w.id === opening.wallId), parent = entities.get(wall.id);
    parent.add(node); node.position.set(opening.offset + opening.width / 2, opening.sillHeight + opening.height / 2, 0);
    node.scale.set(opening.width / 2, opening.height / 2, wall.thickness / 2);
  }
  const item = plan.items[0], geometry = new THREE.BoxGeometry(...item.dimensions); geometry.translate(0, item.dimensions[1] / 2, 0);
  const chair = identify(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()), item.id, "existing_furniture");
  chair.position.fromArray(item.position); chair.rotation.y = item.rotationY;
  chair.userData.appearanceStatus = "photo_projected"; chair.userData.photoTextureCoverage = .4;
  return { plan, scene, entities };
}

test("captured templates keep exact local envelopes without applying source yaw/translation twice", () => {
  const { plan, scene } = fixture();
  const item = plan.items[0];
  const bound = prepareWalkSource(bindTexturedRoom(scene, plan));
  const template = bound.templates.get(item.id);
  assert.deepEqual(template.position.toArray(), [0, 0, 0]);
  assert.deepEqual(template.scale.toArray(), [1, 1, 1]);
  assert(template.quaternion.angleTo(new THREE.Quaternion()) < 1e-9);
  const moved = new THREE.Group();
  moved.position.set(2, .3, 1); moved.rotation.y = -.4;
  moved.add(template.clone(true)); moved.updateMatrixWorld(true);
  const local = new THREE.Box3().setFromObject(template, true);
  assert(local.min.distanceTo(new THREE.Vector3(-.4, 0, -.45)) < 1e-6);
  assert(local.max.distanceTo(new THREE.Vector3(.4, 1.2, .45)) < 1e-6);
  const expected = new THREE.Mesh(new THREE.BoxGeometry(.8, 1.2, .9).translate(0, .6, 0));
  expected.position.copy(moved.position); expected.rotation.copy(moved.rotation);
  const world = new THREE.Box3().setFromObject(moved, true), comparison = new THREE.Box3().setFromObject(expected, true);
  assert(world.min.distanceTo(comparison.min) < 1e-6); assert(world.max.distanceTo(comparison.max) < 1e-6);
});

test("stored/taken-out templates clone independently and explode restores the current edited pose", () => {
  const { plan, scene } = fixture();
  const source = prepareWalkSource(bindTexturedRoom(scene, plan));
  const template = source.templates.get("chair");
  const first = template.clone(true), second = template.clone(true);
  first.position.set(2, .1, 3); first.rotation.y = -.9;
  second.position.set(4, .2, 1); second.rotation.y = .7;
  const controller = makeExplodeController([{ id: "chair", object: second }], new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 3, 5)), { reducedMotion: true });
  controller.setExploded(true, 0); controller.update(1); controller.dispose();
  assert.deepEqual(second.position.toArray(), [4, .2, 1]); assert.equal(second.rotation.y, .7);
  assert.deepEqual(first.position.toArray(), [2, .1, 3]); assert.deepEqual(template.position.toArray(), [0, 0, 0]);
});

test("edited plan cannot substitute for the immutable reconstruction binding", () => {
  const { plan, scene } = fixture();
  const changed = structuredClone(plan); changed.items[0].position[0] += .2;
  assert.throws(() => prepareWalkSource(bindTexturedRoom(scene, changed)), /placement/);
});
