import * as THREE from "three";
import type { bindTexturedRoom } from "./textured-model";

/** Validate against the immutable source, then preserve a local template per stable ID.
 * Entry roots own the editable pose; retaining the captured pose here would apply it twice. */
export function prepareWalkSource(bound: ReturnType<typeof bindTexturedRoom>) {
  const templates = new Map<string, THREE.Object3D>();
  for (const [id, object] of bound.furniture) {
    object.removeFromParent();
    object.position.set(0, 0, 0);
    object.quaternion.identity();
    object.scale.set(1, 1, 1);
    object.updateMatrixWorld(true);
    templates.set(id, object);
  }
  return { ...bound, templates };
}
