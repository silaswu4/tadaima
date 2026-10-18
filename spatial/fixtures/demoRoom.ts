import type { RoomPlan } from "@/backend/contracts";

/*
 * Synthetic development fixture for the spatial viewer. Not a real home, not real
 * retailer offers, and not produced by the backend. Every merchant URL is on
 * example.com. Replace with Matthew's shared fixture from backend/ once it exists;
 * this file only uses the shared RoomPlan type and adds no fields of its own.
 *
 * Revision 2 is the constrained revision from the demo plan: the sofa and desk
 * stay locked in place, seating for four is kept, and the budget target drops.
 */

const OBSERVED = "2026-10-17T19:00:00Z";

const evidence: RoomPlan["evidence"] = [
  {
    id: "ev_fixture_outline",
    sourceUrl: null,
    privateAssetId: null,
    observedAt: OBSERVED,
    claim: "Synthetic sample room outline, 5.2 m by 4.4 m, 2.6 m ceiling. Not measured.",
    dimensionStatus: "inferred",
    confirmedByUserAt: null,
  },
  {
    id: "ev_fixture_openings",
    sourceUrl: null,
    privateAssetId: null,
    observedAt: OBSERVED,
    claim: "Synthetic window and door positions. Not measured.",
    dimensionStatus: "inferred",
    confirmedByUserAt: null,
  },
  {
    id: "ev_fixture_listing_table",
    sourceUrl: "https://example.com/fixture/oak-coffee-table",
    privateAssetId: null,
    observedAt: OBSERVED,
    claim: "Synthetic listing dimensions for the oak coffee table.",
    dimensionStatus: "source_dimension",
    confirmedByUserAt: null,
  },
  {
    id: "ev_fixture_listing_round",
    sourceUrl: "https://example.com/fixture/round-coffee-table",
    privateAssetId: null,
    observedAt: OBSERVED,
    claim: "Synthetic listing dimensions for the round coffee table.",
    dimensionStatus: "source_dimension",
    confirmedByUserAt: null,
  },
  {
    id: "ev_fixture_listing_shelves",
    sourceUrl: "https://example.com/fixture/display-shelves",
    privateAssetId: null,
    observedAt: OBSERVED,
    claim: "Synthetic listing dimensions for the display shelves.",
    dimensionStatus: "source_dimension",
    confirmedByUserAt: null,
  },
  {
    id: "ev_fixture_listing_side",
    sourceUrl: "https://example.com/fixture/side-table",
    privateAssetId: null,
    observedAt: OBSERVED,
    claim: "Synthetic listing dimensions for the side table.",
    dimensionStatus: "source_dimension",
    confirmedByUserAt: null,
  },
];

const geometry: RoomPlan["geometry"] = {
  units: "m",
  coordinateSystem: "right-handed-y-up",
  rooms: [
    {
      id: "room_living",
      label: "Living room",
      floorPolygon: [
        [0, 0],
        [5.2, 0],
        [5.2, 4.4],
        [0, 4.4],
      ],
      height: 2.6,
      evidenceIds: ["ev_fixture_outline"],
    },
  ],
  walls: [
    { id: "wall_north", start: [0, 0], end: [5.2, 0], height: 2.6, thickness: 0.12, evidenceIds: ["ev_fixture_outline"] },
    { id: "wall_east", start: [5.2, 0], end: [5.2, 4.4], height: 2.6, thickness: 0.12, evidenceIds: ["ev_fixture_outline"] },
    { id: "wall_south", start: [5.2, 4.4], end: [0, 4.4], height: 2.6, thickness: 0.12, evidenceIds: ["ev_fixture_outline"] },
    { id: "wall_west", start: [0, 4.4], end: [0, 0], height: 2.6, thickness: 0.12, evidenceIds: ["ev_fixture_outline"] },
  ],
  openings: [
    {
      id: "opening_window_west",
      wallId: "wall_west",
      kind: "window",
      offset: 1.4,
      width: 1.6,
      height: 1.4,
      sillHeight: 0.8,
      evidenceIds: ["ev_fixture_openings"],
    },
    {
      id: "opening_door_south",
      wallId: "wall_south",
      kind: "door",
      offset: 3.6,
      width: 0.9,
      height: 2.1,
      sillHeight: 0,
      evidenceIds: ["ev_fixture_openings"],
    },
  ],
};

const products: RoomPlan["products"] = [
  {
    id: "prod_fixture_oak_coffee_table",
    merchant: "Fixture merchant",
    sourceUrl: "https://example.com/fixture/oak-coffee-table",
    variantId: "fixture-oak-natural",
    label: "Oak coffee table",
    category: "table",
    seats: null,
    imageUrl: null,
    fixture: true,
    // in the model's own frame: this asset runs its long side along local z
    dimensions: [0.6, 0.39, 1.2],
    price: { amountMinor: 42900, currency: "USD" },
    availability: "available",
    observedAt: OBSERVED,
    evidenceIds: ["ev_fixture_listing_table"],
  },
  {
    id: "prod_fixture_round_coffee_table",
    merchant: "Fixture merchant",
    sourceUrl: "https://example.com/fixture/round-coffee-table",
    variantId: "fixture-round-ash",
    label: "Round coffee table",
    category: "table",
    seats: null,
    imageUrl: null,
    fixture: true,
    dimensions: [0.8, 0.4, 0.8],
    price: { amountMinor: 18900, currency: "USD" },
    availability: "available",
    observedAt: OBSERVED,
    evidenceIds: ["ev_fixture_listing_round"],
  },
  {
    id: "prod_fixture_display_shelves",
    merchant: "Fixture merchant",
    sourceUrl: "https://example.com/fixture/display-shelves",
    variantId: null,
    label: "Display shelves",
    category: "storage",
    seats: null,
    imageUrl: null,
    fixture: true,
    dimensions: [0.37, 1.56, 1.08],
    price: { amountMinor: 31900, currency: "USD" },
    availability: "unknown",
    observedAt: OBSERVED,
    evidenceIds: ["ev_fixture_listing_shelves"],
  },
  {
    id: "prod_fixture_side_table",
    merchant: "Fixture merchant",
    sourceUrl: "https://example.com/fixture/side-table",
    variantId: null,
    label: "Side table",
    category: "table",
    seats: null,
    imageUrl: null,
    fixture: true,
    dimensions: null,
    price: null,
    availability: "unknown",
    observedAt: OBSERVED,
    evidenceIds: ["ev_fixture_listing_side"],
  },
];

