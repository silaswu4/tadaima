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
import { decodePng, installNodePngDecoder } from "./png-decoder.mjs";

// Actual pixel decoding permits GLTFLoader's material path in Node. GPU upload,
// lighting, and appearance remain browser/render checks, not claims of this tool.
const decodedImages = installNodePngDecoder();

function inspectEmbeddedImages(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, "GLB magic");
  assert.equal(bytes.readUInt32LE(4), 2, "GLB version");
  assert.equal(bytes.readUInt32LE(8), bytes.length, "GLB length");
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, "GLB JSON chunk");
  const document = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength));
  const images = document.images ?? [];
  if (images.length === 0) return { document, images: [] };
  const binOffset = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(binOffset + 4), 0x004e4942, "GLB BIN chunk");
  const binLength = bytes.readUInt32LE(binOffset);
  assert.equal(binOffset + 8 + binLength, bytes.length, "GLB BIN length");
  const inspected = images.map((image) => {
    assert.equal(image.uri, undefined, "Room texture must be embedded, not a network/local URI");
    assert.equal(image.mimeType, "image/png", "Verifier supports exported PNG textures only");
    const view = document.bufferViews?.[image.bufferView];
    assert(view && view.buffer === 0, "Image bufferView must reference GLB binary");
    const start = view.byteOffset ?? 0;
    assert(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(view.byteLength) && view.byteLength > 0
      && start + view.byteLength <= binLength, "Image bufferView bounds");
    const pixels = decodePng(bytes.subarray(binOffset + 8 + start, binOffset + 8 + start + view.byteLength));
    return { width: pixels.width, height: pixels.height, pixelCount: pixels.width * pixels.height };
  });
  return { document, images: inspected };
}

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
  const embedded = inspectEmbeddedImages(bytes);
  const textured = embedded.images.length > 0;
  const captured = manifest.captureRepresentation === "observed_surface_mesh";
  const surface = manifest.surfaceReconstruction;
  if (captured) {
    assert.equal(manifest.renderProfile, "captured-surface-rgb-v1");
    assert.equal(surface?.schemaVersion, "roomplan-surface-mesh/1.0");
    assert.deepEqual(JSON.parse(await readFile(resolve(directory, "surface-reconstruction.json"), "utf8")), surface);
    for (const key of ["projectId", "jobId", "inputRevision", "inputSha256"]) assert.equal(surface[key], manifest[key]);
    assert.match(surface.meshSha256, /^[0-9a-f]{64}$/);
    assert.match(surface.sourceArchiveSha256, /^[0-9a-f]{64}$/);
    assert.equal(surface.triangleCount, manifest.statistics.triangleCount);
    assert.equal(surface.observedTriangleCount + surface.unobservedTriangleCount, surface.triangleCount);
    assert(surface.vertexCount > 0 && surface.vertexCount <= 200000 && surface.triangleCount > 0 && surface.triangleCount <= 300000);
    assert.equal(surface.triangleSourceIndices.length, surface.triangleCount);
    assert.equal(surface.photoCount, surface.photoSources.length);
    for (const index of surface.triangleSourceIndices) assert(Number.isInteger(index) && index >= -1 && index < surface.photoCount);
    assert.equal(surface.triangleSourceIndices.filter((index) => index >= 0).length, surface.observedTriangleCount);
    assert(surface.coverage >= 0 && surface.coverage <= 1);
    assert(manifest.objects.every((entry) => entry.role === "captured_surface"), "Reference GLB must exclude planning boxes");
    assert(embedded.images.every((image) => image.width <= 1024 && image.height <= 1024));
  }
  const windowProfile = manifest.renderProfile === "pbr-window-daylight-v2";
  const sourceSurfaces = new Map((source.appearance?.surfaces ?? []).map((surface) => [surface.entityId, surface]));
  const photoEntities = new Map((manifest.photoTexturing?.entities ?? []).map((entry) => [entry.entityId, entry]));
  if (manifest.photoTexturing) {
    assert.deepEqual(JSON.parse(await readFile(resolve(directory, "photo-texturing.json"), "utf8")), manifest.photoTexturing);
    for (const entry of photoEntities.values()) {
      assert(/^photo-textures\/photo-atlas-[0-9]{4}\.png$/.test(entry.atlas), "Photo atlas must be a local generated PNG");
      const png = await readFile(resolve(directory, entry.atlas));
      assert.equal(createHash("sha256").update(png).digest("hex"), entry.atlasSha256, "Photo atlas hash");
      const decoded = decodePng(png);
      assert.equal(decoded.width, entry.atlasWidth); assert.equal(decoded.height, entry.atlasHeight);
    }
  }
  if (windowProfile || manifest.renderProfile === "pbr-daylight-v1") assert(textured, "PBR profile must export embedded material images");
  const decodedBefore = decodedImages.length;
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new GLTFLoader().parseAsync(data, "");
  gltf.scene.updateMatrixWorld(true);
  const entities = new Map();
  let testedTriangles = 0, observedTriangles = 0;
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
      if (captured) {
        let owner = object;
        while (owner && !owner.userData.entityId) owner = owner.parent;
        assert.equal(owner?.userData.role, "captured_surface", "All visible geometry must be observed surfaces");
        const uv = object.geometry.getAttribute("uv");
        assert(uv && uv.count === positions.count && uv.itemSize === 2);
        for (const number of uv.array) assert(Number.isFinite(number), "Nonfinite observed-surface UV");
        const triangles = (object.geometry.index?.count ?? positions.count) / 3;
        assert(Number.isInteger(triangles), "Observed surfaces must remain triangles");
        testedTriangles += triangles;
        for (const material of materials) {
          if (material.userData.appearanceSource === "observed_camera_rgb") {
            assert(material.isMeshBasicMaterial, "Observed camera RGB must use KHR_materials_unlit");
            assert(material.map?.image?.data?.length > 0, "Observed RGB must actually decode");
            assert(surface.photoSources.some((photo) => photo.photoId === material.userData.photoId
              && photo.evidenceId === material.userData.evidenceId), "Unbound observed material source");
            if (materials.length === 1) observedTriangles += triangles;
          } else {
            assert.equal(material.userData.appearanceSource, "unobserved_plain_fallback");
            assert(material.isMeshStandardMaterial && !material.map && material.metalness === 0,
              "Unobserved faces must retain plain neutral PBR");
          }
        }
      } else if (textured) {
        const uv = object.geometry.getAttribute("uv");
        assert(uv && uv.itemSize === 2 && uv.count === positions.count, "Textured mesh needs complete UVs");
        for (const number of uv.array) assert(Number.isFinite(number), "Nonfinite UV");
        assert(materials.every((material) => material.isMeshStandardMaterial), "Exported material must use metallic/roughness PBR");
        for (const material of materials) {
          assert.equal(material.metalness, 0, "Room surfaces must not become metallic");
          const photo = photoEntities.get(object.userData.entityId);
          if (photo) {
            assert(material.map?.image?.data?.length > 0, "Captured RGB must actually decode");
            assert.equal(material.map.image.width, photo.atlasWidth);
            assert.equal(material.map.image.height, photo.atlasHeight);
            assert.equal(material.normalMap, null, "Photo UV atlas must not reuse procedural normal UVs");
            assert.equal(object.userData.appearanceStatus, photo.coverage > 0 ? "photo_projected" : "unobserved");
            assert(Math.abs(object.userData.photoTextureCoverage - photo.coverage) < 1e-6);
            assert.deepEqual(JSON.parse(object.userData.photoEvidenceIdsJson), photo.evidenceIds);
            continue;
          }
          assert(material.normalMap?.image?.data?.length > 0, "Packed normal map must actually decode");
          const existing = object.userData.role === "existing_furniture";
          const spec = existing ? undefined : sourceSurfaces.get(object.userData.entityId);
          const finish = spec?.finish ?? (object.userData.role === "room_floor" ? "wood" : "paint");
          if (windowProfile) {
            assert.equal(object.userData.finish, finish, "Finish must match source surface binding");
            assert.equal(object.userData.appearanceStatus, existing ? "sensor_proxy" : spec ? "photo_estimate" : "styling_default");
            if (spec && finish !== "wood") {
              const encoded = [1, 3, 5].map((offset) => parseInt(spec.color.slice(offset, offset + 2), 16) / 255);
              const linear = encoded.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
              material.color.toArray().forEach((value, index) => assert(Math.abs(value - linear[index]) < 1e-6, "PBR color must preserve photo estimate"));
              assert(Math.abs(material.roughness - spec.roughness) < 1e-6, "PBR roughness must preserve photo estimate");
            }
          }
          if (finish === "wood") {
            assert(material.map?.image?.data?.length > 0, "Wood base color must actually decode");
            assert(material.roughnessMap?.image?.data?.length > 0, "Wood roughness must actually decode");
          }
        }
      }
    }
  });
  assert.equal(entities.size, manifest.objects.length, "Lost entity metadata");
  if (captured) {
    assert.equal(testedTriangles, surface.triangleCount, "Observed triangle topology changed during export");
    assert.equal(observedTriangles, surface.observedTriangleCount, "Observed triangle/material coverage mismatch");
    assert.equal(gltf.scene.userData.captureRepresentation, "observed_surface_mesh");
    assert.equal(gltf.scene.userData.inputSha256, manifest.inputSha256);
    assert.equal(gltf.scene.userData.sourceRequestSha256, manifest.sourceRequestSha256);
    for (const object of entities.values()) {
      const refs = JSON.parse(object.userData.evidenceIdsJson);
      assert(refs.every((id) => surface.photoSources.some((photo) => photo.evidenceId === id)));
      assert.equal(object.userData.meshSha256, surface.meshSha256);
      assert.equal(object.userData.representation, "observed_surface_mesh");
    }
  }
  for (const expected of manifest.objects) {
    const object = entities.get(expected.id);
    assert(object, "Missing entity: " + expected.id);
    assert.equal(object.userData.role, expected.role);
    assert.deepEqual(JSON.parse(object.userData.evidenceIdsJson), expected.evidenceIds);
  }
  for (const item of captured ? [] : source.items ?? []) {
    const object = entities.get(item.id);
    assert(object?.isMesh && object.userData.role === "existing_furniture", "Existing furniture must be a separate editable mesh");
    assert.equal(object.userData.origin, "existing_owned");
    assert.equal(object.userData.roomId, item.roomId);
    assert.equal(object.userData.label, item.label);
    assert.equal(object.userData.locked, item.locked);
    assert.equal(object.userData.proxyGeometry, "sensor_bounding_box");
    const photo = photoEntities.get(item.id);
    assert.equal(object.userData.appearanceStatus, photo ? photo.coverage > 0 ? "photo_projected" : "unobserved" : "sensor_proxy");
    assert.deepEqual(JSON.parse(object.userData.dimensionsJson), item.dimensions);
    assert.deepEqual(JSON.parse(object.userData.evidenceIdsJson), item.evidenceIds ?? []);
    assert(object.getWorldPosition(new Vector3()).distanceTo(new Vector3(...item.position)) < 1e-5, "Furniture bottom-center origin mismatch");
    const [width, height, depth] = item.dimensions;
    const cosine = Math.cos(item.rotationY), sine = Math.sin(item.rotationY);
    const expected = [];
    for (const x of [-width / 2, width / 2]) for (const y of [0, height]) for (const z of [-depth / 2, depth / 2]) {
      expected.push(new Vector3(item.position[0] + cosine * x + sine * z, item.position[1] + y,
        item.position[2] - sine * x + cosine * z));
    }
    const actualBounds = new Box3().setFromObject(object);
    const expectedBounds = new Box3().setFromPoints(expected);
    assert(actualBounds.min.distanceTo(expectedBounds.min) < 1e-5 && actualBounds.max.distanceTo(expectedBounds.max) < 1e-5,
      "Furniture width/depth, yaw or elevation mismatch");
    const vertices = object.geometry.getAttribute("position");
    const actualVertices = Array.from({ length: vertices.count }, (_, index) =>
      new Vector3().fromBufferAttribute(vertices, index).applyMatrix4(object.matrixWorld));
    assert(expected.every((point) => actualVertices.some((candidate) => point.distanceTo(candidate) < 1e-5)),
      "Furniture corner orientation mismatch");
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
  for (const opening of captured ? [] : source.geometry.openings) {
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
    meshCount: manifest.statistics.meshCount, bounds: actual, testedApertures: captured ? 0 : source.geometry.openings.length,
    testedExistingFurniture: captured ? 0 : source.items?.length ?? 0,
    ...(captured ? {captureRepresentation: "observed_surface_mesh", testedObservedTriangles: testedTriangles,
      observedTriangles, unobservedTriangles: surface.unobservedTriangleCount} : {}),
    glbByteLength: bytes.length, embeddedPngImages: embedded.images,
    loaderDecodedImageCount: decodedImages.length - decodedBefore,
    renderingVerified: false };
  if (textured) assert(decodedImages.length > decodedBefore, "GLTFLoader must decode embedded textures");
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
