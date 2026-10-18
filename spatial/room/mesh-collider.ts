// Shape-accurate colliders for furniture: the solid parts of a fitted model as a few boxes.
// The model's real triangles are voxelized (so thin legs and pedestals register), the
// closed interior is filled, and the occupied voxels are merged into at most ~24 boxes
// in the piece's own frame. backend/plan/rules.ts collides() reads them as PlacedItem.collision.
import * as THREE from "three";
import type { CollisionBox } from "../../backend/contracts";

export type ColliderOptions = {
  /** Voxel edge in meters. Defaults to 3 to 5 cm depending on the piece's size. */
  cell?: number;
  /** Upper bound on boxes returned. */
  maxBoxes?: number;
  /** While under the cap, two boxes still merge when the union wastes at most this share of its volume. */
  slack?: number;
};

const MAX_SAMPLES = 4_000_000;

/** Voxel edge for a piece of this size: 3 cm for small things, up to 5 cm for big ones. */
export function colliderCell(maxExtent: number) {
  return THREE.MathUtils.clamp(maxExtent / 40, 0.03, 0.05);
}

type Grid = {
  nx: number; ny: number; nz: number; cell: number; min: THREE.Vector3;
  /** 1 where a triangle passes, 2 where enclosed (filled), 0 empty. Unpadded. */
  solid: Uint8Array;
  /** Tight bounds of the triangle samples in each surface voxel: minX,minY,minZ,maxX,maxY,maxZ. */
  tight: Float32Array;
};

/** Every triangle of every visible mesh under `root`, in root's frame, flat 9 numbers per triangle. */
function collectTriangles(root: THREE.Object3D): Float32Array {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const instance = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const chunks: Float32Array[] = [];
  let total = 0;
  const visible = (node: THREE.Object3D) => {
    for (let n: THREE.Object3D | null = node; n && n !== root.parent; n = n.parent) if (!n.visible) return false;
    return true;
  };
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || node.userData.silhouette || !visible(mesh)) return;
    const position = mesh.geometry?.getAttribute("position");
    if (!position) return;
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : position.count;
    const triangles = Math.floor(count / 3);
    if (!triangles) return;
    local.multiplyMatrices(toRoot, mesh.matrixWorld);
    const instanced = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh) : null;
    const copies = instanced ? instanced.count : 1;
    const out = new Float32Array(triangles * 9 * copies);
    let o = 0;
    for (let c = 0; c < copies; c++) {
      const matrix = instanced ? instance.multiplyMatrices(local, (instanced.getMatrixAt(c, instance), instance)) : local;
      for (let t = 0; t < triangles * 3; t++) {
        v.fromBufferAttribute(position, index ? index.getX(t) : t).applyMatrix4(matrix);
        out[o++] = v.x; out[o++] = v.y; out[o++] = v.z;
      }
    }
    chunks.push(out);
    total += out.length;
  });
  const all = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; }
  return all;
}

