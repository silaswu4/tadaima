import type { PlacedItem, RoomPlan } from "../../backend/contracts";
import { makeWorkspaceDemo } from "../room/workspace-fixture";

// Presentation rooms for the landing gallery until real scans are available.
// Pieces with no model file are drawn procedurally by id (see room/gallery-parts.ts).

const piece = (
  roomId: string,
  id: string,
  label: string,
  asset: string | null,
  position: [number, number, number],
  rotationY = 0,
  dimensions: [number, number, number] | null = null,
): PlacedItem => ({
  id, label, roomId, category: "other", origin: "existing_owned",
  productId: null, assetUrl: asset ? `/models/${asset}.glb` : null,
  position, rotationY, dimensions, seats: null, locked: false,
});

function shell(id: string, label: string, w: number, d: number, openings: RoomPlan["geometry"]["openings"]): RoomPlan["geometry"] {
  return {
    units: "m", coordinateSystem: "right-handed-y-up",
    rooms: [{ id, label, height: 2.6, floorPolygon: [[0, 0], [w, 0], [w, d], [0, d]], evidenceIds: [] }],
    walls: [
      { id: `${id}-back`, start: [0, 0], end: [w, 0], height: 2.6, thickness: .12, evidenceIds: [] },
      { id: `${id}-right`, start: [w, 0], end: [w, d], height: 2.6, thickness: .12, evidenceIds: [] },
      { id: `${id}-front`, start: [w, d], end: [0, d], height: 2.6, thickness: .12, evidenceIds: [] },
      { id: `${id}-left`, start: [0, d], end: [0, 0], height: 2.6, thickness: .12, evidenceIds: [] },
    ],
    openings,
  };
}

function bedroom(): RoomPlan {
  const r = "bedroom";
  return {
    schemaVersion: "0.2", projectId: "gallery-bedroom", revision: 1,
    geometry: shell(r, "Bedroom", 4.6, 4.2, [
      { id: "bedroom-window", wallId: "bedroom-left", kind: "window", offset: 1.2, width: 1.8, height: 1.4, sillHeight: .8, evidenceIds: [] },
    ]),
    items: [
      piece(r, "gallery-rug", "Wool rug", null, [2.3, 0, 1.9], 0, [2.4, .01, 1.8]),
      piece(r, "gallery-bed", "Queen bed", null, [2.3, 0, 1.25], 0, [1.7, 1, 2.15]),
      piece(r, "bed-left", "Bedside table", "side_table_01", [1.05, 0, .35]),
      piece(r, "bed-right", "Bedside table", "side_table_01", [3.55, 0, .35]),
      piece(r, "bed-vase", "Ceramic vase", "ceramic_vase_01", [3.55, .5506622816901654, .35]),
      piece(r, "bed-cabinet", "Dresser", "modern_wooden_cabinet", [4.32, 0, 2.6], -Math.PI / 2),
      piece(r, "bed-chair", "Reading chair", "mid_century_lounge_chair", [.75, 0, 3.4], Math.PI / 2 + .6),
    ],
    evidence: [], products: [], constraints: { budget: null, minimumSeats: null, clearance: 0.3 },
  };
}

function study(): RoomPlan {
  const r = "study";
  return {
    schemaVersion: "0.2", projectId: "gallery-study", revision: 1,
    geometry: shell(r, "Study", 4, 3.8, [
      { id: "study-window", wallId: "study-back", kind: "window", offset: 1.4, width: 1.5, height: 1.3, sillHeight: .9, evidenceIds: [] },
    ]),
    items: [
      piece(r, "gallery-desk", "Writing desk", null, [2.15, 0, .45], 0, [1.4, .75, .7]),
      piece(r, "gallery-desk-chair", "Desk chair", null, [2.15, 0, 1.15], Math.PI, [.5, .85, .5]),
      piece(r, "study-shelves", "Bookshelves", "wooden_display_shelves_01", [3.72, 0, 1.6], -Math.PI / 2),
      piece(r, "study-chair", "Lounge chair", "mid_century_lounge_chair", [.8, 0, 2.7], Math.PI / 2 + .4),
      piece(r, "study-side", "Side table", "side_table_01", [1.55, 0, 3.25]),
      piece(r, "gallery-lamp", "Floor lamp", null, [.45, 0, 1.9]),
    ],
    evidence: [], products: [], constraints: { budget: null, minimumSeats: null, clearance: 0.3 },
  };
}

export type GalleryRoom = { id: string; label: string; plan: RoomPlan };

export function makeGalleryRooms(): GalleryRoom[] {
  const living = makeWorkspaceDemo();
  living.geometry.rooms[0].label = "Living room";
  return [
    { id: "living-room", label: "Living room", plan: living },
    { id: "bedroom", label: "Bedroom", plan: bedroom() },
    { id: "study", label: "Study", plan: study() },
  ];
}
