import type { Material } from "three";

type Base = Pick<Material, "opacity" | "transparent" | "depthWrite">;
const baseMaterials = new WeakMap<Material, Base>();

/** Cutaway is a multiplier over the captured finish, never a replacement for glass opacity. */
export function applyWalkCutaway(material: Material, near: boolean): void {
  let base = baseMaterials.get(material);
  if (!base) {
    base = { opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite };
    baseMaterials.set(material, base);
  }
  const transparent = near || base.transparent;
  if (material.transparent !== transparent) {
    material.transparent = transparent;
    material.needsUpdate = true;
  }
  material.opacity = base.opacity * (near ? .075 : 1);
  material.depthWrite = !near && base.depthWrite;
}
