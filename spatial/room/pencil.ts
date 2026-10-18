import * as THREE from "three";

// the pencil drawing look shared by the plan viewer: white paper fills, graphite
// edges, and a back-face contour. scene.ts keeps its own copy so the retained
// hero stays byte for byte as it was.

export const PAPER = "#ffffff";
export const INK = "#141414";
export const PICKED_FILL = "#e9e9e7";
export const HOVER_FILL = "#f3f3f1";
// the clay accent from the stylesheet, used only for revision changes
export const CHANGE = "#c2643b";

// flat white, unlit, pushed back a touch so the ink edges never z-fight
export function sheet(color = PAPER) {
  return new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

// back-face hull pushed out along the normal in view space, so the contour is
// the same pencil weight at any distance
export const contour = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
contour.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader.replace(
    "#include <project_vertex>",
    `vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
    mvPosition.xyz += normalize( normalMatrix * normal ) * ( -mvPosition.z ) * 0.0017;
    gl_Position = projectionMatrix * mvPosition;`,
  );
};

const noRaycast = () => {};

export function contours(root: THREE.Object3D) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && o.geometry.attributes.normal && !o.userData.noEdges) meshes.push(o);
  });
  for (const m of meshes) {
    const hull = new THREE.Mesh(m.geometry, contour);
    hull.raycast = noRaycast;
    hull.userData.noEdges = true;
    hull.userData.sharedGeometry = true;
    m.add(hull);
  }
}

// outline every mesh under root with its hard edges
export function inkEdges(root: THREE.Object3D, line: THREE.LineBasicMaterial, angle = 30) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && !o.userData.noEdges) meshes.push(o);
  });
  for (const m of meshes) {
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, angle), line);
    edges.raycast = noRaycast;
    if (line instanceof THREE.LineDashedMaterial) edges.computeLineDistances();
    m.add(edges);
  }
}

export function inkLine(opacity = 1, color = INK) {
  return new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
}

export function dashedLine(opacity = 1, color = INK, dash = 0.06) {
  return new THREE.LineDashedMaterial({ color, dashSize: dash, gapSize: dash * 0.7, transparent: opacity < 1, opacity });
}

/** Line segments from pairs of points, ready to draw dashed or solid. */
export function segments(points: THREE.Vector3[], material: THREE.LineBasicMaterial) {
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), material);
  lines.raycast = noRaycast;
  if (material instanceof THREE.LineDashedMaterial) lines.computeLineDistances();
  return lines;
}

/** Closed outline on the floor through the given [x, z] points. */
export function floorLoop(points: readonly (readonly [number, number])[], material: THREE.LineBasicMaterial, y = 0.004) {
  const pairs: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    pairs.push(new THREE.Vector3(a[0], y, a[1]), new THREE.Vector3(b[0], y, b[1]));
  }
  return segments(pairs, material);
}

/** Recursively free geometries, materials, and textures, leaving shared ones alone. */
export function disposeTree(root: THREE.Object3D, keep?: ReadonlySet<THREE.Material>) {
  const materials = new Map<THREE.Material, boolean>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry && !o.userData.sharedGeometry) mesh.geometry.dispose();
    const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) if (mat !== contour) materials.set(mat, !o.userData.sharedTexture);
  });
  for (const [mat, ownsMap] of materials) {
    if (keep?.has(mat)) continue;
    if (ownsMap) (mat as THREE.MeshBasicMaterial).map?.dispose();
    mat.dispose();
  }
}
