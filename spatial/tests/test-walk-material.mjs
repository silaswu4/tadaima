import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { applyWalkCutaway } from "../room/walk-material.ts";

test("captured glass keeps its original opacity, transparency and depth state across repeated orbit/walk returns", () => {
  const material = new THREE.MeshStandardMaterial({ transparent: true, opacity: .22, depthWrite: false });
  for (let i = 0; i < 4; i++) {
    applyWalkCutaway(material, true);
    assert.equal(material.opacity, .22 * .075); assert.equal(material.transparent, true); assert.equal(material.depthWrite, false);
    applyWalkCutaway(material, false);
    assert.equal(material.opacity, .22); assert.equal(material.transparent, true); assert.equal(material.depthWrite, false);
  }
});

test("opaque walls restore their base state without contaminating independent cloned finishes", () => {
  const material = new THREE.MeshStandardMaterial({ opacity: 1, depthWrite: true });
  const glass = material.clone(); glass.opacity = .4; glass.transparent = true; glass.depthWrite = true;
  applyWalkCutaway(material, true); applyWalkCutaway(glass, true);
  assert.equal(material.opacity, .075); assert.equal(glass.opacity, .4 * .075);
  assert.equal(material.depthWrite, false); assert.equal(glass.depthWrite, false);
  applyWalkCutaway(material, false); applyWalkCutaway(glass, false);
  assert.equal(material.opacity, 1); assert.equal(material.transparent, false); assert.equal(material.depthWrite, true);
  assert.equal(glass.opacity, .4); assert.equal(glass.transparent, true); assert.equal(glass.depthWrite, true);
});
