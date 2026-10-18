import type { Evidence, ProductCandidate, RoomPlan } from "@/backend/contracts";

/**
 * Synthetic demo living room. Not a real home, not real retailer offers.
 *
 * Room is 5.0 x 4.2 m, origin at the back-left floor corner, x right, z toward
 * the viewer, +Y up. Item `position` is the center of its footprint on the
 * floor; `dimensions` are [width, height, depth] before rotation.
 *
 * The owned sofa and desk are locked. Seats: sofa 3 + armchair 1 = 4, which is
 * exactly the minimum, so any swap has to keep seating intact. New purchases
 * total $1,725 against a $2,000 cap; "make it $300 cheaper" has several valid
 * answers in the catalog below.
 */

const OBSERVED = "2026-10-17T20:00:00Z";
const usd = (dollars: number) => ({ amountMinor: Math.round(dollars * 100), currency: "USD" });

const evidence: Evidence[] = [
  {
    id: "ev_fixture",
    sourceUrl: null,
    privateAssetId: null,
    observedAt: OBSERVED,
    claim: "Synthetic demo room and catalog, hand-written for development",
    dimensionStatus: null,
    confirmedByUserAt: null,
  },
];

const product = (
  p: Omit<ProductCandidate, "merchant" | "variantId" | "observedAt" | "evidenceIds" | "fixture" | "imageUrl" | "sourceUrl"> & {
    slug: string;
  },
): ProductCandidate => {
  const { slug, ...rest } = p;
  return {
    ...rest,
    merchant: "Demo store",
    sourceUrl: `https://example.com/demo-store/${slug}`,
    variantId: null,
    imageUrl: null,
    observedAt: OBSERVED,
    evidenceIds: ["ev_fixture"],
    fixture: true,
  };
};

/** Everything the planner can pick from. The first five are in the starting plan. */
export const demoCatalog: ProductCandidate[] = [
  product({ id: "prod_armchair_oak", slug: "oak-armchair", category: "chair", label: "Oak frame armchair, oat", dimensions: [0.8, 0.8, 0.85], seats: 1, price: usd(649), availability: "available" }),
  product({ id: "prod_table_walnut", slug: "walnut-coffee-table", category: "table", label: "Walnut coffee table", dimensions: [1.1, 0.45, 0.6], seats: null, price: usd(299), availability: "available" }),
  product({ id: "prod_rug_wool", slug: "wool-rug-6x9", category: "rug", label: "Flatweave wool rug, 2 x 1.4 m", dimensions: [2.0, 0.01, 1.4], seats: null, price: usd(249), availability: "available" }),
  product({ id: "prod_lamp_arc", slug: "linen-floor-lamp", category: "lamp", label: "Linen shade floor lamp", dimensions: [0.35, 1.6, 0.35], seats: null, price: usd(129), availability: "available" }),
  product({ id: "prod_shelf_tall", slug: "tall-bookshelf", category: "storage", label: "Tall open bookshelf", dimensions: [0.8, 1.8, 0.3], seats: null, price: usd(399), availability: "available" }),

  product({ id: "prod_armchair_cane", slug: "cane-armchair", category: "chair", label: "Cane back armchair", dimensions: [0.72, 0.78, 0.78], seats: 1, price: usd(349), availability: "available" }),
  product({ id: "prod_armchair_boucle", slug: "boucle-armchair", category: "chair", label: "Boucle lounge chair", dimensions: [0.9, 0.75, 0.88], seats: 1, price: usd(899), availability: "available" }),
  product({ id: "prod_loveseat", slug: "compact-loveseat", category: "sofa", label: "Compact two-seat loveseat", dimensions: [1.45, 0.82, 0.85], seats: 2, price: usd(799), availability: "available" }),
  product({ id: "prod_table_round", slug: "round-coffee-table", category: "table", label: "Round pine coffee table", dimensions: [0.8, 0.42, 0.8], seats: null, price: usd(149), availability: "available" }),
  product({ id: "prod_table_marble", slug: "marble-coffee-table", category: "table", label: "Marble top coffee table", dimensions: [1.2, 0.4, 0.65], seats: null, price: usd(449), availability: "unavailable" }),
  product({ id: "prod_rug_jute", slug: "jute-rug", category: "rug", label: "Jute rug, 2 x 1.4 m", dimensions: [2.0, 0.01, 1.4], seats: null, price: usd(129), availability: "available" }),
  product({ id: "prod_lamp_tripod", slug: "tripod-floor-lamp", category: "lamp", label: "Tripod floor lamp", dimensions: [0.45, 1.5, 0.45], seats: null, price: usd(59), availability: "available" }),
  product({ id: "prod_shelf_low", slug: "low-bookshelf", category: "storage", label: "Low two-shelf bookcase", dimensions: [0.8, 0.9, 0.3], seats: null, price: usd(199), availability: "available" }),
  // dimensions not established: the validator must refuse to call this a fit
  product({ id: "prod_ottoman_mystery", slug: "pouf-ottoman", category: "chair", label: "Knit pouf (dimensions not listed)", dimensions: null, seats: 1, price: usd(89), availability: "available" }),
];

