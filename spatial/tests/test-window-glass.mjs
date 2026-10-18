import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { applyBakedIndirect, INDIRECT_PROFILE } from "../room/baked-indirect.ts";
import { prepareWindowGlass } from "../room/window-glass.ts";

function fixture() {
  const root = new THREE.Group(), opening = new THREE.Group();
  opening.userData = { entityId: "window-1", role: "opening" };
  root.add(opening);
  const material = new THREE.MeshStandardMaterial({ color: "#7d929c", opacity: .22, transparent: true, roughness: .08 });
  const pane = new THREE.Mesh(new THREE.BoxGeometry(), material);
  pane.userData = { componentKind: "WindowGlass", ownerOpeningId: "window-1" };
  pane.castShadow = true; pane.receiveShadow = true;
  opening.add(pane);
  return { root, opening, pane, material };
}

test("semantic panes become clear alpha PBR without transmission or opaque shadows", () => {
  const { root, pane, material } = fixture();
  assert.equal(prepareWindowGlass(root), 1);
  assert.notEqual(pane.material, material);
  assert.equal(pane.material.color.getHex(), new THREE.Color("#e4f0f3").getHex());
  assert.equal(pane.material.opacity, .1); assert.equal(pane.material.transparent, true);
  assert.equal(pane.material.roughness, .05); assert.equal(pane.material.metalness, 0);
  assert.equal(pane.material.depthWrite, false); assert.equal(pane.material.side, THREE.DoubleSide);
  assert.equal(pane.material.forceSinglePass, true); assert.equal(pane.material.envMapIntensity, 1);
  assert.equal(pane.castShadow, false); assert.equal(pane.receiveShadow, false);
  assert.equal(pane.material.isMeshPhysicalMaterial, undefined);
});

test("partial roller blinds and shared source finishes retain their opaque appearance", () => {
  const { root, opening, pane, material } = fixture();
  material.opacity = 1; material.transparent = false;
  const blind = new THREE.Mesh(new THREE.BoxGeometry(), material);
  blind.userData = { componentKind: "PartialRollerBlind", ownerOpeningId: "window-1" };
  blind.castShadow = true; opening.add(blind);
  assert.equal(prepareWindowGlass(root), 1);
  assert.equal(blind.material, material); assert.equal(blind.material.opacity, 1);
  assert.equal(blind.material.transparent, false); assert.equal(blind.castShadow, true);
  assert.equal(material.color.getHex(), new THREE.Color("#7d929c").getHex());
  assert.notEqual(pane.material, blind.material);
});

test("baked transport is removed from panes without mutating or disposing shared atlas data", () => {
  const { root, pane, material } = fixture();
  const atlas = new THREE.Texture(); atlas.channel = 1;
  material.userData = { tadaimaIndirectLightmap: INDIRECT_PROFILE, tadaimaIndirectScale: 2, tadaimaIndirectAo: true, sourceEvidence: "photo-1" };
  material.emissiveMap = atlas; material.lightMap = atlas; material.emissive.set("white");
  let disposed = 0; atlas.addEventListener("dispose", () => disposed++);
  prepareWindowGlass(root);
  assert.equal(pane.material.userData.tadaimaIndirectLightmap, undefined);
  assert.equal(pane.material.userData.tadaimaIndirectScale, undefined);
  assert.equal(pane.material.userData.tadaimaIndirectAo, undefined);
  assert.equal(pane.material.userData.sourceEvidence, "photo-1");
  assert.equal(pane.material.lightMap, null); assert.equal(pane.material.emissiveMap, null);
  assert.equal(pane.material.emissive.getHex(), 0); assert.equal(pane.material.lightMapIntensity, 0);
  assert.equal(applyBakedIndirect(root), 0, "glass no longer requires a diffuse lightmap or UV atlas");
  assert.equal(material.userData.tadaimaIndirectLightmap, INDIRECT_PROFILE);
  assert.equal(material.emissiveMap, atlas); assert.equal(material.lightMap, atlas);
  assert.equal(material.emissive.getHex(), 0xffffff); assert.equal(disposed, 0);
});

test("ordinary glass textures are retained unless explicitly identified as baked transport", () => {
  const { root, pane, material } = fixture();
  const emission = new THREE.Texture(), normal = new THREE.Texture(), color = new THREE.Texture();
  material.emissiveMap = emission; material.normalMap = normal; material.map = color;
  prepareWindowGlass(root);
  assert.equal(pane.material.emissiveMap, emission);
  assert.equal(pane.material.normalMap, normal); assert.equal(pane.material.map, color);
  assert.equal(pane.material.emissive.getHex(), 0);
});

for (const [name, change] of Object.entries({
  "name alone": ({ pane }) => { pane.name = "WindowGlass"; delete pane.userData.componentKind; },
  "missing owner": ({ pane }) => { delete pane.userData.ownerOpeningId; },
  "nonstring owner": ({ pane }) => { pane.userData.ownerOpeningId = 42; },
  "blank owner": ({ pane }) => { pane.userData.ownerOpeningId = " "; },
  "wrong owner": ({ pane }) => { pane.userData.ownerOpeningId = "other-window"; },
  "furniture ancestor": ({ opening }) => { opening.userData.role = "existing_furniture"; },
  "unsupported material": ({ pane }) => { pane.material = new THREE.MeshBasicMaterial(); },
})) test(`malformed glass metadata is ignored: ${name}`, () => {
  const value = fixture(); change(value); const before = value.pane.material;
  assert.equal(prepareWindowGlass(value.root), 0); assert.equal(value.pane.material, before);
  assert.equal(value.pane.castShadow, true);
});

test("each pane owns its finish and repeated preparation avoids additional material allocations", () => {
  const { root, opening, pane, material } = fixture();
  const second = pane.clone(); second.material = material; opening.add(second);
  assert.equal(prepareWindowGlass(root), 2);
  assert.notEqual(second.material, pane.material); assert.notEqual(second.material, material);
  const firstPrepared = pane.material, secondPrepared = second.material;
  pane.castShadow = true; pane.receiveShadow = true;
  assert.equal(prepareWindowGlass(root), 2);
  assert.equal(pane.material, firstPrepared); assert.equal(second.material, secondPrepared);
  assert.equal(pane.castShadow, false); assert.equal(pane.receiveShadow, false);
});

test("physical source glass cannot enable an expensive transmission pass", () => {
  const { root, pane } = fixture();
  pane.material = new THREE.MeshPhysicalMaterial({ transmission: 1, opacity: 1 });
  prepareWindowGlass(root);
  assert.equal(pane.material.transmission, 0); assert.equal(pane.material.opacity, .1);
});

test("unknown baked profiles remain visible to the validation boundary", () => {
  const { root, pane, material } = fixture();
  const map = new THREE.Texture(); material.emissiveMap = map;
  material.userData.tadaimaIndirectLightmap = "unsupported-profile";
  prepareWindowGlass(root);
  assert.equal(pane.material.userData.tadaimaIndirectLightmap, "unsupported-profile");
  assert.equal(pane.material.emissiveMap, map);
  assert.throws(() => applyBakedIndirect(root), /Unsupported baked room lighting profile/);
});
