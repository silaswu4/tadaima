import * as THREE from "three";

type ShadowMap = { autoUpdate: boolean; needsUpdate: boolean };
type Attribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
type Snapshot = {
  matrix: Float64Array;
  generation: number;
  geometry: THREE.BufferGeometry;
  position: Attribute;
  positionVersion: number;
  positionCount: number;
  index: THREE.BufferAttribute | null;
  indexVersion: number;
  indexCount: number;
  drawStart: number;
  drawCount: number;
  instanceVersion: number;
  instanceCount: number;
};

function attributeVersion(attribute: Attribute): number {
  return attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data.version : attribute?.version ?? -1;
}

/** Cache one shared shadow pass until a visible caster changes. Call immediately
 * before rendering; changes to the light/frustum itself require invalidate().
 * Static room meshes use one reusable matrix snapshot each, with no per-frame
 * matrix clones or serialized scene signatures. */
export function createShadowCache(shadowMap: ShadowMap, root: THREE.Object3D) {
  const previousAutoUpdate = shadowMap.autoUpdate;
  const snapshots = new Map<THREE.Mesh, Snapshot>();
  let generation = 0;
  let dirty = true;
  let changed = false;
  let disposed = false;
  shadowMap.autoUpdate = false;

  const visit = (node: THREE.Object3D) => {
    if (!(node instanceof THREE.Mesh) || !node.castShadow) return;
    const material = node.material;
    if (Array.isArray(material) ? !material.some((entry) => entry.visible) : !material.visible) return;
    const geometry = node.geometry;
    const position = geometry.getAttribute("position");
    const positionVersion = attributeVersion(position);
    const index = geometry.index;
    const instance = node instanceof THREE.InstancedMesh ? node : null;
    let snapshot = snapshots.get(node);
    if (!snapshot) {
      snapshot = {
        matrix: new Float64Array(16), generation, geometry,
        position, positionVersion, positionCount: position?.count ?? 0,
        index, indexVersion: index?.version ?? -1, indexCount: index?.count ?? 0,
        drawStart: geometry.drawRange.start, drawCount: geometry.drawRange.count,
        instanceVersion: instance?.instanceMatrix.version ?? -1, instanceCount: instance?.count ?? 0,
      };
      snapshots.set(node, snapshot);
      changed = true;
    } else {
      if (snapshot.geometry !== geometry || snapshot.position !== position || snapshot.positionVersion !== positionVersion
        || snapshot.positionCount !== (position?.count ?? 0) || snapshot.index !== index
        || snapshot.indexVersion !== (index?.version ?? -1) || snapshot.indexCount !== (index?.count ?? 0)
        || snapshot.drawStart !== geometry.drawRange.start || snapshot.drawCount !== geometry.drawRange.count
        || snapshot.instanceVersion !== (instance?.instanceMatrix.version ?? -1) || snapshot.instanceCount !== (instance?.count ?? 0)) changed = true;
      snapshot.geometry = geometry;
      snapshot.position = position;
      snapshot.positionVersion = positionVersion;
      snapshot.positionCount = position?.count ?? 0;
      snapshot.index = index;
      snapshot.indexVersion = index?.version ?? -1;
      snapshot.indexCount = index?.count ?? 0;
      snapshot.drawStart = geometry.drawRange.start;
      snapshot.drawCount = geometry.drawRange.count;
      snapshot.instanceVersion = instance?.instanceMatrix.version ?? -1;
      snapshot.instanceCount = instance?.count ?? 0;
      snapshot.generation = generation;
    }
    const matrix = node.matrixWorld.elements;
    for (let i = 0; i < 16; i++) {
      if (snapshot.matrix[i] !== matrix[i]) changed = true;
      snapshot.matrix[i] = matrix[i];
    }
  };

  return {
    /** True when this call requests a new shadow render, including an empty
     * pass after the final caster disappears to clear its old shadow. */
    update(): boolean {
      if (disposed) return false;
      generation++;
      changed = dirty;
      root.updateWorldMatrix(true, true);
      // traverseVisible excludes children of hidden ancestors as well.
      root.traverseVisible(visit);
      for (const [mesh, snapshot] of snapshots) {
        if (snapshot.generation !== generation) { snapshots.delete(mesh); changed = true; }
      }
      if (changed) shadowMap.needsUpdate = true;
      dirty = false;
      return changed;
    },
    invalidate(): void {
      if (disposed) return;
      dirty = true;
      shadowMap.needsUpdate = true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      snapshots.clear();
      shadowMap.autoUpdate = previousAutoUpdate;
      shadowMap.needsUpdate = true;
    },
  };
}
