import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { makeWorkspaceDemo } from "../room/workspace-fixture.ts";
import { bindCapturedRoom, capturedCameraPose, validateLocalCapturedGlb } from "../room/textured-model.ts";

const binding = { jobId: "scan-001", inputSha256: "a".repeat(64) };
const plan = makeWorkspaceDemo();
function metadata() { return { captureRepresentation: "observed_surface_mesh", projectId: plan.projectId, inputRevision: String(plan.revision), jobId: binding.jobId, inputSha256: binding.inputSha256 }; }
function fixture() {
  const scene = new THREE.Group(); scene.userData = metadata();
  const geometry = new THREE.BufferGeometry();
  // An irregular observed surface, deliberately not a furniture bounding box.
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, .25, 0, .4, 1, .2], 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: "#ac7966" }));
  mesh.userData = { entityId: "mesh-12345678-abcd-1234-abcd-1234567890ab", role: "captured_surface", appearanceStatus: "photo_projected", photoTextureCoverage: .75 };
  scene.add(mesh); return { scene, mesh };
}
function glb(mutate = () => {}) {
  const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0], extras: metadata() }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ count: 3, type: "VEC3", componentType: 5126 }],
    bufferViews: [{ buffer: 0, byteLength: 4 }], buffers: [{ byteLength: 4 }] };
  mutate(json);
  const raw = Buffer.from(JSON.stringify(json)), padded = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
  const bytes = Buffer.alloc(28 + padded.length + 4);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(padded.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); padded.copy(bytes, 20);
  bytes.writeUInt32LE(4, 20 + padded.length); bytes.writeUInt32LE(0x004e4942, 24 + padded.length);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test("captured surface reference preserves irregular geometry and uses unlit photo appearance", () => {
  const { scene, mesh } = fixture(), original = mesh.geometry.attributes.position.array.slice();
  const bound = bindCapturedRoom(scene, plan, binding);
  assert.equal(bound.surfaceCount, 1); assert.equal(bound.projectedSurfaces, 1);
  assert.equal(bound.reference.children[0], scene);
  assert.deepEqual(mesh.geometry.attributes.position.array, original);
  assert.ok(mesh.material instanceof THREE.MeshBasicMaterial);
  assert.equal(mesh.material.toneMapped, false); assert.equal(mesh.material.side, THREE.DoubleSide);
  assert.equal(mesh.castShadow, false);
});

test("captured preflight binds source JSON bytes or normalized scene bytes", () => {
  validateLocalCapturedGlb(glb(), plan, binding);
  validateLocalCapturedGlb(glb(j => { j.scenes[0].extras.inputSha256 = "b".repeat(64); j.scenes[0].extras.sourceRequestSha256 = binding.inputSha256; }), plan, binding);
});
for (const [name, change] of Object.entries({
  "different project": j => { j.scenes[0].extras.projectId = "other"; },
  "different job": j => { j.scenes[0].extras.jobId = "scan-002"; },
  "different revision": j => { j.scenes[0].extras.inputRevision = "9999"; },
  "different input bytes": j => { j.scenes[0].extras.inputSha256 = "b".repeat(64); },
  "wrong representation": j => { j.scenes[0].extras.captureRepresentation = "furniture_proxy"; },
  "too many vertices": j => { j.accessors[0].count = 900003; },
  "incomplete triangles": j => { j.accessors[0].count = 4; },
  "external texture": j => { j.images = [{ uri: "https://example.com/secret.jpg" }]; },
})) test(`captured preflight rejects ${name}`, () => assert.throws(() => validateLocalCapturedGlb(glb(change), plan, binding), /Photo model:/));

