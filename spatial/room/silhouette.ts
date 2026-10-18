// Soft glowing silhouette around a piece, following its real mesh (inverted hull).
// Each mesh gets two back-face shells pushed out along their normals in view space:
// a crisp inner line and a wider faint glow. Shares the mesh's geometry, two extra
// draws per mesh, no post-processing pass, so it stays cheap in the headset.
import * as THREE from "three";
import type { CollisionBox } from "../../backend/contracts";

const vertexShader = /* glsl */ `
uniform float width;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  // about the same thickness on screen near or far
  mv.xyz += n * width * clamp(-mv.z, 0.4, 12.0);
  gl_Position = projectionMatrix * mv;
}`;

const fragmentShader = /* glsl */ `
uniform vec3 color;
uniform float opacity;
void main() { gl_FragColor = vec4(color, opacity); }`;

function shellMaterial(width: number, opacity: number) {
  return new THREE.ShaderMaterial({
    uniforms: { width: { value: width }, color: { value: new THREE.Color() }, opacity: { value: opacity } },
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
  });
}

export type SilhouetteStyle = { color: string; line: number; glow: number; lineOpacity: number; glowOpacity: number };

/** One outline look (say, "selected" or "hovered"); attach it to any number of roots. */
export function createSilhouette(style: SilhouetteStyle) {
  const line = shellMaterial(style.line, style.lineOpacity);
  const glow = shellMaterial(style.glow, style.glowOpacity);
  const shells: THREE.Mesh[] = [];
  let root: THREE.Object3D | null = null;
  let version = -1;

  function clear() {
    for (const shell of shells) shell.removeFromParent();
    shells.length = 0;
    root = null;
  }

  function attach(target: THREE.Object3D) {
    clear();
    root = target;
    const meshes: THREE.Mesh[] = [];
    target.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh || node.userData.silhouette || !mesh.geometry?.getAttribute("position") || !mesh.geometry.getAttribute("normal")) return;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
      meshes.push(mesh);
    });
    for (const mesh of meshes) {
      for (const [material, order] of [[glow, 9], [line, 10]] as const) {
        const shell = new THREE.Mesh(mesh.geometry, material);
        shell.userData.silhouette = true;
        shell.raycast = () => {};
        shell.castShadow = false;
        shell.receiveShadow = false;
        shell.frustumCulled = mesh.frustumCulled;
        shell.renderOrder = order;
        mesh.add(shell);
        shells.push(shell);
      }
    }
  }

  return {
    /** Follow `target` (re-attaching when `modelVersion` changes); null hides the outline. */
    show(target: THREE.Object3D | null, modelVersion = 0, color = style.color) {
      if (!target) { if (root) clear(); return; }
      if (target !== root || modelVersion !== version) { attach(target); version = modelVersion; }
      line.uniforms.color.value.set(color);
      glow.uniforms.color.value.set(color);
    },
    dispose() { clear(); line.dispose(); glow.dispose(); },
  };
}

/**
 * The floor shape of a piece's solid parts: one flat quad per part, in the piece's frame,
 * for the carry footprint. Overlaps are drawn once by a depth-tested material.
 */
export function partsFloorGeometry(parts: readonly CollisionBox[]): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const [cx, , cz, w, , d] of parts) {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    positions.push(x0, 0, z0, x0, 0, z1, x1, 0, z1, x0, 0, z0, x1, 0, z1, x1, 0, z0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
