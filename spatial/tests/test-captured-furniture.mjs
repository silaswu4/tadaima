import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { parseRoomImport } from "../room/import-room.ts";
import { createFurnitureProxy, placeFurnitureModel } from "../room/furniture-model.ts";
import { makeExplodeController } from "../room/explode.ts";

function request() {
  const raw = JSON.parse(readFileSync(new URL("../../reconstruction/fixtures/living-room.request.json", import.meta.url), "utf8"));
  const evidenceId = raw.evidence[0].id;
  raw.items = [{ id: "captured-chair", roomId: raw.geometry.rooms[0].id, label: "Chair", origin: "existing_owned", productId: null, assetUrl: null,
    position: [1, .25, 1.5], rotationY: .63, dimensions: [.8, 1.2, .9], locked: true, evidenceIds: [evidenceId] }];
  return raw;
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test("local import preserves existing furniture, evidence and elevated rotated placement without products", () => {
  const raw = request(), before = structuredClone(raw), plan = parseRoomImport(JSON.stringify(raw));
  assert.deepEqual(plan.items, raw.items); assert.deepEqual(plan.products, []); assert.deepEqual(raw, before);
});

test("legacy empty shells and explicitly empty furniture remain valid", () => {
  const raw = request(); delete raw.items;
  assert.deepEqual(parseRoomImport(JSON.stringify(raw)).items, []);
  raw.items = []; assert.deepEqual(parseRoomImport(JSON.stringify(raw)).items, []);
});

const invalid = {
  "missing evidence": (raw) => { delete raw.items[0].evidenceIds; },
  "empty evidence": (raw) => { raw.items[0].evidenceIds = []; },
  "unknown evidence": (raw) => { raw.items[0].evidenceIds = ["missing"]; },
  "duplicate evidence": (raw) => { raw.items[0].evidenceIds.push(raw.items[0].evidenceIds[0]); },
  "bad ID": (raw) => { raw.items[0].id = "../chair"; },
  "duplicate item ID": (raw) => { raw.items.push(structuredClone(raw.items[0])); },
  "structural ID conflict": (raw) => { raw.items[0].id = raw.geometry.walls[0].id; },
  "opening ID conflict": (raw) => { raw.items[0].id = raw.geometry.openings[0].id; },
  "unknown room": (raw) => { raw.items[0].roomId = "missing"; },
  "negative size": (raw) => { raw.items[0].dimensions[0] = -1; },
  "zero size": (raw) => { raw.items[0].dimensions[1] = 0; },
  "subminimum size": (raw) => { raw.items[0].dimensions[1] = 1e-7; },
  "huge size": (raw) => { raw.items[0].dimensions[2] = 101; },
  "null size": (raw) => { raw.items[0].dimensions = null; },
  "nonfinite size": (raw) => { raw.items[0].dimensions[1] = NaN; },
  "extra size axis": (raw) => { raw.items[0].dimensions.push(1); },
  "nonfinite position": (raw) => { raw.items[0].position[1] = Infinity; },
  "huge position": (raw) => { raw.items[0].position[2] = 10001; },
  "huge yaw": (raw) => { raw.items[0].rotationY = Math.PI * 3; },
  "nonboolean lock": (raw) => { raw.items[0].locked = "true"; },
  "product identity": (raw) => { raw.items[0].productId = "retailer-chair"; },
  "proposed purchase": (raw) => { raw.items[0].origin = "proposed_purchase"; },
  "remote model": (raw) => { raw.items[0].assetUrl = "https://example.com/chair.glb"; },
  "local model": (raw) => { raw.items[0].assetUrl = "/models/chair.glb"; },
  "script URL": (raw) => { raw.items[0].assetUrl = "javascript:alert(1)"; },
  "excessive count": (raw) => { raw.items = Array.from({ length: 257 }, (_, index) => ({ ...raw.items[0], id: `chair-${index}` })); },
};
for (const [name, mutate] of Object.entries(invalid)) test(`local furniture rejects ${name}`, () => {
  const raw = request(); mutate(raw); assert.throws(() => parseRoomImport(JSON.stringify(raw)), /Room file:/);
});

test("proxy world bounds honor local dimensions, bottom-center position and nonzero yaw", () => {
  const item = request().items[0], model = createFurnitureProxy(item.dimensions), { root, size } = placeFurnitureModel(item, model);
  size.forEach((value, index) => near(value, item.dimensions[index]));
  const box = new THREE.Box3().setFromObject(root, true), actual = box.getSize(new THREE.Vector3());
  const [w, h, d] = item.dimensions, c = Math.abs(Math.cos(item.rotationY)), s = Math.abs(Math.sin(item.rotationY));
  near(actual.x, w * c + d * s); near(actual.y, h); near(actual.z, w * s + d * c);
  near(box.min.y, item.position[1]); near(box.getCenter(new THREE.Vector3()).x, item.position[0]); near(box.getCenter(new THREE.Vector3()).z, item.position[2]);
  model.geometry.dispose(); model.material.dispose();
});

test("locked captured item still explodes as presentation and returns to exact original pose", () => {
  const raw = request(), plan = parseRoomImport(JSON.stringify(raw)), item = plan.items[0], model = createFurnitureProxy(item.dimensions);
  const { root } = placeFurnitureModel(item, model), position = root.position.toArray(), quaternion = root.quaternion.toArray();
  const controller = makeExplodeController([{ id: item.id, object: root }], new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 3, 4)), { reducedMotion: true });
  controller.setExploded(true, 0); assert.notDeepEqual(root.position.toArray(), position);
  controller.setExploded(false, 100); assert.deepEqual(root.position.toArray(), position); assert.deepEqual(root.quaternion.toArray(), quaternion);
  assert.deepEqual(plan.items, raw.items); controller.dispose(); model.geometry.dispose(); model.material.dispose();
});
