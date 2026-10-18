import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { meshColliders, cachedMeshColliders } from "../room/mesh-collider.ts";

const box = (w, h, d, x, y, z) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
  mesh.position.set(x, y, z);
  return mesh;
};

/** A 1.2 x 0.75 x 0.8 table: 4 cm top, four 4 cm legs. */
function table() {
  const root = new THREE.Group();
  root.add(box(1.2, 0.04, 0.8, 0, 0.73, 0));
  for (const [x, z] of [[-0.56, -0.36], [0.56, -0.36], [-0.56, 0.36], [0.56, 0.36]]) root.add(box(0.04, 0.71, 0.04, x, 0.355, z));
  return root;
}

const low = (b) => b[1] - b[4] / 2;
const high = (b) => b[1] + b[4] / 2;
const covers = (parts, [x, y, z]) => parts.some(([cx, cy, cz, w, h, d]) => Math.abs(x - cx) <= w / 2 + 1e-6 && Math.abs(y - cy) <= h / 2 + 1e-6 && Math.abs(z - cz) <= d / 2 + 1e-6);

test("a box-and-legs table voxelizes into a top and four legs, open underneath", () => {
  const parts = meshColliders(table());
  assert.ok(parts.length >= 5 && parts.length <= 24, `got ${parts.length} parts`);
  // the top is one wide thin slab near 71 to 75 cm
  const top = parts.find((b) => b[3] > 1 && b[5] > 0.6);
  assert.ok(top, "has a tabletop part");
  assert.ok(low(top) > 0.6 && high(top) <= 0.76, `top spans ${low(top)} to ${high(top)}`);
  // every leg registers down to the floor
  for (const [x, z] of [[-0.56, -0.36], [0.56, -0.36], [-0.56, 0.36], [0.56, 0.36]]) assert.ok(covers(parts, [x, 0.1, z]), `leg at ${x},${z}`);
  // the space a chair tucks into stays empty
  assert.ok(!covers(parts, [0, 0.3, 0]), "under the middle is free");
  assert.ok(!covers(parts, [0.3, 0.45, 0.3]), "under the top is free");
  // parts stay in the piece's frame and size
  for (const b of parts) {
    assert.ok(low(b) >= -1e-6 && high(b) <= 0.751, "within height");
    assert.ok(Math.abs(b[0]) + b[3] / 2 <= 0.61 && Math.abs(b[2]) + b[5] / 2 <= 0.41, "within footprint");
  }
});

test("a thin pedestal never disappears, even with a tight cap", () => {
  const root = new THREE.Group();
  root.add(box(1, 0.04, 1, 0, 0.73, 0));
  root.add(box(0.03, 0.71, 0.03, 0, 0.355, 0));
  for (const maxBoxes of [24, 2]) {
    const parts = meshColliders(root, { maxBoxes });
    assert.ok(parts.length <= Math.max(2, maxBoxes));
    assert.ok(covers(parts, [0, 0.2, 0]), "pedestal registered");
  }
});

test("a closed solid fills in, and the cap holds for detailed meshes", () => {
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.4, 48, 32));
  sphere.position.y = 0.4;
  const parts = meshColliders(sphere);
  assert.ok(parts.length <= 24 && parts.length >= 1);
  assert.ok(covers(parts, [0, 0.4, 0]), "interior is solid");
  assert.ok(!covers(parts, [0.39, 0.03, 0.39]), "corners of the bounding box stay free");
});

test("scaled, rotated children are measured after fitting, and results are cached per key", () => {
  const group = new THREE.Group();
  const inner = table();
  inner.scale.set(2, 1, 1);
  group.add(inner);
  const parts = cachedMeshColliders("test-table|2.4x0.75x0.8", group);
  const top = parts.find((b) => b[3] > 2);
  assert.ok(top, "tabletop widened by the fitted scale");
  parts[0][0] = 99;
  assert.notEqual(cachedMeshColliders("test-table|2.4x0.75x0.8", new THREE.Group())[0][0], 99, "callers get copies");
});

test("no geometry gives no parts", () => {
  assert.deepEqual(meshColliders(new THREE.Group()), []);
});
