import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createIndoorLighting, fitRoomShadow } from "../room/indoor-lighting.ts";

function fixture(lite = false) {
  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight();
  const hemisphere = new THREE.HemisphereLight();
  scene.add(key, key.target, hemisphere);
  const bounds = new THREE.Box3(new THREE.Vector3(-4, -.1, -5), new THREE.Vector3(6, 2.44, 7));
  const lights = createIndoorLighting(scene, key, hemisphere, bounds, lite);
  return { scene, key, hemisphere, bounds, lights };
}

test("indoor profile restores shadowed depth without an expensive point-light shadow cube", () => {
  const { scene, key, bounds } = fixture();
  const casters = [], areas = [];
  scene.traverseVisible((node) => { if (node.isLight && node.castShadow) casters.push(node); if (node.isRectAreaLight) areas.push(node); });
  assert.deepEqual(casters, [key]);
  assert.equal(key.shadow.mapSize.x, 2048);
  assert.equal(areas.length, 2);
  for (const light of areas) {
    assert(bounds.containsPoint(light.position));
    const direction = light.getWorldDirection(new THREE.Vector3());
    assert(direction.y > .99); // Area emission is local -Z; getWorldDirection is +Z.
    assert.equal(light.castShadow, false);
  }
  assert(scene.environmentIntensity < .7, "must not restore the old ambient wash");
});

test("Quest forces a single 1024 shadow even on a desktop-sized viewport and restores desktop on exit", () => {
  const { scene, key, lights } = fixture();
  let disposals = 0;
  key.shadow.map = { dispose() { disposals++; } };
  lights.setImmersive(true);
  assert.equal(key.shadow.mapSize.x, 1024); assert.equal(key.shadow.map, null); assert.equal(disposals, 1);
  const active = []; scene.traverseVisible((node) => { if (node.isLight) active.push(node); });
  assert.equal(active.filter((node) => node.isRectAreaLight).length, 0);
  assert.equal(active.filter((node) => node.castShadow).length, 1);
  assert.equal(key.shadow.needsUpdate, true);
  lights.setImmersive(false);
  assert.equal(key.shadow.mapSize.x, 2048);
  assert.equal(lights.immersive, false);
});

test("mobile stays within the Quest lighting budget after entry, exit and reentry", () => {
  const { scene, key, lights } = fixture(true);
  for (const active of [true, false, true, false]) {
    lights.setImmersive(active);
    assert.equal(key.shadow.mapSize.x, 1024);
    let areas = 0; scene.traverseVisible((node) => { if (node.isRectAreaLight) areas++; });
    assert.equal(areas, 0);
  }
  lights.dispose(); lights.dispose();
  assert.equal(scene.getObjectByName("Indoor soft fill"), undefined);
});

test("fitted shadow projection includes all room corners, including translated large rooms", () => {
  for (const [minimum, maximum] of [[[-4, -.1, -5], [6, 2.44, 7]], [[110, 0, -80], [112, 4, -78]]]) {
    const { key } = fixture();
    const bounds = new THREE.Box3(new THREE.Vector3(...minimum), new THREE.Vector3(...maximum));
    const center = bounds.getCenter(new THREE.Vector3());
    key.target.position.copy(center); key.position.copy(center).add(new THREE.Vector3(-3, 18, 5));
    fitRoomShadow(key, bounds);
    for (const x of [minimum[0], maximum[0]]) for (const y of [minimum[1], maximum[1]]) for (const z of [minimum[2], maximum[2]]) {
      const projected = new THREE.Vector3(x, y, z).project(key.shadow.camera);
      assert(projected.toArray().every((value) => Number.isFinite(value) && Math.abs(value) <= 1.00001));
    }
  }
});
