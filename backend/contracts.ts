/**
 * Shared, browser-safe starting contracts. No runtime validation or services.
 * Owner: Matthew. Coordinate changes with all consumers.
 * Geometry is in meters, right-handed with +Y up; rotations use radians.
 */
export type PointXZ = readonly [x: number, z: number];
export type Vector3Meters = readonly [x: number, y: number, z: number];

export interface Money {
  /** Integer minor units, such as cents. Validate at the application boundary. */
  amountMinor: number;
  currency: string;
}

export interface Evidence {
  id: string;
  sourceUrl: string | null;
  privateAssetId: string | null;
  observedAt: string;
  claim: string;
  dimensionStatus: "measured" | "source_dimension" | "inferred" | null;
  confirmedByUserAt: string | null;
}

export interface RoomGeometry {
  units: "m";
  coordinateSystem: "right-handed-y-up";
  rooms: Array<{
    id: string;
    label: string;
    floorPolygon: PointXZ[];
    height: number;
    evidenceIds: string[];
  }>;
  walls: Array<{
    id: string;
    start: PointXZ;
    end: PointXZ;
    height: number;
    thickness: number;
    evidenceIds: string[];
  }>;
  openings: Array<{
    id: string;
    wallId: string;
    kind: "door" | "window";
    offset: number;
    width: number;
    height: number;
    sillHeight: number;
    evidenceIds: string[];
  }>;
}

/** What a piece of furniture is for. Drives seat counting and swap matching. */
export type FurnitureCategory =
  | "sofa"
  | "chair"
  | "table"
  | "desk"
  | "storage"
  | "bed"
  | "rug"
  | "lamp"
  | "decor"
  | "other";

export interface ProductCandidate {
  id: string;
  category: FurnitureCategory;
  merchant: string;
  sourceUrl: string;
  variantId: string | null;
  label: string;
  /** Width, height, depth. Null means dimensions are not yet established. */
  dimensions: Vector3Meters | null;
  /** People it seats. Null for non-seating or unknown. */
  seats: number | null;
  price: Money | null;
  availability: "available" | "unavailable" | "unknown";
  imageUrl: string | null;
  observedAt: string;
  evidenceIds: string[];
  /** True for hand-written demo data, false for something a research run actually observed. */
  fixture: boolean;
}

export interface PlacedItem {
  id: string;
  roomId: string;
  label: string;
  category: FurnitureCategory;
  origin: "existing_owned" | "proposed_purchase";
  productId: string | null;
  assetUrl: string | null;
  position: Vector3Meters;
  rotationY: number;
  dimensions: Vector3Meters | null;
  seats: number | null;
  locked: boolean;
}

export interface RoomPlan {
  schemaVersion: "0.2";
  projectId: string;
  revision: number;
  geometry: RoomGeometry;
  evidence: Evidence[];
  items: PlacedItem[];
  products: ProductCandidate[];
  constraints: {
    /** Cap on new purchases only. Items the user already owns cost nothing. */
    budget: Money | null;
    minimumSeats: number | null;
    /** Free floor space kept around each item, meters. */
    clearance: number;
  };
}

// ---------- plan changes ----------

export type PlanChange =
  | { kind: "add"; item: PlacedItem }
  | { kind: "remove"; itemId: string }
  | { kind: "replace"; itemId: string; productId: string }
  | { kind: "move"; itemId: string; position: Vector3Meters; rotationY: number }
  | { kind: "lock"; itemId: string; locked: boolean }
  /** Add researched products to the plan's catalog. Changes no furniture. */
  | { kind: "add_products"; products: ProductCandidate[]; evidence: Evidence[] }
  | { kind: "set_constraints"; constraints: Partial<RoomPlan["constraints"]> };

export interface ValidationResult {
  rule: "in_room" | "no_overlap" | "locked_kept" | "budget" | "seats" | "dimensions_known" | "product_known";
  status: "pass" | "fail" | "unknown";
  itemIds: string[];
  message: string;
}

export interface CostSummary {
  /** Sum of proposed purchases with a known price. */
  knownSubtotal: Money;
  /** Proposed purchases whose price is not established. */
  unknownPriceItemIds: string[];
  /** Shipping, tax and assembly stay unknown until a cart is observed. */
  feesKnown: false;
}

export interface PlanProposal {
  id: string;
  projectId: string;
  baseRevision: number;
  /** What was asked, as typed or spoken. */
  intent: string;
  changes: PlanChange[];
  /** The plan as it would look if applied. Not canonical until applied. */
  result: RoomPlan;
  validations: ValidationResult[];
  costBefore: CostSummary;
  costAfter: CostSummary;
  /** Short human explanation of what changed and why. */
  summary: string;
  createdAt: string;
}

export type ApplyResult =
  | { ok: true; plan: RoomPlan }
  | { ok: false; reason: "stale_revision"; currentRevision: number }
  | { ok: false; reason: "validation_failed"; validations: ValidationResult[] };

// ---------- async jobs ----------

export type JobState = "queued" | "running" | "needs_input" | "succeeded" | "failed" | "cancelled";

