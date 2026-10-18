import * as THREE from "three";

export const INDIRECT_PROFILE = "cycles-diffuse-indirect-v1";
export const FULL_DIFFUSE_PROFILE = "cycles-diffuse-full-v1";
const profiles = new Set([INDIRECT_PROFILE, FULL_DIFFUSE_PROFILE]);
const installed = new WeakSet<THREE.Material>();

/** The derived GLB uses emissiveTexture only as a portable, embedded transport.
 * Rebind it as actual irradiance; leaving it emissive would make surfaces glow.
 * Base-color/normal UVs stay on channel 0 and baked light uses channel 1. */
export function applyBakedIndirect(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material.userData.tadaimaIndirectLightmap) continue;
      if (!(material instanceof THREE.MeshStandardMaterial) || !profiles.has(material.userData.tadaimaIndirectLightmap)) {
        throw new Error("Unsupported baked room lighting profile.");
      }
      const texture = material.emissiveMap ?? material.lightMap;
      const scale = material.userData.tadaimaIndirectScale ?? 1;
      if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > 64) {
        throw new Error("Baked room lighting has an invalid intensity scale.");
      }
      const uv = node.geometry.getAttribute("uv1");
      if (!texture || texture.channel !== 1 || !uv || uv.itemSize !== 2 || uv.count !== node.geometry.getAttribute("position")?.count) {
        throw new Error("Baked room lighting needs an embedded texture and matching secondary UVs.");
      }
      for (let i = 0; i < uv.count; i++) {
        if (![uv.getX(i), uv.getY(i)].every((value) => Number.isFinite(value) && value >= -.001 && value <= 1.001)) {
          throw new Error("Baked room lighting UVs must stay inside the atlas.");
        }
      }
      count++;
      if (installed.has(material)) continue;
      texture.colorSpace = THREE.SRGBColorSpace;
      // Global mip generation blends unrelated packed islands into black
      // padding, creating dark seams on thin chair rails. Irradiance is already
      // low frequency; bilinear sampling avoids those seams and saves mip VRAM.
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      material.lightMap = texture;
      // Blender's color-free diffuse bake contains radiance (irradiance / PI).
      // Three's indirect diffuse BRDF applies 1/PI after sampling the light map.
      material.lightMapIntensity = Math.PI * scale;
      material.emissiveMap = null;
      material.emissive.set(0);
      const fullDiffuse = material.userData.tadaimaIndirectLightmap === FULL_DIFFUSE_PROFILE;
      if (material.userData.tadaimaIndirectAo === true || fullDiffuse) {
        const previousCompile = material.onBeforeCompile;
        material.onBeforeCompile = function (shader, renderer) {
          previousCompile.call(this, shader, renderer);
          if (fullDiffuse) {
            shader.fragmentShader = shader.fragmentShader.replace("#include <shadowmap_pars_fragment>", "#include <shadowmap_pars_fragment>\n#include <shadowmask_pars_fragment>")
              .replace("#include <lights_fragment_end>", `
#include <lights_fragment_end>
#ifdef USE_LIGHTMAP
  if (lightMapIntensity > 0.0) {
    // Use Cycles' soft direct + indirect diffuse once, keeping the live PBR
    // specular response. A modest dynamic shadow supplies new/moving contacts.
    reflectedLight.directDiffuse = vec3(0.0);
    reflectedLight.indirectDiffuse = texture2D(lightMap, vLightMapUv).rgb * lightMapIntensity * BRDF_Lambert(material.diffuseColor) * mix(0.72, 1.0, getShadowMask());
  }
#endif`);
          } else shader.fragmentShader = shader.fragmentShader.replace("#include <aomap_fragment>", `
#include <aomap_fragment>
#ifdef USE_LIGHTMAP
  float bakedRoomAO = lightMapIntensity > 0.0 ? mix(1.0, clamp(texture2D(lightMap, vLightMapUv).a, 0.0, 1.0), 0.55) : 1.0;
  reflectedLight.indirectDiffuse *= bakedRoomAO;
  reflectedLight.indirectSpecular *= bakedRoomAO;
#endif`);
        };
        material.customProgramCacheKey = () => fullDiffuse ? "tadaima-cycles-diffuse-v1" : "tadaima-indirect-ao-v1";
      }
      material.needsUpdate = true;
      installed.add(material);
    }
  });
  return count;
}

/** Bounced light is tied to the captured pose. A moved/rotated piece uses the
 * runtime rig until it returns; static architecture keeps its clean bake. */
export function setBakedIndirectEnabled(root: THREE.Object3D, enabled: boolean) {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (material instanceof THREE.MeshStandardMaterial && profiles.has(material.userData.tadaimaIndirectLightmap)) {
        material.lightMapIntensity = enabled ? Math.PI * (material.userData.tadaimaIndirectScale ?? 1) : 0;
      }
    }
  });
}

export function bakedPoseMatches(source: { position: readonly number[]; rotationY: number }, position: THREE.Vector3, rotationY: number) {
  return position.toArray().every((value, index) => Number.isFinite(value) && Math.abs(value - source.position[index]) < .0001)
    && Number.isFinite(rotationY) && Math.abs(Math.atan2(Math.sin(rotationY - source.rotationY), Math.cos(rotationY - source.rotationY))) < .00001;
}

/** glTF materials are shared between chairs. Editing one must not disable the
 * baked shading on every other chair with the same finish. */
export function ownBakedIndirectMaterials(root: THREE.Object3D) {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const own = (material: THREE.Material) => profiles.has(material.userData.tadaimaIndirectLightmap) ? material.clone() : material;
    node.material = Array.isArray(node.material) ? node.material.map(own) : own(node.material);
  });
  applyBakedIndirect(root);
}
