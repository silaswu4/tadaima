import * as THREE from "three";
import type { Vector3Meters } from "../../backend/contracts";
import { block, place, rod, rug, standingLamp, surface } from "./parts";

// Simple procedural stand-ins for gallery pieces that have no model file yet.
// Sized from the item's dimensions, sitting on y = 0, front facing +z.

const g = (...parts: THREE.Object3D[]) => {
  const out = new THREE.Group();
  out.add(...parts);
  return out;
};

function bed([w, , d]: [number, number, number]) {
  const frame = surface("#b98d63", 0.7);
  const linen = surface("#f1ece3", 0.95);
  const throwBlanket = surface("#c9b49a", 1);
  const pillow = surface("#fbf8f2", 1);
  return g(
    block(w, 0.32, d, frame, 0.02),
    place(block(w, 0.95, 0.08, frame, 0.02), 0, 0, -d / 2 + 0.04),
    place(block(w - 0.06, 0.22, d - 0.16, linen, 0.06), 0, 0.32, 0.05),
    place(block(w - 0.02, 0.06, d * 0.36, throwBlanket, 0.02), 0, 0.53, d * 0.24),
    place(block(w * 0.4, 0.12, 0.34, pillow, 0.05), -w * 0.23, 0.54, -d / 2 + 0.3),
    place(block(w * 0.4, 0.12, 0.34, pillow, 0.05), w * 0.23, 0.54, -d / 2 + 0.3),
  );
}

function desk([w, h, d]: [number, number, number]) {
  const wood = surface("#a77d55", 0.65);
  const dark = surface("#2e2a25", 0.5, 0.2);
  const legs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => place(rod(0.022, 0.018, h - 0.04, dark, 12), sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06))));
  return g(...legs, place(block(w, 0.04, d, wood, 0.01), 0, h - 0.04, 0), place(block(0.34, 0.24, 0.02, dark, 0.006), 0.2, h, -d / 2 + 0.18));
}

function deskChair([w, h, d]: [number, number, number]) {
  const seat = surface("#8a6e4e", 0.85);
  const dark = surface("#2e2a25", 0.5, 0.2);
  return g(
    rod(0.025, 0.025, 0.42, dark, 12),
    place(rod(0.26, 0.26, 0.02, dark, 20), 0, 0, 0),
    place(block(w, 0.07, d, seat, 0.03), 0, 0.42, 0),
    place(block(w, h - 0.49, 0.06, seat, 0.03), 0, 0.49, -d / 2 + 0.03),
  );
}

/** Returns a model for gallery-only ids, or null when the item has its own asset. */
export function galleryPart(id: string, dimensions: Vector3Meters | null): THREE.Object3D | null {
  const size: [number, number, number] = dimensions ? [dimensions[0], dimensions[1], dimensions[2]] : [1, 1, 1];
  switch (id) {
    case "demo-rug":
      return rug(3, 2.1, "#d6cab6");
    case "gallery-rug":
      return rug(size[0], size[2], "#cfc2ad");
    case "demo-lamp":
    case "gallery-lamp":
      return standingLamp();
    case "gallery-bed":
      return bed(size);
    case "gallery-desk":
      return desk(size);
    case "gallery-desk-chair":
      return deskChair(size);
    default:
      return null;
  }
}
