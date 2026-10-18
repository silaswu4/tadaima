import type { Evidence, RoomGeometry } from "@/backend/contracts";

/** Adapter boundary for a future server-side worker, not an implementation. */
export interface ReconstructionRequest {
  jobId: string;
  projectId: string;
  inputRevision: number;
  /** Only confirmed/validated geometry should reach scene generation. */
  geometry: RoomGeometry;
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