export const DEMO_PLAN_R1: RoomPlan = {
  schemaVersion: "0.2",
  projectId: "project_fixture_living",
  revision: 1,
  geometry,
  evidence,
  products,
  items: [
    {
      id: "item_sofa",
      roomId: "room_living",
      label: "Sofa",

      category: "sofa",

      seats: 3,
      origin: "existing_owned",
      productId: null,
      assetUrl: "/models/sofa_02.glb",
      position: [2.6, 0, 0.6],
      rotationY: 0,
      dimensions: [1.81, 0.71, 0.82],
      locked: true,
    },
    {
      id: "item_coffee_table",
      roomId: "room_living",
      label: "Coffee table",

      category: "table",

      seats: null,
      origin: "proposed_purchase",
      productId: "prod_fixture_oak_coffee_table",
      assetUrl: "/models/modern_coffee_table_01.glb",
      position: [2.6, 0, 1.75],
      rotationY: Math.PI / 2,
      dimensions: null,
      locked: false,
    },
    {
      id: "item_lounge_chair",
      roomId: "room_living",
      label: "Lounge chair",

      category: "chair",

      seats: 1,
      origin: "existing_owned",
      productId: null,
      assetUrl: "/models/mid_century_lounge_chair.glb",
      position: [0.9, 0, 2.1],
      rotationY: Math.PI / 2 + 0.45,
      dimensions: [1.01, 1.17, 1.19],
      locked: false,
    },
    {
      id: "item_cabinet",
      roomId: "room_living",
      label: "Cabinet",

      category: "storage",

      seats: null,
      origin: "existing_owned",
      productId: null,
      assetUrl: "/models/modern_wooden_cabinet.glb",
      position: [4.9, 0, 2.1],
      rotationY: -Math.PI / 2,
      dimensions: null,
      locked: false,
    },
    {
      id: "item_shelves",
      roomId: "room_living",
      label: "Display shelves",

      category: "storage",

      seats: null,
      origin: "proposed_purchase",
      productId: "prod_fixture_display_shelves",
      assetUrl: "/models/wooden_display_shelves_01.glb",
      position: [4.4, 0, 0.25],
      rotationY: Math.PI / 2,
      dimensions: null,
      locked: false,
    },
    {
      id: "item_side_table",
      roomId: "room_living",
      label: "Side table",

      category: "table",

      seats: null,
      origin: "proposed_purchase",
      productId: "prod_fixture_side_table",
      assetUrl: "/models/side_table_01.glb",
      position: [1.1, 0, 0.45],
      rotationY: 0,
      dimensions: null,
      locked: false,
    },
    {
      id: "item_desk",
      roomId: "room_living",
      label: "Desk",

      category: "desk",

      seats: null,
      origin: "existing_owned",
      productId: null,
      assetUrl: null,
      position: [4.4, 0, 4.0],
      rotationY: Math.PI,
      dimensions: [1.2, 0.75, 0.6],
      locked: true,
    },
    {
      id: "item_floor_lamp",
      roomId: "room_living",
      label: "Floor lamp",

      category: "lamp",

      seats: null,
      origin: "existing_owned",
      productId: null,
      assetUrl: null,
      position: [0.4, 0, 0.4],
      rotationY: 0,
      dimensions: [0.35, 1.6, 0.35],
      locked: false,
    },
  ],
  constraints: {
    budget: { amountMinor: 120000, currency: "USD" },
    minimumSeats: 4,
    clearance: 0.3,
  },
};

const r1 = DEMO_PLAN_R1.items;
const item = (id: string) => r1.find((i) => i.id === id)!;

export const DEMO_PLAN_R2: RoomPlan = {
  ...DEMO_PLAN_R1,
  revision: 2,
  items: [
    item("item_sofa"),
    {
      ...item("item_coffee_table"),
      label: "Round coffee table",
      productId: "prod_fixture_round_coffee_table",
      // no model for this product yet, so the viewer draws a sized proxy
      assetUrl: null,
    },
    { ...item("item_lounge_chair"), position: [1.0, 0, 2.6], rotationY: Math.PI / 2 + 0.25 },
    item("item_cabinet"),
    item("item_shelves"),
    item("item_desk"),
    item("item_floor_lamp"),
  ],
  constraints: {
    budget: { amountMinor: 80000, currency: "USD" },
    minimumSeats: 4,
    clearance: 0.3,
  },
};
