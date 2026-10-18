import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { parseRoomImport } from "../room/import-room.ts";
import { bindTexturedRoom, validateLocalTexturedGlb, MAX_TEXTURED_MODEL_BYTES } from "../room/textured-model.ts";
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

function glb(mutate = () => {}, binary = Buffer.alloc(4)) {
  // Minimal synthetic envelope for preflight; actual geometry is checked by the binder.
  const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ count: 3 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }], buffers: [{ byteLength: binary.length }] };
  mutate(json);
  const text = Buffer.from(JSON.stringify(json)), padded = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 32)]);
  const bytes = Buffer.alloc(20 + padded.length + 8 + binary.length);
  bytes.writeUInt32LE(0x46546C67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(padded.length, 12); bytes.writeUInt32LE(0x4E4F534A, 16); padded.copy(bytes, 20);
  bytes.writeUInt32LE(binary.length, 20 + padded.length); bytes.writeUInt32LE(0x004E4942, 24 + padded.length); binary.copy(bytes, 28 + padded.length);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test("local GLB preflight accepts bounded embedded static resources", () => validateLocalTexturedGlb(glb()));
for (const [name, change] of Object.entries({
  "external buffer": j => { j.buffers[0].uri = "https://example.com/model.bin"; },
  "embedded data URL": j => { j.images = [{ uri: "data:image/png;base64,AA" }]; },
  "extension redirect": j => { j.extensions = { EXT_custom: { url: "https://example.com" } }; },
  "unknown declared extension": j => { j.extensionsUsed = ["EXT_texture_webp"]; },
  "out of bounds buffer": j => { j.bufferViews[0].byteLength = 8; },
  "animated model": j => { j.animations = [{}]; },
  "node cycle": j => { j.nodes[0].children = [0]; },
  "repeated root": j => { j.scenes[0].nodes = [0, 0]; },
  "unreachable geometry": j => { j.nodes.push({ mesh: 0 }); },
  "excessive accessors": j => { j.accessors[0].count = 2_000_001; },
  "morph geometry": j => { j.meshes[0].primitives[0].targets = [{}]; },
  "nontriangle geometry": j => { j.meshes[0].primitives[0].mode = 1; },
})) test(`preflight rejects ${name} before loading`, () => assert.throws(() => validateLocalTexturedGlb(glb(change)), /Photo model:/));

test("preflight rejects truncated, oversized and incorrectly sized GLBs", () => {
  assert.throws(() => validateLocalTexturedGlb(new ArrayBuffer(20)), /Photo model:/);
  assert.throws(() => validateLocalTexturedGlb(new ArrayBuffer(MAX_TEXTURED_MODEL_BYTES + 1)), /Photo model:/);
  const bytes = glb(); new DataView(bytes).setUint32(8, 100, true);
  assert.throws(() => validateLocalTexturedGlb(bytes), /Photo model:/);
});

test("matching textured geometry preserves independent rotated/elevated item roots and exact explode return", () => {
  const { plan, scene } = fixture(), before = structuredClone(plan), bound = bindTexturedRoom(scene, plan);
  assert.equal(bound.shell.children.length, 5); assert.equal(bound.projectedEntities, 2);
  const root = bound.furniture.get("chair"), item = plan.items[0];
  assert.equal(root.userData.workspaceItemId, item.id); assert.equal(root.userData.photoTextureCoverage, .4);
  assert.deepEqual(root.position.toArray(), item.position); assert.equal(root.rotation.y, item.rotationY);
  const position = root.position.toArray(), quaternion = root.quaternion.toArray(), originalBounds = new THREE.Box3().setFromObject(root, true);
  const controller = makeExplodeController([{ id: item.id, object: root }], new THREE.Box3(new THREE.Vector3(0, -.08, 0), new THREE.Vector3(4.2, 2.7, 3.5)), { reducedMotion: true });
  controller.setExploded(true, 0); assert.notDeepEqual(root.position.toArray(), position);
  controller.setExploded(false, 1); assert.deepEqual(root.position.toArray(), position); assert.deepEqual(root.quaternion.toArray(), quaternion);
  assert.ok(new THREE.Box3().setFromObject(root, true).equals(originalBounds)); assert.deepEqual(plan, before); controller.dispose();
});

for (const [name, change] of Object.entries({
  "missing project identity": ({ scene }) => { delete scene.userData.projectId; },
  "different project": ({ scene }) => { scene.userData.projectId = "another-project"; },
  "different revision": ({ scene }) => { scene.userData.inputRevision = "999"; },
  "numeric rather than exported text revision": ({ scene, plan }) => { scene.userData.inputRevision = plan.revision; },
  "missing entity": ({ entities }) => entities.get("chair").removeFromParent(),
  "wrong entity role": ({ entities }) => { entities.get("chair").userData.role = "wall"; },
  "extra entity": ({ scene }) => { const node = new THREE.Group(); node.userData = { entityId: "alien", role: "wall" }; scene.add(node); },
  "unidentified mesh": ({ scene }) => scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())),
  "different furniture placement": ({ entities }) => { entities.get("chair").position.x += .05; },
  "different furniture yaw": ({ entities }) => { entities.get("chair").rotation.y += .1; },
  "different furniture size": ({ entities }) => { entities.get("chair").geometry.scale(1.1, 1, 1); },
  "missing solid wall mesh": ({ entities }) => { const wall = entities.get("right"); wall.geometry = new THREE.BufferGeometry(); },
  "different wall placement": ({ entities }) => { entities.get("back").position.z += .1; },
  "different floor extents": ({ entities }) => { entities.get("living-room").geometry.scale(1.1, 1, 1); },
  "nonfinite geometry": ({ entities }) => { entities.get("chair").geometry.attributes.position.setX(0, NaN); },
  "no photo projection": ({ entities }) => { for (const node of entities.values()) delete node.userData.appearanceStatus; },
})) test(`binder rejects ${name} without changing the source scene`, () => {
  const f = fixture(); change(f); const children = [...f.scene.children];
  assert.throws(() => bindTexturedRoom(f.scene, f.plan), /Photo model:/);
  assert.deepEqual(f.scene.children, children);
});

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(0x49484452, 12); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;
}