for (const [name, change] of Object.entries({
  "missing role": ({ mesh }) => { delete mesh.userData.role; },
  "proxy identity": ({ mesh }) => { mesh.userData.entityId = "chair-001"; },
  "invalid coverage": ({ mesh }) => { mesh.userData.photoTextureCoverage = NaN; },
  "coverage without observation": ({ mesh }) => { mesh.userData.appearanceStatus = "unobserved"; },
  "empty projected coverage": ({ mesh }) => { mesh.userData.photoTextureCoverage = 0; },
  "nonfinite UV": ({ mesh }) => { mesh.geometry.setAttribute("uv", new THREE.Float32BufferAttribute([NaN, 0, 0, 1, 1, 1], 2)); },
  "nonfinite position": ({ mesh }) => { mesh.geometry.attributes.position.setX(0, Infinity); },
  "nonrigid scale": ({ mesh }) => { mesh.scale.set(2, .5, 1); },
  "reflected transform": ({ mesh }) => { mesh.scale.x = -1; },
  "invalid index": ({ mesh }) => { mesh.geometry.setIndex([0, 1, 4]); },
  "unidentified geometry": ({ scene }) => { scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())); },
  "unbound source": ({ scene }) => { scene.userData.inputSha256 = "0".repeat(64); },
})) test(`captured binder rejects ${name} before changing source materials`, () => {
  const value = fixture(), material = value.mesh.material; change(value);
  assert.throws(() => bindCapturedRoom(value.scene, plan, binding), /Photo model:/);
  assert.equal(value.mesh.material, material);
});

test("unobserved scan geometry remains an explicitly untextured surface", () => {
  const { scene, mesh } = fixture(); mesh.userData.appearanceStatus = "unobserved"; mesh.userData.photoTextureCoverage = 0;
  assert.equal(bindCapturedRoom(scene, plan, binding).projectedSurfaces, 0);
});


test("multi-material chunks preserve their semantic group and independent primitive geometry", () => {
  const { scene, mesh } = fixture();
  const group = new THREE.Group(); group.userData = mesh.userData; mesh.userData = {};
  mesh.removeFromParent(); group.add(mesh);
  group.add(new THREE.Mesh(mesh.geometry.clone(), new THREE.MeshStandardMaterial())); scene.add(group);
  const bound = bindCapturedRoom(scene, plan, binding);
  assert.equal(bound.surfaceCount, 1); assert.equal(bound.projectedSurfaces, 1);
  assert.equal(group.children.length, 2);
});


test("unlit conversion keeps the captured photo texture and color", () => {
  const { scene, mesh } = fixture(), texture = new THREE.Texture();
  mesh.material = new THREE.MeshStandardMaterial({ color: "#afafaf", map: texture });
  const color = mesh.material.color.clone();
  bindCapturedRoom(scene, plan, binding);
  assert.equal(mesh.material.map, texture); assert.ok(mesh.material.color.equals(color));
});


test("captured camera pose preserves exact canonical position and look direction", () => {
  const camera = { captureCameraPosition: [-1.4, 1.65, 2.8], captureCameraTarget: [-1.4, 1.5, 1.8] };
  const before = structuredClone(camera);
  assert.deepEqual(capturedCameraPose(camera), { position: camera.captureCameraPosition, target: camera.captureCameraTarget });
  assert.deepEqual(camera, before); assert.equal(capturedCameraPose({}), null);
  const { scene } = fixture(); Object.assign(scene.userData, camera);
  assert.deepEqual(bindCapturedRoom(scene, plan, binding).cameraPose, { position: camera.captureCameraPosition, target: camera.captureCameraTarget });
  validateLocalCapturedGlb(glb(j => Object.assign(j.scenes[0].extras, camera)), plan, binding);
});
for (const [name, position, target] of [
  ["partial pose", [1, 2, 3], undefined],
  ["nonfinite position", [1, NaN, 3], [0, 0, 0]],
  ["nonfinite target", [1, 2, 3], [Infinity, 0, 0]],
  ["extra axis", [1, 2, 3, 4], [0, 0, 0]],
  ["out of bounds", [1001, 2, 3], [1000, 2, 3]],
  ["zero direction", [1, 2, 3], [1, 2, 3]],
  ["excessive direction", [0, 0, 0], [101, 0, 0]],
]) test(`captured camera rejects ${name}`, () => {
  assert.throws(() => capturedCameraPose({ captureCameraPosition: position, captureCameraTarget: target }), /Photo model:/);
});

test("UV seam-expanded captured geometry can reach 900k exported vertices at 300k triangles", () => {
  validateLocalCapturedGlb(glb(j => { j.accessors[0].count = 900000; }), plan, binding);
  assert.throws(() => validateLocalCapturedGlb(glb(j => { j.accessors[0].count = 900003; }), plan, binding), /Photo model:/);
  // Indexed meshes can exceed the triangle budget even with few positions.
  assert.throws(() => validateLocalCapturedGlb(glb(j => { j.accessors.push({ count: 900003, type: "SCALAR", componentType: 5125 }); j.meshes[0].primitives[0].indices = 1; }), plan, binding), /Photo model:/);
});
