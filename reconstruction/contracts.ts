import type { Evidence, PlacedItem, RoomAppearance, RoomGeometry } from "@/backend/contracts";

/** Input to the local headless worker. Geometry uses wall centerlines in meters. */
export interface ReconstructionRequest {
  jobId: string;
  projectId: string;
  inputRevision: number;
  /** Structurally validated geometry; source accuracy/review status remains upstream. */
  geometry: RoomGeometry;
  appearance?: RoomAppearance;
  /** Optional detected existing furniture, kept separate from structural meshes. */
  items?: PlacedItem[];
  evidence: Evidence[];
}

export interface ReconstructionResult {
  jobId: string;
  projectId: string;
  inputRevision: number;
  generatorVersion: string;
  /** Private storage references, not publicly accessible scan URLs. */
  artifacts: {
    sceneJsonAssetId: string;
    blendAssetId: string;
    glbAssetId: string;
  };
}

export interface ReconstructionProcessor {
  generate(request: ReconstructionRequest): Promise<ReconstructionResult>;
}

export interface ReconstructionArtifactFile {
  assetId: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

/** Local artifact IDs are handles for the backend to upload/map to private storage. */
export interface ReconstructionManifest extends ReconstructionResult {
  schemaVersion: "1.0";
  inputSha256: string;
  /** Exact input file bytes, before normalization; binds local viewer imports. */
  sourceRequestSha256?: string;
  captureRepresentation?: "observed_surface_mesh" | "photo_informed_parametric";
  blenderVersion: string;
  units: "m";
  coordinateSystem: "right-handed-y-up";
  wallAlignment: "centerline";
  floorThicknessMeters: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  files: {
    sceneJson: ReconstructionArtifactFile;
    blend: ReconstructionArtifactFile;
    glb: ReconstructionArtifactFile;
    photoTexturing?: ReconstructionArtifactFile;
    surfaceReconstruction?: ReconstructionArtifactFile;
    visualDesign?: ReconstructionArtifactFile;
    visualDesignInput?: ReconstructionArtifactFile;
  };
  objects: Array<{ id: string; role: "room_floor" | "wall" | "opening" | "existing_furniture" | "captured_surface"; name: string; evidenceIds: string[] }>;
  statistics: { meshCount: number; triangleCount: number; entityCount: number };
  warnings: string[];
  /** Auditable estimated forms/finishes; dimensions and placement remain in scene JSON. */
  visualDesign?: {
    schemaVersion: "room-visual-design-result/1.0";
    mode: "photo_informed_parametric";
    producer: string;
    projectId: string;
    jobId: string;
    inputRevision: number;
    inputSha256: string;
    profileInputSha256: string;
    profileSha256: string;
    sourceArchiveSha256: string;
    reviewRequired: true;
    sources: Array<{ photoId: string; evidenceId: string; sha256: string }>;
    surfaces: Array<{ entityId: string; finish: string; color: string; secondaryColor: string;
      pattern: string; roughness: number; repeatMeters: number; rotationDegrees: number;
      confidence: string; evidenceIds: string[] }>;
    items: Array<{ itemId: string; label: string; model: string; primaryColor: string;
      secondaryColor: string; frameColor: string; accentColor: string; pattern: string;
      seatCount: number; confidence: string; evidenceIds: string[]; notes: string }>;
    notes: string[];
    warnings: string[];
  };
  surfaceReconstruction?: {
    schemaVersion: "roomplan-surface-mesh/1.0";
    mode: "observed_surface_mesh";
    projectId: string;
    jobId: string;
    inputRevision: number;
    inputSha256: string;
    sourceArchiveSha256: string;
    meshSha256: string;
    vertexCount: number;
    triangleCount: number;
    photoCount: number;
    observedTriangleCount: number;
    unobservedTriangleCount: number;
    /** Fraction of captured surface area assigned an observed photo. */
    coverage: number;
    photoSources: Array<{ photoId: string; sha256: string; evidenceId: string }>;
    /** Manifest anchor order, then original face order; -1 means unobserved. */
    triangleSourceIndices: number[];
    triangleOrder: string;
    warnings: string[];
  };
  photoTexturing?: {
    schemaVersion: "roomplan-photo-textures/1.0";
    reviewRequired: true;
    mode: "calibrated_photo_projection";
    sourcePhotoCount: number;
    sourceArchiveSha256: string;
    atlasTexels: number;
    entities: Array<{
      entityId: string;
      role: "room_floor" | "wall" | "existing_furniture";
      status: "captured_photo_covered" | "captured_photo_partial" | "unobserved";
      coverage: number;
      photoIds: string[];
      evidenceIds: string[];
      atlas: string;
      atlasSha256: string;
    }>;
    warnings: string[];
  };
  preview?: { fileName: string; mediaType: string; byteLength: number; sha256: string };
}
