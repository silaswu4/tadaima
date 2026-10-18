import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

// every piece is modelled in metres, sitting on y = 0, centred on its
// footprint, front facing +z.

export function surface(color: string, rough = 0.8, metal = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}

export function block(w: number, h: number, d: number, m: THREE.Material, round = 0.015) {
  const r = Math.min(round, Math.min(w, h, d) / 2 - 0.001);
  const geo = r > 0.002 ? new RoundedBoxGeometry(w, h, d, 3, r) : new THREE.BoxGeometry(w, h, d);
  geo.translate(0, h / 2, 0);
  return new THREE.Mesh(geo, m);
}

export function rod(rTop: number, rBottom: number, h: number, m: THREE.Material, seg = 24) {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
  geo.translate(0, h / 2, 0);
  return new THREE.Mesh(geo, m);
}

export function place<T extends THREE.Object3D>(o: T, x = 0, y = 0, z = 0): T {
  o.position.set(x, y, z);
  return o;
}

export function seeded(seed: number) {
  let s = seed >>> 0 || 7;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

const g = (...parts: THREE.Object3D[]) => {
  const out = new THREE.Group();
  out.add(...parts);
  return out;
};

const INK = "#24221f";

export function rug(w: number, d: number, color: string) {
  return g(place(block(w, 0.012, d, surface(color, 1), 0), 0, 0, 0));
}

export function standingLamp() {
  const dark = surface(INK, 0.4, 0.3);
  const shade = new THREE.MeshStandardMaterial({
    color: "#f3e8d4",
    roughness: 0.9,
    emissive: "#ffbd7a",
    emissiveIntensity: 1.4,
    side: THREE.DoubleSide,
  });
  const light = new THREE.PointLight("#ffbd7a", 3.2, 0, 2);
  light.position.set(0, 1.42, 0);
  return g(
    rod(0.14, 0.16, 0.025, dark),
    rod(0.012, 0.012, 1.4, dark, 10),
    place(rod(0.15, 0.21, 0.28, shade, 32), 0, 1.3, 0),
    light,
  );
}
