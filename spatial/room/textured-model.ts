import * as THREE from "three";
import type { RoomPlan } from "../../backend/contracts";

export const MAX_TEXTURED_MODEL_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
const allowedExtensions = new Set(["KHR_materials_ior", "KHR_materials_specular", "KHR_materials_clearcoat", "KHR_materials_sheen", "KHR_materials_emissive_strength", "KHR_materials_unlit", "KHR_texture_transform"]);
function fail(detail: string): never { throw new Error(`Photo model: ${detail}`); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid GLB metadata.");
  return value as Record<string, unknown>;
}
function array(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) fail("unsupported GLB array size.");
  return value;
}
function integer(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) fail("invalid GLB index or size.");
  return value as number;
}
function imageDimensions(bytes: Uint8Array, mime: unknown): [number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png" && bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
    && view.getUint32(12) === 0x49484452) return [view.getUint32(16), view.getUint32(20)];
  if (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xD9 || marker === 0xDA) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xC0, 0xC1, 0xC2].includes(marker) && length >= 8) return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      offset += length;
    }
  }
  return fail("only embedded PNG/JPEG images with readable dimensions are supported.");
}

/** Inspect before GLTFLoader can create image URLs or request any resources. */
export function validateLocalTexturedGlb(bytes: ArrayBuffer): void {
  if (bytes.byteLength < 28 || bytes.byteLength > MAX_TEXTURED_MODEL_BYTES) fail("choose a GLB smaller than 64 MiB.");
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== 0x46546C67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) fail("choose a complete glTF 2 GLB.");
  const jsonLength = view.getUint32(12, true);
  if (jsonLength > 2 * 1024 * 1024 || jsonLength % 4 || 20 + jsonLength + 8 > bytes.byteLength || view.getUint32(16, true) !== 0x4E4F534A) fail("invalid GLB JSON chunk.");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes, 20, jsonLength))); }
  catch { fail("invalid GLB JSON."); }
  const raw = record(parsed), binOffset = 20 + jsonLength, binLength = view.getUint32(binOffset, true);
  if (view.getUint32(binOffset + 4, true) !== 0x004E4942 || binLength % 4 || binOffset + 8 + binLength !== bytes.byteLength) fail("one embedded binary chunk is required.");
  function inspect(value: unknown, depth = 0) {
    if (depth > 32) fail("GLB metadata is too deeply nested.");
    if (Array.isArray(value)) { for (const child of value) inspect(child, depth + 1); }
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
      if (key === "uri") fail("external URLs and data URLs are not allowed; embed all resources in the GLB.");
      if (key === "extensions") for (const extension of Object.keys(record(child))) if (!allowedExtensions.has(extension)) fail("unsupported model extension.");
      inspect(child, depth + 1);
    }
  }
  inspect(raw);
  if (record(raw.asset).version !== "2.0" || raw.animations || raw.skins || raw.cameras) fail("use the static reconstruction GLB without animation, skins or cameras.");
  for (const name of [...array(raw.extensionsUsed ?? [], 16), ...array(raw.extensionsRequired ?? [], 16)]) if (!allowedExtensions.has(String(name))) fail("unsupported model extension.");
  const buffers = array(raw.buffers, 1);
  if (buffers.length !== 1) fail("one embedded buffer is required.");
  const length = integer(record(buffers[0]).byteLength, binLength);
  if (binLength - length > 3) fail("binary length does not match its buffer.");
  const views = array(raw.bufferViews, 10000).map((entry) => {
    const buffer = record(entry), offset = integer(buffer.byteOffset ?? 0, length), size = integer(buffer.byteLength, length);
    if (buffer.buffer !== 0 || offset + size > length) fail("buffer view exceeds the embedded data.");
    return { offset, size };
  });
  let pixels = 0;
  for (const entry of array(raw.images ?? [], 256)) {
    const image = record(entry), buffer = views[integer(image.bufferView, views.length - 1)];
    const [width, height] = imageDimensions(new Uint8Array(bytes, binOffset + 8 + buffer.offset, buffer.size), image.mimeType);
    if (!width || !height || width > 4096 || height > 4096 || (pixels += width * height) > MAX_IMAGE_PIXELS) fail("embedded images exceed the texture memory limit.");
  }
  let vertices = 0;
  for (const entry of array(raw.accessors, 10000)) {
    const accessor = record(entry);
    if (accessor.sparse || (vertices += integer(accessor.count, 2_000_000)) > 8_000_000) fail("geometry exceeds the supported vertex limit.");
  }
  const nodes = array(raw.nodes, 2048);
  const roots = array(record(array(raw.scenes, 1)[0]).nodes, 2048).map((index) => integer(index, nodes.length - 1));
  if (raw.scene !== undefined && raw.scene !== 0) fail("choose a single-scene reconstruction GLB.");
  const visited = new Set<number>();
  function visit(index: number) {
    if (visited.has(index)) fail("model nodes form a cycle or have multiple parents.");
    visited.add(index);
    const node = record(nodes[index]);
    if (node.skin !== undefined || node.weights !== undefined) fail("animated geometry is unsupported.");
    for (const child of array(node.children ?? [], 2048)) {
      const next = integer(child, nodes.length - 1);
      visit(next);
    }
  }
  for (const root of roots) visit(root);
  if (visited.size !== nodes.length) fail("model contains unreachable nodes.");
  array(raw.meshes, 2048).forEach((entry) => array(record(entry).primitives, 32).forEach((entry) => {
    const primitive = record(entry);
    if (primitive.targets || (primitive.mode !== undefined && primitive.mode !== 4)) fail("only static triangle meshes are supported.");
  }));
}

