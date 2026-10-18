import * as THREE from "three";
import type { PlacedItem, Vector3Meters } from "../../backend/contracts";

/** A scan bounding box describes extent, not the object's recovered shape. */
export function createFurnitureProxy(dimensions: Vector3Meters): THREE.Mesh {
  const [width, height, depth] = dimensions;
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.translate(0, height / 2, 0);
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#b8b09e", roughness: .85 }));
}

/** Canonical item positions are bottom-center; dimensions stay in local axes. */
export function placeFurnitureModel(item: Pick<PlacedItem, "id" | "position" | "rotationY">, model: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(model, true);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).toArray() as [number, number, number];
  model.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
  const root = new THREE.Group();
  root.userData.workspaceItemId = item.id;
  root.add(model);
  root.position.fromArray(item.position);
  root.rotation.y = item.rotationY;
  return { root, size };
}
