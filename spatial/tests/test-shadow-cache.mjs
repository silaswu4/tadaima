import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createShadowCache } from "../room/shadow-cache.ts";

function fixture() {
  const root = new THREE.Scene();
  const parent = new THREE.Group(); root.add(parent);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.castShadow = true; parent.add(mesh);
  const shadowMap = { autoUpdate: true, needsUpdate: false };
  const cache = createShadowCache(shadowMap, root);
  const update = () => { shadowMap.needsUpdate = false; const changed = cache.update(); assert.equal(shadowMap.needsUpdate, changed); return changed; };
  return { root, parent, mesh, shadowMap, cache, update };
}

test("stationary room and camera movement reuse the shadow map", () => {
  const { root, shadowMap, update } = fixture();
  const camera = new THREE.PerspectiveCamera(); root.add(camera);
  assert.equal(shadowMap.autoUpdate, false);
  assert.equal(update(), true); assert.equal(update(), false);
  camera.position.set(4, 2, 3); camera.rotation.y = 1;
  assert.equal(update(), false);
});

test("edited and inherited transforms, including return to the original pose, refresh shadows", () => {
  const { mesh, parent, update } = fixture(); update();
  for (const change of [() => mesh.position.x = 1, () => mesh.rotation.y = .4,
    () => mesh.scale.setScalar(2), () => parent.position.z = 3, () => parent.rotation.y = .7,
    () => mesh.position.x = 0]) {
    change(); assert.equal(update(), true); assert.equal(update(), false);
  }
});

test("cutaway casting, hidden ancestors, storage and model replacement cannot leave stale shadows", () => {
  const { root, parent, mesh, update } = fixture(); update();
  for (const change of [() => mesh.castShadow = false, () => mesh.castShadow = true,
    () => parent.visible = false, () => parent.visible = true,
    () => mesh.visible = false, () => mesh.visible = true,
    () => mesh.removeFromParent(), () => parent.add(mesh),
    () => { mesh.removeFromParent(); const replacement = mesh.clone(); root.add(replacement); }]) {
    change(); assert.equal(update(), true); assert.equal(update(), false);
  }
});

test("non-casters and fully invisible materials do not invalidate otherwise stationary shadows", () => {
  const { root, mesh, update } = fixture(); update();
  const overlay = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); root.add(overlay);
  overlay.position.x = 5; assert.equal(update(), false);
  mesh.material.visible = false; assert.equal(update(), true); assert.equal(update(), false);
  mesh.position.x = 7; assert.equal(update(), false);
  mesh.material.visible = true; assert.equal(update(), true); assert.equal(update(), false);
});

test("geometry replacement and uploaded position/index edits invalidate cached depth", () => {
  const { mesh, update } = fixture(); update();
  mesh.geometry = mesh.geometry.clone(); assert.equal(update(), true); assert.equal(update(), false);
  mesh.geometry.attributes.position.needsUpdate = true; assert.equal(update(), true); assert.equal(update(), false);
  mesh.geometry.index.needsUpdate = true; assert.equal(update(), true); assert.equal(update(), false);
  mesh.geometry.setAttribute("position", mesh.geometry.attributes.position.clone()); assert.equal(update(), true);
  mesh.geometry.setIndex(mesh.geometry.index.clone()); assert.equal(update(), true);
  mesh.geometry.setDrawRange(0, 3); assert.equal(update(), true); assert.equal(update(), false);
});

test("interleaved vertices and instanced poses refresh without changing mesh world transform", () => {
  const { root, update } = fixture(); update();
  const geometry = new THREE.BufferGeometry();
  const data = new THREE.InterleavedBuffer(new Float32Array(9), 3);
  geometry.setAttribute("position", new THREE.InterleavedBufferAttribute(data, 3, 0));
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 2);
  mesh.castShadow = true; root.add(mesh); assert.equal(update(), true); assert.equal(update(), false);
  data.needsUpdate = true; assert.equal(update(), true);
  mesh.instanceMatrix.needsUpdate = true; assert.equal(update(), true);
  mesh.count = 1; assert.equal(update(), true); assert.equal(update(), false);
});

test("explicit invalidation covers changed lights and disposal releases ownership safely", () => {
  const { shadowMap, cache, update } = fixture(); update();
  cache.invalidate(); assert.equal(update(), true); assert.equal(update(), false);
  cache.dispose(); assert.equal(shadowMap.autoUpdate, true);
  shadowMap.needsUpdate = false;
  assert.equal(cache.update(), false); cache.invalidate(); assert.equal(shadowMap.needsUpdate, false);
  cache.dispose(); assert.equal(shadowMap.autoUpdate, true);
});

test("disposing preserves an owner's preexisting manual shadow policy", () => {
  const shadowMap = { autoUpdate: false, needsUpdate: false };
  const cache = createShadowCache(shadowMap, new THREE.Scene());
  assert.equal(cache.update(), true); cache.dispose();
  assert.equal(shadowMap.autoUpdate, false);
});
