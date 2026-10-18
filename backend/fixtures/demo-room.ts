import type { Evidence, ProductCandidate, RoomPlan } from "@/backend/contracts";
import realCatalogFile from "@/backend/fixtures/real-catalog.json";
import { assetUrlFor } from "@/backend/shopping/assets";

/**
 * Synthetic demo living room (not a real home) furnished from real IKEA
 * products observed by Browser Use.
 *
 * Room is 5.0 x 4.2 m, origin at the back-left floor corner, x right, z toward
 * the viewer, +Y up. Item `position` is the center of its footprint on the
 * floor; `dimensions` are [width, height, depth] before rotation.
 *
 * The owned sofa and desk are locked. Seats: sofa 3 + armchair 1 = 4, which is
 * exactly the minimum, so any swap has to keep seating intact. New purchases
 * total $1,397.97 against a $1,500 cap; "make it $300 cheaper" has several
 * valid answers in the catalog.
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

/** Synthetic catalog, kept for tests that need hand-controlled products. */
export const syntheticCatalog: ProductCandidate[] = [
  product({ id: "prod_armchair_oak", slug: "oak-armchair", category: "chair", label: "Oak frame armchair, oat", dimensions: [0.8, 0.8, 0.85], seats: 1, price: usd(649), availability: "available" }),
  product({ id: "prod_armchair_cane", slug: "cane-armchair", category: "chair", label: "Cane back armchair", dimensions: [0.72, 0.78, 0.78], seats: 1, price: usd(349), availability: "available" }),
  product({ id: "prod_table_marble", slug: "marble-coffee-table", category: "table", label: "Marble top coffee table", dimensions: [1.2, 0.4, 0.65], seats: null, price: usd(449), availability: "unavailable" }),
  // dimensions not established: the validator must refuse to call this a fit
  product({ id: "prod_ottoman_mystery", slug: "pouf-ottoman", category: "chair", label: "Knit pouf (dimensions not listed)", dimensions: null, seats: 1, price: usd(89), availability: "available" }),
];

/**
 * Real IKEA and Target observations from Browser Use (see backend/research).
 * Prices and stock were true when observed; recheck before building a cart.
 */
const realFile = realCatalogFile as { products: ProductCandidate[]; evidence: Evidence[] };
export const realCatalog: ProductCandidate[] = realFile.products;
const realEvidence: Evidence[] = realFile.evidence;

/** What the demo plan's planner can pick from. */
export const demoCatalog: ProductCandidate[] = realCatalog;

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
  evidence: [...evidence, ...realEvidence],
  items: [
    // owned and locked
    { id: "item_sofa", roomId: "room_living", label: "Your sofa", category: "sofa", origin: "existing_owned", productId: null, assetUrl: assetUrlFor("sofa", [2.1, 0.85, 0.95]), position: [2.5, 0, 3.7], rotationY: Math.PI, dimensions: [2.1, 0.85, 0.95], seats: 3, locked: true },
    { id: "item_desk", roomId: "room_living", label: "Your desk", category: "desk", origin: "existing_owned", productId: null, assetUrl: null, position: [1.0, 0, 0.32], rotationY: 0, dimensions: [1.2, 0.75, 0.6], seats: null, locked: true },
    // proposed purchases
    ...(
      [
        ["item_armchair", "prod_ikea_stockholm-2025-armchair-djurmo-gray-white-405947", [4.2, 0, 2.4], -Math.PI / 2],
        ["item_coffee_table", "prod_ikea_tonstad-coffee-table-oak-veneer-10489311", [2.5, 0, 2.5], 0],
        ["item_rug", "prod_ikea_lohals-rug-flatwoven-natural-30511288", [2.5, 0, 2.6], Math.PI / 2],
        ["item_lamp", "prod_ikea_simrishamn-floor-lamp-chrome-plated-opal-glass-5", [0.4, 0, 3.8], 0],
        ["item_shelf", "prod_ikea_hemnes-bookcase-white-stain-light-brown-60413502", [4.5, 0, 0.2], 0],
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
        assetUrl: assetUrlFor(p.category, p.dimensions),
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
    budget: usd(1500),
    minimumSeats: 4,
    clearance: 0.3,
  },
};