test("image preflight bounds dimensions and total decoded pixels before image decode", () => {
  validateLocalTexturedGlb(glb(j => { j.images = [{ bufferView: 0, mimeType: "image/png" }]; }, pngHeader(512, 512)));
  assert.throws(() => validateLocalTexturedGlb(glb(j => { j.images = [{ bufferView: 0, mimeType: "image/png" }]; }, pngHeader(8192, 1))), /texture memory limit/);
  assert.throws(() => validateLocalTexturedGlb(glb(j => { j.images = Array.from({ length: 17 }, () => ({ bufferView: 0, mimeType: "image/png" })); }, pngHeader(2048, 2048))), /texture memory limit/);
  assert.throws(() => validateLocalTexturedGlb(glb(j => { j.images = [{ bufferView: 0, mimeType: "image/webp" }]; }, pngHeader(512, 512))), /PNG\/JPEG/);
});

function structuredFixture() {
  const value = fixture();
  const { scene, entities, plan } = value;
  const binding = { jobId: "scan-structured", inputSha256: "c".repeat(64) };
  scene.userData = { ...scene.userData, captureRepresentation: "photo_informed_parametric", jobId: binding.jobId, sourceRequestSha256: binding.inputSha256 };
  for (const node of entities.values()) delete node.userData.appearanceStatus;
  const old = entities.get("chair"), root = new THREE.Group(), [width, height, depth] = plan.items[0].dimensions;
  root.position.copy(old.position); root.rotation.copy(old.rotation);
  root.userData = { entityId: "chair", role: "existing_furniture", representation: "photo_informed_parametric", appearanceStatus: "photo_inferred", proxyGeometry: "photo_informed_parts", visualLabel: "Cream upholstered dining chair" };
  old.removeFromParent(); scene.add(root); entities.set("chair", root);
  function part(geometry, position, color) { const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color })); mesh.position.set(...position); root.add(mesh); }
  part(new THREE.BoxGeometry(width, .15, depth), [0, .62, 0], "#d6c7aa");
  part(new THREE.BoxGeometry(width, height - .7, .12), [0, (height + .7) / 2, -depth / 2 + .06], "#d6c7aa");
  for (const x of [-width / 2 + .045, width / 2 - .045]) for (const z of [-depth / 2 + .045, depth / 2 - .045]) {
    part(new THREE.CylinderGeometry(.045, .045, .62, 8), [x, .31, z], "#644c39");
  }
  return { ...value, binding, chair: root };
}