export interface Job<Output = unknown> {
  id: string;
  projectId: string;
  type: "product_research" | "shop_at_spot" | "product_recheck" | "cart_preparation" | "reconstruction";
  state: JobState;
  /** Human stage label, e.g. "Checking IKEA for sofas under $900". */
  stage: string;
  inputRevision: number;
  output: Output | null;
  /** Sanitized; never contains credentials or live session urls. */
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Output of a product_research job. */
export interface ResearchJobOutput {
  /** The room facts the search was built from. */
  brief: string;
  itemId: string;
  merchant: string;
  /** Every product found, with whether it fits the room as it is now. */
  results: Array<{ product: ProductCandidate; fits: boolean; problems: string[] }>;
  /** Products that fit were added to the plan at this revision. */
  addedAtRevision: number | null;
  costUsd: number | null;
}

/** A point on the floor the shopper is looking at or tapped. y is ignored. */
export interface FloorSpot {
  position: Vector3Meters;
  /** Facing to use instead of the automatic one (back to the nearest wall, front into the room). */
  rotationY?: number | null;
  roomId?: string | null;
}

/** Where a piece would go for a spot: always passes in_room and no_overlap for the plan it was computed on. */
export interface Placement {
  roomId: string;
  position: Vector3Meters;
  rotationY: number;
  /** Distance from the picked point to where the piece's center landed. */
  distanceM: number;
  againstWallId: string | null;
}

export interface ShopRequest {
  category: FurnitureCategory;
  spot: FloorSpot;
  /** The shopper's own price cap ("under $300"). The plan's budget is checked separately. */
  maxPriceUsd?: number | null;
  /** Style words in the shopper's own terms, e.g. "gray, mid-century". */
  request?: string | null;
  merchant?: "IKEA" | "Target";
  /** Also browse the store live (minutes). False returns catalog matches only. Default true. */
  live?: boolean;
}

export interface ShopResult {
  product: ProductCandidate;
  /** Already in our catalog, or found by this search's live browse. */
  source: "catalog" | "live";
  /** Fits at the spot (or slid nearby) as the room is right now. */
  fits: boolean;
  placement: Placement | null;
  /** Why it doesn't fit, or where it would go instead. */
  problems: string[];
  /** Whether adding it keeps new purchases within the plan's budget. Null when there's no budget or no price. */
  withinBudget: boolean | null;
  overBudgetUsd: number | null;
  /** Library 3D model for the viewer; scale it to product.dimensions (see backend/shopping/assets.ts). */
  assetUrl: string | null;
}

/** Output of a shop_at_spot job. Results are re-checked against the live plan each time the job is read. */
export interface ShopJobOutput {
  request: ShopRequest;
  /** The room facts the live search was built from. */
  brief: string;
  /** Best first: fits, then within budget, then style match, then price. */
  results: ShopResult[];
  live: "running" | "done" | "failed" | "skipped";
  addedAtRevision: number | null;
  costUsd: number | null;
  /** Plan revision the results were checked against. */
  checkedAtRevision: number;
}

export type PlaceResult =
  | { ok: true; plan: RoomPlan; itemId: string; placement: Placement }
  | { ok: false; reason: "no_fit"; message: string; nearest: Placement | null }
  | { ok: false; reason: "locked"; message: string }
  | { ok: false; reason: "stale_revision"; currentRevision: number }
  | { ok: false; reason: "validation_failed"; validations: ValidationResult[] };

// ---------- cart and checkout ----------

/** The basket derived from the plan's proposed purchases. `digest` fingerprints exactly what would be paid for. */
export interface Cart {
  projectId: string;
  planRevision: number;
  merchants: Array<{ merchant: string; lines: CartLine[]; subtotal: Money }>;
  subtotal: Money;
  /** Lines whose price isn't established; they block checkout. */
  unpricedProductIds: string[];
  unknownCosts: Array<"shipping" | "tax" | "assembly">;
  digest: string;
}

export interface RecheckLine {
  productId: string;
  label: string;
  status: "ok" | "price_changed" | "unavailable" | "unverified";
  catalogPrice: Money | null;
  observedPrice: Money | null;
  note: string | null;
}

export interface Recheck {
  projectId: string;
  /** Cart digest this recheck was run against. */
  cartDigest: string;
  lines: RecheckLine[];
  allOk: boolean;
  checkedAt: string;
}

export interface PaymentMethod {
  id: string;
  provider: "stripe_test";
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** What the shopper approved. The agent can spend within it and nothing else. */
export interface Mandate {
  id: string;
  projectId: string;
  cartDigest: string;
  maxAmount: Money;
  merchants: string[];
  paymentMethodId: string;
  approvedAt: string;
  expiresAt: string;
  status: "active" | "used" | "revoked";
}

export interface Order {
  id: string;
  projectId: string;
  mandateId: string;
  cartDigest: string;
  lines: CartLine[];
  amount: Money;
  payment: { provider: "stripe_test"; paymentIntentId: string; status: "succeeded" | "failed"; card: string };
  /** Retailer orders are simulated in this build; nothing is placed with IKEA or Target. */
  merchantOrders: Array<{ merchant: string; status: "simulated"; note: string }>;
  testMode: true;
  createdAt: string;
}

// ---------- merchant cart preparation ----------

export interface CartLine {
  productId: string;
  variantId: string | null;
  label: string;
  quantity: number;
  /** Price the cart showed, which can differ from the research observation. */
  observedPrice: Money | null;
}

export interface CartReview {
  id: string;
  projectId: string;
  planRevision: number;
  merchant: string;
  status: "prepared" | "needs_login" | "blocked" | "failed";
  lines: CartLine[];
  /** Merchant cart page the user finishes checkout on. No session tokens. */
  checkoutUrl: string | null;
  unknownCosts: Array<"shipping" | "tax" | "assembly">;
  checkedAt: string;
}
