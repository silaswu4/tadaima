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
  };
  objects: Array<{ id: string; role: "room_floor" | "wall" | "opening" | "existing_furniture"; name: string; evidenceIds: string[] }>;
  statistics: { meshCount: number; triangleCount: number; entityCount: number };
  warnings: string[];
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