test("photo-informed multi-part furniture loads without projected photos, preserves measured envelope and exact explode return", () => {
  const { scene, plan, binding, chair } = structuredFixture(), source = structuredClone(plan);
  const bound = bindTexturedRoom(scene, plan, binding), root = bound.furniture.get("chair");
  assert.equal(bound.projectedEntities, 0); assert.equal(bound.representation, "photo_informed_parametric");
  assert.equal(root.userData.representation, "photo_informed_parametric");
  assert.equal(root.userData.visualLabel, "Cream upholstered dining chair");
  assert.equal(chair.children.length, 6);
  // Detailed geometry need not contain the eight corners of its sensor envelope.
  const [w, h, d] = plan.items[0].dimensions;
  const envelopeCorner = new THREE.Vector3(w / 2, h, d / 2);
  assert.ok(!chair.children.some((node) => {
    const positions = node.geometry.getAttribute("position");
    return Array.from({ length: positions.count }, (_, index) => new THREE.Vector3().fromBufferAttribute(positions, index).add(node.position))
      .some((position) => position.distanceTo(envelopeCorner) < 1e-5);
  }));
  assert.ok(chair.children.some((node) => node.geometry.type === "CylinderGeometry"));
  assert.equal(new Set(chair.children.map((node) => node.material.color.getHex())).size, 2);
  const before = root.matrix.clone(), positions = chair.children.map((node) => node.position.toArray());
  const controller = makeExplodeController([{ id: "chair", object: root }], new THREE.Box3(new THREE.Vector3(0, -.08, 0), new THREE.Vector3(4.2, 2.7, 3.5)), { reducedMotion: true });
  controller.setExploded(true, 0); controller.setExploded(false, 1); root.updateMatrix();
  assert.ok(root.matrix.equals(before)); assert.deepEqual(chair.children.map((node) => node.position.toArray()), positions);
  assert.deepEqual(plan, source); controller.dispose();
});

for (const [name, change] of Object.entries({
  "missing input binding": value => { value.binding = undefined; },
  "different job": ({ scene }) => { scene.userData.jobId = "another-scan"; },
  "different source bytes": ({ scene }) => { scene.userData.sourceRequestSha256 = "0".repeat(64); },
  "wrong furniture representation": ({ chair }) => { chair.userData.representation = "sensor_bounding_box"; },
  "wrong appearance status": ({ chair }) => { chair.userData.appearanceStatus = "photo_projected"; },
  "wrong proxy kind": ({ chair }) => { chair.userData.proxyGeometry = "sensor_bounding_box"; },
  "oversized label": ({ chair }) => { chair.userData.visualLabel = "x".repeat(201); },
  "different measured envelope": ({ chair }) => { chair.children[0].geometry.scale(1.1, 1, 1); },
  "different canonical pose": ({ chair }) => { chair.position.x += .02; },
})) test(`photo-informed binder rejects ${name}`, () => {
  const value = structuredFixture(); change(value);
  assert.throws(() => bindTexturedRoom(value.scene, value.plan, value.binding), /Photo model:/);
});

test("legacy photo model still requires actual photo_projected metadata", () => {
  const { scene, plan, binding } = structuredFixture(); delete scene.userData.captureRepresentation;
  assert.throws(() => bindTexturedRoom(scene, plan, binding), /photo-textured reconstruction/);
});

test("photo-informed model also accepts the exact normalized scene JSON hash", () => {
  const { scene, plan, binding } = structuredFixture();
  scene.userData.inputSha256 = binding.inputSha256; delete scene.userData.sourceRequestSha256;
  assert.equal(bindTexturedRoom(scene, plan, binding).representation, "photo_informed_parametric");
});


test("strictly bound structured opening frames and glass remain inside the measured aperture", () => {
  const { scene, plan, binding, entities } = structuredFixture();
  const opening = entities.get(plan.geometry.openings[0].id);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, .05), new THREE.MeshStandardMaterial({ transparent: true, opacity: .22 }));
  opening.add(glass);
  const bound = bindTexturedRoom(scene, plan, binding);
  assert.ok(bound.shell.getObjectById(glass.id));
  assert.equal(glass.parent, opening);
});

test("structured trim outside its opening envelope is rejected", () => {
  const { scene, plan, binding, entities } = structuredFixture();
  entities.get(plan.geometry.openings[0].id).add(new THREE.Mesh(new THREE.BoxGeometry(2.04, 1, 1), new THREE.MeshStandardMaterial()));
  assert.throws(() => bindTexturedRoom(scene, plan, binding), /opening trim exceeds/);
});

test("legacy photo projection still rejects geometry owned by an opening", () => {
  const { scene, plan, entities } = fixture();
  entities.get(plan.geometry.openings[0].id).add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  assert.throws(() => bindTexturedRoom(scene, plan), /unidentified geometry/);
});