function voxelize(tris: Float32Array, cellOverride?: number): Grid | null {
  if (!tris.length) return null;
  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (!Number.isFinite(x + y + z)) continue;
    if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
    if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
  }
  if (!Number.isFinite(min.x)) return null;
  const size = max.clone().sub(min);
  let cell = cellOverride ?? colliderCell(Math.max(size.x, size.y, size.z));
  // keep the grid bounded for huge or degenerate inputs
  while ((size.x / cell + 1) * (size.y / cell + 1) * (size.z / cell + 1) > 600_000) cell *= 1.25;
  const nx = Math.max(1, Math.ceil(size.x / cell - 1e-6)), ny = Math.max(1, Math.ceil(size.y / cell - 1e-6)), nz = Math.max(1, Math.ceil(size.z / cell - 1e-6));
  const solid = new Uint8Array(nx * ny * nz);
  const tight = new Float32Array(nx * ny * nz * 6);
  const at = (x: number, y: number, z: number) => (y * nz + z) * nx + x;
  const clampI = (value: number, n: number) => (value < 0 ? 0 : value >= n ? n - 1 : value);
  const mark = (x: number, y: number, z: number) => {
    const ix = clampI(Math.floor((x - min.x) / cell), nx), iy = clampI(Math.floor((y - min.y) / cell), ny), iz = clampI(Math.floor((z - min.z) / cell), nz);
    const k = at(ix, iy, iz), b = k * 6;
    if (!solid[k]) {
      solid[k] = 1;
      tight[b] = x; tight[b + 1] = y; tight[b + 2] = z; tight[b + 3] = x; tight[b + 4] = y; tight[b + 5] = z;
      return;
    }
    if (x < tight[b]) tight[b] = x; if (y < tight[b + 1]) tight[b + 1] = y; if (z < tight[b + 2]) tight[b + 2] = z;
    if (x > tight[b + 3]) tight[b + 3] = x; if (y > tight[b + 4]) tight[b + 4] = y; if (z > tight[b + 5]) tight[b + 5] = z;
  };
  // Sample every triangle at under half a voxel so nothing thin slips between samples.
  const step = cell * 0.45;
  let budget = MAX_SAMPLES;
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const ux = tris[i + 3] - ax, uy = tris[i + 4] - ay, uz = tris[i + 5] - az;
    const wx = tris[i + 6] - ax, wy = tris[i + 7] - ay, wz = tris[i + 8] - az;
    if (!Number.isFinite(ax + ay + az + ux + uy + uz + wx + wy + wz)) continue;
    const longest = Math.max(Math.hypot(ux, uy, uz), Math.hypot(wx, wy, wz), Math.hypot(wx - ux, wy - uy, wz - uz));
    const n = Math.max(1, Math.min(400, Math.ceil(longest / step)));
    if (n === 1) {
      mark(ax, ay, az); mark(ax + ux, ay + uy, az + uz); mark(ax + wx, ay + wy, az + wz);
      mark(ax + (ux + wx) / 3, ay + (uy + wy) / 3, az + (uz + wz) / 3);
      continue;
    }
    budget -= (n + 1) * (n + 2) / 2;
    if (budget < 0) break;
    for (let a = 0; a <= n; a++) {
      const s = a / n;
      for (let b = 0; b <= n - a; b++) {
        const t = b / n;
        mark(ax + ux * s + wx * t, ay + uy * s + wy * t, az + uz * s + wz * t);
      }
    }
  }
  fillEnclosed(solid, nx, ny, nz);
  return { nx, ny, nz, cell, min, solid, tight };
}

/** Marks voxels no outside path reaches (6-connected) as solid interior. */
function fillEnclosed(solid: Uint8Array, nx: number, ny: number, nz: number) {
  const outside = new Uint8Array(solid.length);
  const stack = new Int32Array(solid.length);
  let top = 0;
  const at = (x: number, y: number, z: number) => (y * nz + z) * nx + x;
  const seed = (k: number) => { if (!solid[k] && !outside[k]) { outside[k] = 1; stack[top++] = k; } };
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) seed(at(x, y, z));
  }
  while (top) {
    const k = stack[--top];
    const x = k % nx, z = Math.floor(k / nx) % nz, y = Math.floor(k / (nx * nz));
    if (x > 0) seed(k - 1); if (x < nx - 1) seed(k + 1);
    if (z > 0) seed(k - nx); if (z < nz - 1) seed(k + nx);
    if (y > 0) seed(k - nx * nz); if (y < ny - 1) seed(k + nx * nz);
  }
  for (let k = 0; k < solid.length; k++) if (!solid[k] && !outside[k]) solid[k] = 2;
}

/** Integer voxel box, max exclusive. */
type IBox = { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; alive: boolean };
const volume = (b: Pick<IBox, "x0" | "y0" | "z0" | "x1" | "y1" | "z1">) => (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0);

/** Greedy 3D runs: the fewest axis boxes that exactly cover the occupied voxels, without overlap. */
function greedyBoxes(grid: Grid): IBox[] {
  const { nx, ny, nz, solid } = grid;
  const used = new Uint8Array(solid.length);
  const at = (x: number, y: number, z: number) => (y * nz + z) * nx + x;
  const free = (x: number, y: number, z: number) => solid[at(x, y, z)] !== 0 && !used[at(x, y, z)];
  const boxes: IBox[] = [];
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    if (!free(x, y, z)) continue;
    let x1 = x + 1;
    while (x1 < nx && free(x1, y, z)) x1++;
    let z1 = z + 1;
    rows: while (z1 < nz) { for (let i = x; i < x1; i++) if (!free(i, y, z1)) break rows; z1++; }
    let y1 = y + 1;
    slabs: while (y1 < ny) { for (let k = z; k < z1; k++) for (let i = x; i < x1; i++) if (!free(i, y1, k)) break slabs; y1++; }
    for (let j = y; j < y1; j++) for (let k = z; k < z1; k++) for (let i = x; i < x1; i++) used[at(i, j, k)] = 1;
    boxes.push({ x0: x, y0: y, z0: z, x1, y1, z1, alive: true });
  }
  return boxes;
}

