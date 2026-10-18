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
      material.color.set("#e4f0f3");
      material.opacity = .1;
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
