/** Browser-safe Fetch pairing transport. No provider credentials or source media. */
import type { FloorSpot, Job, PlanProposal, ShopJobOutput } from "../contracts";

export type FetchPreview = { id: string; productId: string; spot: FloorSpot; jobId: string; revision: number };
export type FetchRoomStatus = {
  status: "disconnected" | "waiting" | "connected";
  expiresAt: number | null;
  sender: string | null;
  proposal: PlanProposal | null;
  job: Job<ShopJobOutput> | null;
  preview: FetchPreview | null;
};
export type FetchPairing = FetchRoomStatus & { code: string };