/** Summed-volume table: occupied voxel count of any box in O(1). */
function occupancy(grid: Grid) {
  const { nx, ny, nz, solid } = grid;
  const sx = nx + 1, sz = nz + 1;
  const table = new Int32Array((nx + 1) * (ny + 1) * (nz + 1));
  const idx = (x: number, y: number, z: number) => (y * sz + z) * sx + x;
  for (let y = 1; y <= ny; y++) for (let z = 1; z <= nz; z++) for (let x = 1; x <= nx; x++) {
    const v = solid[((y - 1) * nz + (z - 1)) * nx + (x - 1)] ? 1 : 0;
    table[idx(x, y, z)] = v
      + table[idx(x - 1, y, z)] + table[idx(x, y - 1, z)] + table[idx(x, y, z - 1)]
      - table[idx(x - 1, y - 1, z)] - table[idx(x - 1, y, z - 1)] - table[idx(x, y - 1, z - 1)]
      + table[idx(x - 1, y - 1, z - 1)];
  }
  return (b: Pick<IBox, "x0" | "y0" | "z0" | "x1" | "y1" | "z1">) =>
    table[idx(b.x1, b.y1, b.z1)] - table[idx(b.x0, b.y1, b.z1)] - table[idx(b.x1, b.y0, b.z1)] - table[idx(b.x1, b.y1, b.z0)]
    + table[idx(b.x0, b.y0, b.z1)] + table[idx(b.x0, b.y1, b.z0)] + table[idx(b.x1, b.y0, b.z0)] - table[idx(b.x0, b.y0, b.z0)];
}

type Candidate = { waste: number; a: number; b: number };

/** Tiny binary min-heap on waste. */
class Heap {
  items: Candidate[] = [];
  get size() { return this.items.length; }
  push(c: Candidate) {
    const h = this.items;
    h.push(c);
    let i = h.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (h[p].waste <= h[i].waste) break; [h[p], h[i]] = [h[i], h[p]]; i = p; }
  }
  pop(): Candidate | undefined {
    const h = this.items;
    if (!h.length) return undefined;
    const top = h[0], last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && h[l].waste < h[m].waste) m = l;
        if (r < h.length && h[r].waste < h[m].waste) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]]; i = m;
      }
    }
    return top;
  }
}

/**
 * Merge boxes, cheapest first (fewest empty voxels swallowed), until at most `maxBoxes`
 * remain; under the cap, keep merging only near-free unions. Nothing is ever dropped:
 * a merge only grows a box, so every occupied voxel stays covered.
 */
function mergeBoxes(boxes: IBox[], occupied: (b: IBox) => number, maxBoxes: number, slack: number): IBox[] {
  const union = (a: IBox, b: IBox): IBox => ({
    x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), z0: Math.min(a.z0, b.z0),
    x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), z1: Math.max(a.z1, b.z1), alive: true,
  });
  const touching = (a: IBox, b: IBox) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1 && a.z0 <= b.z1 && b.z0 <= a.z1;
  const contains = (a: IBox, b: IBox) => a.x0 <= b.x0 && a.y0 <= b.y0 && a.z0 <= b.z0 && a.x1 >= b.x1 && a.y1 >= b.y1 && a.z1 >= b.z1;
  const heap = new Heap();
  const offer = (i: number, j: number) => {
    const u = union(boxes[i], boxes[j]);
    heap.push({ waste: volume(u) - occupied(u), a: i, b: j });
  };
  let alive = boxes.length;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (touching(boxes[i], boxes[j])) offer(i, j);
  let everyPair = false;
  for (;;) {
    let next = heap.pop();
    if (!next && alive > maxBoxes && !everyPair) {
      // separate parts (four loose legs, say) only merge once the cap demands it
      everyPair = true;
      const live = boxes.flatMap((b, i) => (b.alive ? [i] : []));
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) offer(live[i], live[j]);
      next = heap.pop();
    }
    if (!next) break;
    const a = boxes[next.a], b = boxes[next.b];
    if (!a.alive || !b.alive) continue;
    const u = union(a, b);
    if (alive <= maxBoxes && next.waste > slack * volume(u)) continue;
    a.alive = false; b.alive = false;
    const k = boxes.length;
    boxes.push(u);
    alive -= 1;
    for (let i = 0; i < k; i++) {
      const other = boxes[i];
      if (!other.alive) continue;
      if (contains(u, other)) { other.alive = false; alive -= 1; continue; }
      if (everyPair || touching(u, other)) offer(k, i);
    }
  }
  return boxes.filter((b) => b.alive);
}

