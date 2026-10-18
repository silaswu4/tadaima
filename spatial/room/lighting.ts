import * as THREE from "three";
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
) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const coordinates = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const nx = Math.abs(normal.getX(i)), ny = Math.abs(normal.getY(i));
    const horizontal = ny > .5;
    coordinates[i * 2] = (horizontal ? x : nx > .5 ? z : x) / tileMeters;
    coordinates[i * 2 + 1] = (horizontal ? z : y) / tileMeters;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(coordinates, 2));
}

/** One PMREM per workspace; merchant materials retain their own PBR maps. */
export function createRoomLighting(renderer: THREE.WebGLRenderer, scene: THREE.Scene, lite = false) {
  let disposed = false;
  const walls: THREE.MeshStandardMaterial[] = [];
  const floor = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1, metalness: 0 });
  floor.normalScale.set(.45, .45);
  const wall = new THREE.MeshStandardMaterial({ color: "#eee9df", roughness: .9, metalness: 0 });
  wall.normalScale.set(.1, .1);
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
    map(ASSETS.floorColor, true).then((texture) => { if (texture) { floor.map = texture; floor.needsUpdate = true; } }),
    map(ASSETS.floorRoughness).then((texture) => { if (texture) { floor.roughnessMap = texture; floor.needsUpdate = true; } }),
    map(ASSETS.floorNormal).then((texture) => { if (texture) { floor.normalMap = texture; floor.needsUpdate = true; } }),
    map(ASSETS.wallNormal).then((texture) => {
      if (!texture) return;
      wall.normalMap = texture;
      for (const material of walls) { material.normalMap = texture; material.needsUpdate = true; }
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
    floor,
    ready,
    makeWall() { const material = wall.clone(); walls.push(material); return material; },
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.environment = null;
      environment.dispose();
      pmrem.dispose();
      // Attached texture maps are disposed by the workspace's scene traversal.
      wall.dispose();
    },
  };
}
