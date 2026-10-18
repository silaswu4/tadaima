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
  type: "product_research" | "product_recheck" | "cart_preparation" | "reconstruction";
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

// ---------- cart ----------

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