function near(actual: number, expected: number, tolerance = .003) { return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance; }
function requireMatrix(node: THREE.Object3D, position: number[], yaw: number, scale = [1, 1, 1]) {
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...position),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(...scale));
  if (!node.matrixWorld.elements.every((value, index) => near(value, matrix.elements[index]))) fail("model placement does not match the opened room file.");
}
function localBounds(node: THREE.Object3D): THREE.Box3 {
  const inverse = node.matrixWorld.clone().invert(), box = new THREE.Box3();
  node.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.computeBoundingBox();
    box.union(child.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, child.matrixWorld)));
  });
  return box;
}

/** Validate actual loaded geometry; no caller input or canonical placement is changed. */
export function bindTexturedRoom(model: THREE.Object3D, plan: RoomPlan) {
  if (model.userData.projectId !== plan.projectId || model.userData.inputRevision !== String(plan.revision)) {
    fail("model project or revision does not match the opened room file.");
  }
  model.updateMatrixWorld(true);
  const expected = new Map<string, string>([
    ...plan.geometry.rooms.map((entry) => [entry.id, "room_floor"] as const),
    ...plan.geometry.walls.map((entry) => [entry.id, "wall"] as const),
    ...plan.geometry.openings.map((entry) => [entry.id, "opening"] as const),
    ...plan.items.map((entry) => [entry.id, "existing_furniture"] as const),
  ]);
  const entities = new Map<string, THREE.Object3D>();
  let projected = 0;
  model.traverse((node) => {
    if (node.userData.entityId !== undefined) {
      const id = node.userData.entityId;
      if (typeof id !== "string" || entities.has(id) || expected.get(id) !== node.userData.role) fail("model entity IDs or roles do not match the opened room file.");
      entities.set(id, node);
      if (node.userData.appearanceStatus === "photo_projected") projected++;
    }
    if (node instanceof THREE.Mesh) {
      let owner: THREE.Object3D | null = node;
      while (owner && owner.userData.entityId === undefined) owner = owner.parent;
      if (!owner || owner.userData.role === "opening") fail("model contains unidentified geometry.");
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      if (materials.some((material) => !(material instanceof THREE.MeshStandardMaterial))) fail("use standard PBR materials.");
      const positions = node.geometry.getAttribute("position");
      if (!positions || positions.count > 2_000_000) fail("model geometry is missing or too large.");
      for (let index = 0; index < positions.count; index++) if (![positions.getX(index), positions.getY(index), positions.getZ(index)].every(Number.isFinite)) fail("model contains nonfinite vertices.");
    }
  });
  if (entities.size !== expected.size || !projected) fail("choose the matching photo-textured reconstruction GLB, including every room entity.");
  for (const room of plan.geometry.rooms) {
    const node = entities.get(room.id)!, bounds = new THREE.Box3().setFromObject(node, true);
    const xs = room.floorPolygon.map((point) => point[0]), zs = room.floorPolygon.map((point) => point[1]);
    if (![near(bounds.min.x, Math.min(...xs)), near(bounds.max.x, Math.max(...xs)), near(bounds.min.z, Math.min(...zs)),
      near(bounds.max.z, Math.max(...zs)), near(bounds.min.y, -.08), near(bounds.max.y, 0)].every(Boolean)) fail("model floor extents do not match the room file.");
  }
  for (const wall of plan.geometry.walls) {
    const node = entities.get(wall.id)!, dx = wall.end[0] - wall.start[0], dz = wall.end[1] - wall.start[1];
    requireMatrix(node, [wall.start[0], 0, wall.start[1]], -Math.atan2(dz, dx));
    const bounds = localBounds(node), length = Math.hypot(dx, dz), half = wall.thickness / 2;
    // A full-width aperture can leave only a lintel or sill, and a fully
    // open boundary legitimately has no mesh. Derive remaining height spans.
    const openings = plan.geometry.openings.filter((entry) => entry.wallId === wall.id);
    const cuts = [...new Set([0, length, ...openings.flatMap((entry) => [entry.offset, entry.offset + entry.width])])].sort((a, b) => a - b);
    const spans: [number, number][] = [];
    for (let index = 0; index < cuts.length - 1; index++) {
      const middle = (cuts[index] + cuts[index + 1]) / 2;
      let bottom = 0;
      const apertures = openings.filter((entry) => middle > entry.offset && middle < entry.offset + entry.width).sort((a, b) => a.sillHeight - b.sillHeight);
      for (const opening of apertures) {
        if (opening.sillHeight > bottom) spans.push([bottom, opening.sillHeight]);
        bottom = Math.max(bottom, opening.sillHeight + opening.height);
      }
      if (bottom < wall.height - 1e-7) spans.push([bottom, wall.height]);
    }
    // Miters may extend beyond the centerline ends; the side thickness and
    // supported vertical extent must still agree with the opened geometry.
    if (bounds.isEmpty() !== (spans.length === 0) || (!bounds.isEmpty() && !(near(bounds.min.y, Math.min(...spans.map((entry) => entry[0])))
      && near(bounds.max.y, Math.max(...spans.map((entry) => entry[1]))) && near(bounds.min.z, -half) && near(bounds.max.z, half)
      && bounds.min.x >= -Math.max(2, wall.thickness * 20) && bounds.max.x <= length + Math.max(2, wall.thickness * 20)))) fail("model wall extents do not match the room file.");
  }
  for (const opening of plan.geometry.openings) {
    const wall = plan.geometry.walls.find((entry) => entry.id === opening.wallId)!, dx = wall.end[0] - wall.start[0], dz = wall.end[1] - wall.start[1];
    const length = Math.hypot(dx, dz), middle = opening.offset + opening.width / 2;
    requireMatrix(entities.get(opening.id)!, [wall.start[0] + dx * middle / length, opening.sillHeight + opening.height / 2,
      wall.start[1] + dz * middle / length], -Math.atan2(dz, dx), [opening.width / 2, opening.height / 2, wall.thickness / 2]);
  }
  for (const item of plan.items) {
    if (!item.dimensions) fail("furniture dimensions are required.");
    const node = entities.get(item.id)!; requireMatrix(node, [...item.position], item.rotationY);
    const bounds = localBounds(node), [width, height, depth] = item.dimensions;
    if (![near(bounds.min.x, -width / 2), near(bounds.max.x, width / 2), near(bounds.min.y, 0), near(bounds.max.y, height), near(bounds.min.z, -depth / 2), near(bounds.max.z, depth / 2)].every(Boolean)) fail("model furniture extents do not match the room file.");
  }
  const shell = new THREE.Group(), furniture = new Map<string, THREE.Group>();
  const walls = new Map<string, THREE.Mesh[]>();
  for (const entry of [...plan.geometry.rooms, ...plan.geometry.walls]) {
    const node = entities.get(entry.id)!; shell.attach(node);
    const meshes: THREE.Mesh[] = [];
    node.traverse((child) => { if (child instanceof THREE.Mesh) { child.castShadow = child.userData.role !== "room_floor"; child.receiveShadow = true; meshes.push(child); } });
    walls.set(entry.id, meshes);
  }
  for (const item of plan.items) {
    const root = new THREE.Group(); root.userData.workspaceItemId = item.id;
    root.userData.photoTextureCoverage = entities.get(item.id)!.userData.photoTextureCoverage ?? 0;
    root.position.fromArray(item.position); root.rotation.y = item.rotationY; root.updateMatrixWorld(true);
    root.attach(entities.get(item.id)!);
    root.traverse((child) => { if (child instanceof THREE.Mesh) { child.castShadow = true; child.receiveShadow = true; } });
    furniture.set(item.id, root);
  }
  return { shell, furniture, walls, projectedEntities: projected };
}
