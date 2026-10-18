import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { applyBakedIndirect, bakedPoseMatches, FULL_DIFFUSE_PROFILE, INDIRECT_PROFILE, ownBakedIndirectMaterials, setBakedIndirectEnabled } from "../room/baked-indirect.ts";

function fixture() {
  const map = new THREE.Texture({ width: 2, height: 2 }); map.channel = 1;
  const geometry = new THREE.BoxGeometry();
  geometry.setAttribute("uv1", geometry.attributes.uv.clone());
  const material = new THREE.MeshStandardMaterial({ color: "#997744", emissive: "white", emissiveMap: map });
  material.userData.tadaimaIndirectLightmap = INDIRECT_PROFILE;
  material.userData.tadaimaIndirectScale = 2;
  const mesh = new THREE.Mesh(geometry, material);
  return { mesh, material, map };
}

test("Cycles texture becomes irradiance, preserving original PBR finish and UV0", () => {
  const { mesh, material, map } = fixture();
  const base = material.color.clone(), uv = mesh.geometry.attributes.uv.clone();
  assert.equal(applyBakedIndirect(mesh), 1);
  assert.equal(material.lightMap, map); assert.equal(material.lightMapIntensity, Math.PI * 2);
  assert.equal(material.emissiveMap, null); assert.equal(material.emissive.getHex(), 0);
  assert.equal(map.colorSpace, THREE.SRGBColorSpace); assert.equal(map.channel, 1);
  assert(material.color.equals(base)); assert.deepEqual(mesh.geometry.attributes.uv.array, uv.array);
  applyBakedIndirect(mesh); assert.equal(material.lightMapIntensity, Math.PI * 2);
});

for (const [name, change] of Object.entries({
  "unsupported profile": ({ material }) => material.userData.tadaimaIndirectLightmap = "unknown",
  "wrong texture UV channel": ({ map }) => map.channel = 0,
  "missing UVs": ({ mesh }) => mesh.geometry.deleteAttribute("uv1"),
  "out-of-atlas UVs": ({ mesh }) => mesh.geometry.attributes.uv1.setX(0, 2),
  "nonfinite UVs": ({ mesh }) => mesh.geometry.attributes.uv1.setY(0, NaN),
  "nonfinite intensity": ({ material }) => material.userData.tadaimaIndirectScale = Infinity,
  "oversized intensity": ({ material }) => material.userData.tadaimaIndirectScale = 65,
})) test(`malformed derived lighting rejects ${name}`, () => {
  const value = fixture(); change(value); assert.throws(() => applyBakedIndirect(value.mesh), /baked room lighting|Baked room lighting/);
});

test("optional AO composes with previous shader hooks and only occludes indirect lighting", () => {
  const { mesh, material } = fixture();
  material.userData.tadaimaIndirectAo = true;
  let calls = 0; material.onBeforeCompile = () => calls++;
  applyBakedIndirect(mesh); applyBakedIndirect(mesh);
  const shader = { fragmentShader: "#include <aomap_fragment>" };
  material.onBeforeCompile(shader, {});
  assert.equal(calls, 1);
  assert(shader.fragmentShader.includes("texture2D(lightMap, vLightMapUv).a"));
  assert(shader.fragmentShader.includes("lightMapIntensity > 0.0"));
  assert(!shader.fragmentShader.includes("reflectedLight.directDiffuse *="));
});

test("shared chair materials become independent so moving one keeps other chairs lit", () => {
  const { mesh, material } = fixture(); applyBakedIndirect(mesh);
  const second = mesh.clone(true); ownBakedIndirectMaterials(second);
  assert.notEqual(second.material, material);
  assert.equal(second.material.lightMap, material.lightMap, "atlas GPU storage stays shared");
  setBakedIndirectEnabled(second, false);
  assert.equal(second.material.lightMapIntensity, 0); assert.equal(material.lightMapIntensity, Math.PI * 2);
  setBakedIndirectEnabled(second, true); assert.equal(second.material.lightMapIntensity, Math.PI * 2);
});

test("bake validity follows actual pose, including rotations modulo a full turn", () => {
  const source = { position: [1, 0, 2], rotationY: .5 };
  assert(bakedPoseMatches(source, new THREE.Vector3(1, 0, 2), .5 + Math.PI * 2));
  assert(!bakedPoseMatches(source, new THREE.Vector3(1.01, 0, 2), .5));
  assert(!bakedPoseMatches(source, new THREE.Vector3(1, 0, 2), .51));
  assert(!bakedPoseMatches(source, new THREE.Vector3(NaN, 0, 2), .5));
});

test("ordinary catalog materials keep their emission and do not acquire a lightmap", () => {
  const material = new THREE.MeshStandardMaterial({ emissive: "red" });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  assert.equal(applyBakedIndirect(mesh), 0); ownBakedIndirectMaterials(mesh); setBakedIndirectEnabled(mesh, false);
  assert.equal(mesh.material, material); assert.equal(material.emissive.getHex(), 0xff0000); assert.equal(material.lightMap, null);
});

test("full diffuse bake replaces diffuse lighting once while retaining live specular and contacts", () => {
  const { mesh, material } = fixture(); material.userData.tadaimaIndirectLightmap = FULL_DIFFUSE_PROFILE;
  applyBakedIndirect(mesh);
  const shader = { fragmentShader: "#include <shadowmap_pars_fragment>\n#include <lights_fragment_end>" };
  material.onBeforeCompile(shader, {});
  assert(shader.fragmentShader.includes("#include <shadowmask_pars_fragment>"));
  assert(shader.fragmentShader.includes("reflectedLight.directDiffuse = vec3(0.0)"));
  assert(shader.fragmentShader.includes("getShadowMask()"));
  assert(!shader.fragmentShader.includes("directSpecular ="));
  setBakedIndirectEnabled(mesh, false); assert.equal(material.lightMapIntensity, 0);
});
