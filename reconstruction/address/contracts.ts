import type { ReconstructionRequest } from "../contracts";

/** Private worker input. The backend supplies authenticated project/job identity. */
export interface AddressResearchRequest extends Pick<ReconstructionRequest, "projectId" | "jobId" | "inputRevision"> {
  address: string;
  unit?: string | null;
  listingUrls?: string[];
  targetRoom?: string;
}

/** Internal receipt, never return filesystem paths/source text to public clients. */
export interface AddressResearchReceipt extends Pick<ReconstructionRequest, "projectId" | "jobId" | "inputRevision"> {
  schemaVersion: "address-research/1.0";
  status: "evidence_collected" | "needs_evidence" | "needs_review" | "draft_ready";
  reviewRequired: true;
  sourceCount: number;
  downloadedAssetCount: number;
  dossierPath: string;
  reconstructionRequestPath: string | null;
  draftManifestPath: string | null;
  /** Explicitly distinguish file handoff verification from hosted provider calls. */
  execution?: {
    research: "discovery_file" | "research_provider";
    geometry: "not_requested" | "file_handoff" | "geometry_provider";
    declaredProducer: string | null;
  };
}

export interface AddressResearchProcessor {
  research(request: AddressResearchRequest): Promise<AddressResearchReceipt>;
}
