import type { RoomPlan } from "../../backend/contracts";
import { makeWorkspaceDemo } from "./workspace-fixture";

/** Manually inspected public gallery photo; this is not verified unit 314. */
export function makePhotoReferencePlan(): RoomPlan {
  const plan = makeWorkspaceDemo();
  const evidenceId = "atrium-livingroom-photo";
  plan.evidence.push({
    id: evidenceId,
    sourceUrl: "https://www.atrium-westwood.com/wp-content/uploads/2025/08/rwselby-atrium-livingroom2.jpg",
    privateAssetId: null, observedAt: "2026-10-18T00:00:00Z",
    claim: "Building gallery living-room reference: warm taupe walls and muted dark wood-look planks. Exact unit and finish specification are unverified.",
    dimensionStatus: null, confirmedByUserAt: null,
  });
  plan.appearance = {
    schemaVersion: "room-appearance/1.0", reviewRequired: true, scope: "building_reference",
    sources: [{ evidenceId, sha256: "3305fde1b8d250fe1dc50f9231917c0a31ee6e0e0388436b1f3c5d23f16b765a" }],
    surfaces: [
      { entityId: "living-room", finish: "wood", color: "#b4afa8", roughness: .72,
        tileMeters: 1.2, rotationDegrees: 90, confidence: "medium", evidenceIds: [evidenceId] },
      ...plan.geometry.walls.map(({ id }) => ({
        entityId: id, finish: "paint" as const, color: "#c5c1b7", roughness: .92,
        tileMeters: 1, rotationDegrees: 0, confidence: "medium" as const, evidenceIds: [evidenceId],
      })),
    ],
    notes: [
      "Finishes estimated by inspecting the public living-room photo; geometry and furniture remain the sample room.",
      "Wood grain is a licensed oak proxy, not an extracted texture or verified product. Color, roughness and grain orientation need review.",
      "The gallery is not confirmed as unit 314. Window daylight follows the displayed geometry, with no known compass heading or sun position.",
    ],
  };
  return plan;
}
