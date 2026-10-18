import type { PlacedItem, RoomPlan } from "../../backend/contracts";

// Presentation fixture, in meters. These are sample placements, not a scan or
// verified retailer measurements. Exploding the view never edits this plan.
const item = (
  id: string, label: string, asset: string | null,
  position: [number, number, number], rotationY = 0,
): PlacedItem => ({
  id, label, roomId: "living-room", origin: "existing_owned",
  productId: null, assetUrl: asset ? `/models/${asset}.glb` : null,
  position, rotationY, dimensions: null, locked: false,
});

export function makeWorkspaceDemo(): RoomPlan {
  return {
    schemaVersion: "0.1-scaffold", projectId: "furniture-workspace-demo", revision: 1,
    geometry: {
      units: "m", coordinateSystem: "right-handed-y-up",
      rooms: [{ id: "living-room", label: "Demo living room", height: 2.7,
        floorPolygon: [[0, 0], [6, 0], [6, 6.2], [0, 6.2]], evidenceIds: [] }],
      walls: [
        { id: "back", start: [0, 0], end: [6, 0], height: 2.7, thickness: .12, evidenceIds: [] },
        { id: "right", start: [6, 0], end: [6, 6.2], height: 2.7, thickness: .12, evidenceIds: [] },
        { id: "front", start: [6, 6.2], end: [0, 6.2], height: 2.7, thickness: .12, evidenceIds: [] },
        { id: "left", start: [0, 6.2], end: [0, 0], height: 2.7, thickness: .12, evidenceIds: [] },
      ],
      openings: [
        { id: "window", wallId: "left", kind: "window", offset: 1.5, width: 2.2, height: 1.45, sillHeight: .85, evidenceIds: [] },
        { id: "door", wallId: "front", kind: "door", offset: .7, width: .95, height: 2.1, sillHeight: 0, evidenceIds: [] },
      ],
    },
    items: [
      item("demo-rug", "Woven rug", null, [3, 0, 1.45]),
      item("sofa", "Sofa", "sofa_02", [3, 0, .46]),
      item("coffee-table", "Coffee table", "modern_coffee_table_01", [3, 0, 1.65], Math.PI / 2),
      item("lounge-chair", "Lounge chair", "mid_century_lounge_chair", [1.15, 0, 1.95], Math.PI / 2 + .45),
      item("cabinet", "Wood cabinet", "modern_wooden_cabinet", [5.72, 0, 2.05], -Math.PI / 2),
      item("shelves", "Display shelves", "wooden_display_shelves_01", [5.15, 0, .2], Math.PI / 2),
      item("side-table", "Side table", "side_table_01", [4.38, 0, .32]),
      item("vase", "Ceramic vase", "ceramic_vase_01", [4.38, .5506622816901654, .32]),
      item("demo-lamp", "Floor lamp", null, [1.8, 0, .32]),
    ],
    evidence: [], products: [], constraints: { budget: null, minimumSeats: null },
  };
}
