import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { Vector3Meters } from "@/backend/contracts";

// measures what a GLB costs to bring into the viewer and whether its scale is
// plausible. the numbers come from this browser on this device; they are not a
// Quest measurement unless they were taken in the Quest browser.

export interface AssetBenchmark {
  url: string;
  ok: boolean;
  error: string | null;
  bytes: number | null;
  fetchMs: number | null;
  parseMs: number | null;
  meshes: number;
  triangles: number;
  materials: number;
  textures: number;
  /** Largest texture edge in pixels. */
  maxTexture: number;
  /** Bounds of the model as authored, meters (w, h, d), before any recentring. */
  bounds: Vector3Meters | null;
  /** Bounds divided by the expected size per axis, when an expected size is given. */
  ratio: Vector3Meters | null;
  scale: ScaleVerdict;
}

export type ScaleVerdict =
  | "matches" // every axis within 10 percent of the expected size
  | "differs" // off by more than 10 percent but not a unit error
  | "unit_error_likely" // about 100x or 1000x off, typical of centimeter or millimeter exports
  | "implausible" // no expected size, but bounds are outside 2 cm to 12 m
  | "unchecked"; // no expected size, bounds look like furniture or a room

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

export function judgeScale(bounds: Vector3Meters, expected: Vector3Meters | null): { ratio: Vector3Meters | null; scale: ScaleVerdict } {
  if (!expected) {
    const big = Math.max(...bounds);
    return { ratio: null, scale: big < 0.02 || big > 12 ? "implausible" : "unchecked" };
  }
  const ratio = bounds.map((b, i) => b / expected[i]) as unknown as Vector3Meters;
  if (ratio.every((r) => r > 0.9 && r < 1.1)) return { ratio, scale: "matches" };
  const typical = ratio.reduce((a, b) => a * b, 1) ** (1 / 3);
  const near = (target: number) => typical > target * 0.7 && typical < target * 1.4;
  if (near(100) || near(1000) || near(0.01) || near(0.001)) return { ratio, scale: "unit_error_likely" };
  return { ratio, scale: "differs" };
}

export async function benchmarkAsset(url: string, expected: Vector3Meters | null = null): Promise<AssetBenchmark> {
  const result: AssetBenchmark = {
    url,
    ok: false,
    error: null,
    bytes: null,
    fetchMs: null,
    parseMs: null,
    meshes: 0,
    triangles: 0,
    materials: 0,
    textures: 0,
    maxTexture: 0,
    bounds: null,
    ratio: null,
    scale: "unchecked",
  };
  try {
    const t0 = performance.now();
    // no-store so a cached copy does not make the fetch look free
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    result.fetchMs = performance.now() - t0;
    result.bytes = buffer.byteLength;

    const base = url.slice(0, url.lastIndexOf("/") + 1);
    const t1 = performance.now();
    const gltf = await loader.parseAsync(buffer, base);
    result.parseMs = performance.now() - t1;

    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    gltf.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      result.meshes++;
      const geo = o.geometry as THREE.BufferGeometry;
      const count = geo.index ? geo.index.count : geo.attributes.position.count;
      result.triangles += Math.floor(count / 3);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        materials.add(m);
        for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
      }
    });
    result.materials = materials.size;
    result.textures = textures.size;
    for (const t of textures) {
      const image = t.image as { width?: number; height?: number } | undefined;
      result.maxTexture = Math.max(result.maxTexture, image?.width ?? 0, image?.height ?? 0);
    }

    const size = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
    result.bounds = [size.x, size.y, size.z];
    Object.assign(result, judgeScale(result.bounds, expected));
    result.ok = true;

    gltf.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/** Runs one at a time so the timings do not compete for the network or the main thread. */
export async function benchmarkAssets(entries: Array<{ url: string; expected: Vector3Meters | null }>) {
  const out: AssetBenchmark[] = [];
  for (const entry of entries) out.push(await benchmarkAsset(entry.url, entry.expected));
  return out;
}
