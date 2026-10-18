/** Actual Three.js GLTFLoader compatibility, scale, identity, and aperture checks.
 * node reconstruction/verify-glb.mjs <artifact-directory> [--validator-module /path/to/gltf-validator/index.js]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Box3, DoubleSide, Raycaster, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

async function verify(directory, validatorModule) {
  const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
  const source = JSON.parse(await readFile(resolve(directory, "scene.json"), "utf8"));
  for (const file of Object.values(manifest.files)) {
    assert(!file.fileName.includes("/") && !file.fileName.includes("\\"), "Manifest filenames must be local basenames");
    const bytes = await readFile(resolve(directory, file.fileName));
    assert.equal(bytes.length, file.byteLength, file.fileName + " byte length");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.fileName + " hash");
  }
  const bytes = await readFile(resolve(directory, "scene.glb"));
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new GLTFLoader().parseAsync(data, "");
  gltf.scene.updateMatrixWorld(true);
  const entities = new Map();
  gltf.scene.traverse((object) => {
    if (object.userData.entityId) {
      assert(!entities.has(object.userData.entityId), "Duplicate exported entity ID");
      entities.set(object.userData.entityId, object);
    }
    if (object.isMesh) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.side = DoubleSide;
      const positions = object.geometry.getAttribute("position");
      for (const number of positions.array) assert(Number.isFinite(number), "Nonfinite vertex");
    }
  });
  assert.equal(entities.size, manifest.objects.length, "Lost entity metadata");
  for (const expected of manifest.objects) {
    const object = entities.get(expected.id);
    assert(object, "Missing entity: " + expected.id);
    assert.equal(object.userData.role, expected.role);
    assert.deepEqual(JSON.parse(object.userData.evidenceIdsJson), expected.evidenceIds);
  }
  const bounds = new Box3().setFromObject(gltf.scene);
  const actual = { min: bounds.min.toArray(), max: bounds.max.toArray() };
  for (const edge of ["min", "max"]) {
    for (let i = 0; i < 3; i++) {
      const expected = manifest.bounds[edge][i];
      assert(Math.abs(actual[edge][i] - expected) < Math.max(1e-5, Math.abs(expected) * 1e-6), "GLB axis/scale mismatch");
    }
  }
  // Cast across only the corresponding wall, not the opposite room wall.
  for (const opening of source.geometry.openings) {
    const wall = source.geometry.walls.find((item) => item.id === opening.wallId);
    const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
    const dx = (wall.end[0] - wall.start[0]) / length;
    const dz = (wall.end[1] - wall.start[1]) / length;
    const u = opening.offset + opening.width / 2;
    const center = new Vector3(wall.start[0] + dx * u, opening.sillHeight + opening.height / 2, wall.start[1] + dz * u);
    const normal = new Vector3(-dz, 0, dx);
    const ray = new Raycaster(center.clone().addScaledVector(normal, wall.thickness * 2), normal.clone().negate(), 0, wall.thickness * 4);
    assert.equal(ray.intersectObject(entities.get(wall.id), true).length, 0, "Opening blocked: " + opening.id);
    const marker = entities.get(opening.id);
    assert(marker.getWorldPosition(new Vector3()).distanceTo(center) < 1e-5, "Opening marker transform mismatch");
  }
  const report = { valid: true, loader: "Three.js GLTFLoader", entityCount: entities.size,
    meshCount: manifest.statistics.meshCount, bounds: actual, testedApertures: source.geometry.openings.length,
    glbByteLength: bytes.length };
  if (validatorModule) {
    const imported = await import(pathToFileURL(resolve(validatorModule)).href);
    const validator = imported.default ?? imported;
    const validation = await validator.validateBytes(new Uint8Array(bytes), { uri: "scene.glb", maxIssues: 100 });
    report.khronos = validation;
    assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues));
    assert.equal(validation.issues.numWarnings, 0, JSON.stringify(validation.issues));
  }
  return report;
}

const args = process.argv.slice(2);
if (!args[0] || (args.length !== 1 && !(args.length === 3 && args[1] === "--validator-module"))) {
  console.error("Usage: node reconstruction/verify-glb.mjs <artifact-directory> [--validator-module /absolute/module/path]");
  process.exitCode = 2;
} else {
  try {
    console.log(JSON.stringify(await verify(args[0], args[2]), null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