const catalogItem = (id: string) => demoCatalog.find((p) => p.id === id)!;

export const demoPlan: RoomPlan = {
  schemaVersion: "0.2",
  projectId: "proj_demo",
  revision: 1,
  geometry: {
    units: "m",
    coordinateSystem: "right-handed-y-up",
    rooms: [
      {
        id: "room_living",
        label: "Living room",
        floorPolygon: [
          [0, 0],
          [5.0, 0],
          [5.0, 4.2],
          [0, 4.2],
        ],
        height: 2.7,
        evidenceIds: ["ev_fixture"],
      },
    ],
    walls: [
      { id: "wall_back", start: [0, 0], end: [5.0, 0], height: 2.7, thickness: 0.12, evidenceIds: ["ev_fixture"] },
      { id: "wall_right", start: [5.0, 0], end: [5.0, 4.2], height: 2.7, thickness: 0.12, evidenceIds: ["ev_fixture"] },
      { id: "wall_front", start: [5.0, 4.2], end: [0, 4.2], height: 2.7, thickness: 0.12, evidenceIds: ["ev_fixture"] },
      { id: "wall_left", start: [0, 4.2], end: [0, 0], height: 2.7, thickness: 0.12, evidenceIds: ["ev_fixture"] },
    ],
    openings: [
      { id: "open_window", wallId: "wall_back", kind: "window", offset: 2.2, width: 1.6, height: 1.3, sillHeight: 0.9, evidenceIds: ["ev_fixture"] },
      { id: "open_door", wallId: "wall_left", kind: "door", offset: 0.6, width: 0.9, height: 2.05, sillHeight: 0, evidenceIds: ["ev_fixture"] },
    ],
  },
  evidence,
  items: [
    // owned and locked
    { id: "item_sofa", roomId: "room_living", label: "Your sofa", category: "sofa", origin: "existing_owned", productId: null, assetUrl: null, position: [2.5, 0, 3.7], rotationY: Math.PI, dimensions: [2.1, 0.85, 0.95], seats: 3, locked: true },
    { id: "item_desk", roomId: "room_living", label: "Your desk", category: "desk", origin: "existing_owned", productId: null, assetUrl: null, position: [1.0, 0, 0.32], rotationY: 0, dimensions: [1.2, 0.75, 0.6], seats: null, locked: true },
    // proposed purchases
    ...(
      [
        ["item_armchair", "prod_armchair_oak", [4.2, 0, 2.4], -Math.PI / 2],
        ["item_coffee_table", "prod_table_walnut", [2.5, 0, 2.6], 0],
        ["item_rug", "prod_rug_wool", [2.5, 0, 2.7], 0],
        ["item_lamp", "prod_lamp_arc", [0.4, 0, 3.8], 0],
        ["item_shelf", "prod_shelf_tall", [4.5, 0, 0.17], 0],
      ] as const
    ).map(([id, productId, position, rotationY]) => {
      const p = catalogItem(productId);
      return {
        id,
        roomId: "room_living",
        label: p.label,
        category: p.category,
        origin: "proposed_purchase" as const,
        productId,
        assetUrl: null,
        position,
        rotationY,
        dimensions: p.dimensions,
        seats: p.seats,
        locked: false,
      };
    }),
  ],
  products: demoCatalog,
  constraints: {
    budget: usd(2000),
    minimumSeats: 4,
    clearance: 0.3,
  },
};