/** Shrink a voxel box to the triangle samples inside it (filled-only boxes keep their voxel bounds). */
function tighten(grid: Grid, b: IBox): [number, number, number, number, number, number] {
  const { nx, nz, cell, min, solid, tight } = grid;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let y = b.y0; y < b.y1; y++) for (let z = b.z0; z < b.z1; z++) for (let x = b.x0; x < b.x1; x++) {
    const k = (y * nz + z) * nx + x;
    if (solid[k] === 0) continue;
    if (solid[k] === 1) {
      const t = k * 6;
      if (tight[t] < x0) x0 = tight[t]; if (tight[t + 1] < y0) y0 = tight[t + 1]; if (tight[t + 2] < z0) z0 = tight[t + 2];
      if (tight[t + 3] > x1) x1 = tight[t + 3]; if (tight[t + 4] > y1) y1 = tight[t + 4]; if (tight[t + 5] > z1) z1 = tight[t + 5];
    } else {
      const vx = min.x + x * cell, vy = min.y + y * cell, vz = min.z + z * cell;
      if (vx < x0) x0 = vx; if (vy < y0) y0 = vy; if (vz < z0) z0 = vz;
      if (vx + cell > x1) x1 = vx + cell; if (vy + cell > y1) y1 = vy + cell; if (vz + cell > z1) z1 = vz + cell;
    }
  }
  return [x0, y0, z0, x1, y1, z1];
}

const mm = (value: number) => Math.round(value * 1000) / 1000;
const MIN_PART = 0.01;

/**
 * Solid parts of `root` (a fitted furniture model, base-centered on the floor at the origin,
 * front +Z, width on X) as CollisionBox[] in root's own frame: [cx, cy, cz, w, h, d], meters,
 * cy measured up from the floor. Empty when there is no geometry.
 */
export function meshColliders(root: THREE.Object3D, options: ColliderOptions = {}): CollisionBox[] {
  const grid = voxelize(collectTriangles(root), options.cell);
  if (!grid) return [];
  const boxes = mergeBoxes(greedyBoxes(grid), occupancy(grid), options.maxBoxes ?? 24, options.slack ?? 0.04);
  const floor = 0;
  return boxes
    .map((b) => {
      const [x0, y0raw, z0, x1, y1, z1] = tighten(grid, b);
      const y0 = Math.max(floor, y0raw);
      const w = Math.max(MIN_PART, x1 - x0), h = Math.max(MIN_PART, y1 - y0), d = Math.max(MIN_PART, z1 - z0);
      return [mm((x0 + x1) / 2), mm(y0 + h / 2), mm((z0 + z1) / 2), mm(w), mm(h), mm(d)] as CollisionBox;
    })
    .sort((p, q) => p[1] - p[4] / 2 - (q[1] - q[4] / 2) || p[0] - q[0] || p[2] - q[2]);
}

const shared = new Map<string, CollisionBox[]>();

/** meshColliders, cached by a key that names the model and its fitted size (url + dimensions). */
export function cachedMeshColliders(key: string, root: THREE.Object3D, options?: ColliderOptions): CollisionBox[] {
  let found = shared.get(key);
  if (!found) {
    found = meshColliders(root, options);
    if (shared.size > 256) shared.delete(shared.keys().next().value!);
    shared.set(key, found);
  }
  return found.map((box) => [...box] as CollisionBox);
}
