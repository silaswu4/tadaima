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

export interface ProductCandidate {
  id: string;
  merchant: string;
  sourceUrl: string;
  variantId: string | null;
  label: string;
  /** Width, height, depth. Null means dimensions are not yet established. */
  dimensions: Vector3Meters | null;
  price: Money | null;
  availability: "available" | "unavailable" | "unknown";
  observedAt: string;
  evidenceIds: string[];
}

export interface PlacedItem {
  id: string;
  roomId: string;
  label: string;
  origin: "existing_owned" | "proposed_purchase";
  productId: string | null;
  assetUrl: string | null;
  position: Vector3Meters;
  rotationY: number;
  dimensions: Vector3Meters | null;
  locked: boolean;
}

export interface RoomPlan {
  schemaVersion: "0.1-scaffold";
  projectId: string;
  revision: number;
  geometry: RoomGeometry;
  evidence: Evidence[];
  items: PlacedItem[];
  products: ProductCandidate[];
  constraints: {
    budget: Money | null;
    minimumSeats: number | null;
  };
}
