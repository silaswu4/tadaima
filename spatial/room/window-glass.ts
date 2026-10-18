import * as THREE from "three";

const prepared = new WeakSet<THREE.Mesh>();

function hasOpeningOwner(mesh: THREE.Mesh): boolean {
  const owner = mesh.userData.ownerOpeningId;
  if (typeof owner !== "string" || !owner.trim()) return false;
  for (let ancestor = mesh.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.userData.entityId === owner && ancestor.userData.role === "opening") return true;
  }
  return false;
}

/** Clear window panes use inexpensive alpha PBR, without the room's opaque
 * diffuse bake or a transmission render pass. Blinds and frames stay solid.
 * Materials are owned per pane; textures remain shared and are never disposed here. */
export function prepareWindowGlass(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || node.userData.componentKind !== "WindowGlass" || !hasOpeningOwner(node)) return;
    const originals = Array.isArray(node.material) ? node.material : [node.material];
    if (!originals.every((material) => material instanceof THREE.MeshStandardMaterial)) return;
    count++;
    // The semantic binder may restore generic shadow flags after preparation.
    // Repeated calls restore pane flags while retaining the same cloned material.
    node.castShadow = false;
    node.receiveShadow = false;
    if (prepared.has(node)) return;
    const clear = (source: THREE.MeshStandardMaterial) => {
      const material = source.clone();
      if (["cycles-diffuse-indirect-v1", "cycles-diffuse-full-v1"].includes(material.userData.tadaimaIndirectLightmap)) {
        delete material.userData.tadaimaIndirectLightmap;
        delete material.userData.tadaimaIndirectScale;
        delete material.userData.tadaimaIndirectAo;
        material.emissiveMap = null;
      }
      material.lightMap = null;
      material.lightMapIntensity = 0;
      material.emissive.set(0);
      material.color.set("#ffffff");
      material.opacity = .025;
      material.transparent = true;
      material.roughness = .05;
      material.metalness = 0;
      material.depthWrite = false;
      material.side = THREE.DoubleSide;
      material.forceSinglePass = true;
      material.envMapIntensity = 1;
      if (material instanceof THREE.MeshPhysicalMaterial) material.transmission = 0;
      material.needsUpdate = true;
      return material;
    };
    node.material = Array.isArray(node.material)
      ? (node.material as THREE.MeshStandardMaterial[]).map(clear)
      : clear(node.material as THREE.MeshStandardMaterial);
    prepared.add(node);
  });
  return count;
}

/** Presentation only: roll the detected fabric into its retained header. Never
 * change measured openings, furniture state, materials or the source model. */
export function createWindowBlinds(root: THREE.Object3D) {
  const blinds: { mesh: THREE.Mesh; visible: boolean }[] = [];
  root.traverse((node) => {
    if (node instanceof THREE.Mesh && node.userData.componentKind === "PartialRollerBlind" && hasOpeningOwner(node)) {
      blinds.push({ mesh: node, visible: node.visible });
    }
  });
  return {
    count: blinds.length,
    setRaised(raised: boolean) {
      for (const { mesh, visible } of blinds) mesh.visible = raised ? false : visible;
    },
  };
}

/** Neutral preview sky, not a captured exterior. Tiny and shared by both eyes;
 * no refraction, downloads, postprocessing or additional scene geometry. */
export function createWindowDaylightBackground(): THREE.DataTexture {
  const width = 512, height = 256;
  const data = new Uint8Array(width * height * 4);
  const horizon = new THREE.Color("#b7d3e7"), zenith = new THREE.Color("#247cb9"), ground = new THREE.Color("#b4b9b3"), white = new THREE.Color("#fbfcfd");
  const color = new THREE.Color(), base = new THREE.Color();
  // A few soft clouds give the transparent pane a legible backdrop. These are
  // synthetic, direction-independent presentation scenery, not photo evidence.
  const clouds = Array.from({ length: 12 }, (_, i) => ({ u: i / 12, v: .52 + .006 * Math.sin(i * 2.4) }));
  for (let y = 0; y < height; y++) {
    const elevation = y / (height - 1) - .5;
    base.lerpColors(horizon, elevation >= 0 ? zenith : ground, Math.min(1, Math.abs(elevation) * (elevation >= 0 ? 10 : 6)));
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1), v = y / (height - 1);
      let density = 0;
      if (elevation > 0) for (const cloud of clouds) {
        const distance = Math.abs(u - cloud.u), dx = Math.min(distance, 1 - distance);
        const dy = v - cloud.v - .003 * Math.cos(u * Math.PI * 48);
        density = Math.max(density, Math.exp(-2 * ((dx / .035) ** 2 + (dy / .007) ** 2)));
      }
      color.copy(base).lerp(white, THREE.MathUtils.smoothstep(density, .15, .8) * .85);
      const rgb = color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
      const offset = (y * width + x) * 4;
      data[offset] = Math.round(rgb.r * 255);
      data[offset + 1] = Math.round(rgb.g * 255);
      data[offset + 2] = Math.round(rgb.b * 255);
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.name = "Neutral daylight preview (exterior not captured)";
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
