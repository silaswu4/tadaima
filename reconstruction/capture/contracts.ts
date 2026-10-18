import type { ReconstructionRequest } from "../contracts";

export type CaptureWall = "a" | "b" | "c" | "d";
export interface CaptureMeasurement {
  valueMeters: number;
  method: "tape" | "laser" | "estimate";
  observedAt: string;
}
export interface CapturePhoto {
  id: string;
  fileName: string;
  sha256: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
  wall: CaptureWall | "overview";
  capturedAt: string;
  /** Browser observations; neither measurements nor proof of image sharpness. */
  quality: { meanLuminance: number; edgeEnergy: number };
}
export interface CaptureOpening {
  id: string;
  wall: CaptureWall;
  kind: "door" | "window";
  /** Clear distance from the inside corner, following A→B→C→D. */
  offset: CaptureMeasurement;
  width: CaptureMeasurement;
  height: CaptureMeasurement;
  sillHeight: CaptureMeasurement;
}
/** Capture metadata, not a second room geometry schema. All units are meters. */
export interface MobileCaptureManifest
  extends Pick<ReconstructionRequest, "jobId" | "projectId" | "inputRevision"> {
  schemaVersion: "mobile-capture/1.0";
  capturedAt: string;
  captureMode: "guided_photos" | "manual";
  room: {
    id: string;
    label: string;
    shape: "rectangle";
    clearWidth: CaptureMeasurement | null;
    clearDepth: CaptureMeasurement | null;
    height: CaptureMeasurement | null;
    wallThickness: CaptureMeasurement | null;
    confirmedRectangularAt: string | null;
  };
  photos: CapturePhoto[];
  openings: CaptureOpening[];
}
