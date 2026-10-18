import * as THREE from "three";
import type { RoomAppearance } from "../../backend/contracts";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

/** Local, portable PBR inputs; keep these paths in sync with the asset manifest. */
const ASSETS = {
  floorColor: "/materials/room/oak-basecolor.jpg",
  floorRoughness: "/materials/room/oak-roughness.jpg",
  floorNormal: "/materials/room/oak-normal.jpg",
  wallNormal: "/materials/room/plaster-normal.jpg",
  environment: "/materials/room/studio-small-09-1k.hdr",
};

/** UVs are in physical tile units, so another room size does not stretch grain. */
export function setMetricSurfaceUVs(
  geometry: THREE.BufferGeometry,
  tileMeters: number,
  rotationDegrees = 0,
  offset: [number, number] = [0, 0],
) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const coordinates = new Float32Array(position.count * 2);
  const angle = rotationDegrees * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const nx = Math.abs(normal.getX(i)), ny = Math.abs(normal.getY(i));
    const horizontal = ny > .5;
    const u = ((horizontal ? x : nx > .5 ? z : x) + offset[0]) / tileMeters;
    const v = ((horizontal ? z : y) + offset[1]) / tileMeters;
    coordinates[i * 2] = u * cosine - v * sine;
    coordinates[i * 2 + 1] = u * sine + v * cosine;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(coordinates, 2));
}

/** One PMREM per workspace; merchant materials retain their own PBR maps. */
export function createRoomLighting(renderer: THREE.WebGLRenderer, scene: THREE.Scene, lite = false) {
  let disposed = false;
  const materials: { material: THREE.MeshStandardMaterial; finish: string }[] = [];
  const textures: Record<string, THREE.Texture> = {};
  function applyMaps(material: THREE.MeshStandardMaterial, finish: string) {
    if (finish === "wood") {
      material.map = textures.floorColor ?? null;
      material.roughnessMap = textures.floorRoughness ?? null;
      material.normalMap = textures.floorNormal ?? null;
      material.normalScale.set(.45, .45);
    } else {
      material.normalMap = textures.wallNormal ?? null;
      const strength = finish === "carpet" ? .16 : finish === "tile" ? .035 : .08;
      material.normalScale.set(strength, strength);
    }
    material.needsUpdate = true;
  }
  function makeSurface(kind: "floor" | "wall", appearance?: RoomAppearance["surfaces"][number]) {
    const finish = appearance?.finish ?? (kind === "floor" ? "wood" : "paint");
    const material = new THREE.MeshStandardMaterial({
      color: appearance?.color ?? (kind === "floor" ? "#ffffff" : "#eee9df"),
      roughness: appearance?.roughness ?? (kind === "floor" ? 1 : .9), metalness: 0,
    });
    materials.push({ material, finish });
    applyMaps(material, finish);
    return material;
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const fallback = new RoomEnvironment();
  let environment = pmrem.fromScene(fallback, .04);
  fallback.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = .7;
  const loader = new THREE.TextureLoader();
  const anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), lite ? 2 : 4);

  async function map(url: string, color = false) {
    const texture = await loader.loadAsync(url);
    if (disposed) { texture.dispose(); return null; }
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = anisotropy;
    return texture;
  }

  // Missing appearance assets degrade to plain PBR rather than hiding furniture.
  const ready = Promise.allSettled([
    ...(["floorColor", "floorRoughness", "floorNormal", "wallNormal"] as const).map(async (key) => {
      const texture = await map(ASSETS[key], key === "floorColor");
      if (!texture) return;
      textures[key] = texture;
      for (const { material, finish } of materials) applyMaps(material, finish);
    }),
    new HDRLoader().loadAsync(ASSETS.environment).then((texture) => {
      if (disposed) { texture.dispose(); return; }
      try {
        const next = pmrem.fromEquirectangular(texture);
        scene.environment = next.texture;
        environment.dispose();
        environment = next;
      } finally { texture.dispose(); }
    }),
  ]).then(() => { pmrem.dispose(); });

  return {
    ready,
    makeSurface,
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.environment = null;
      environment.dispose();
      pmrem.dispose();
      // Some maps are intentionally unused by a non-wood photo palette.
      for (const texture of Object.values(textures)) texture.dispose();
    },
  };
}
