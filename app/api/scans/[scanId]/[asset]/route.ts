import { getScanAsset } from "@/reconstruction/scans.server";

/** scene = draft/scene.json, model = draft/scene.glb from a finished scan. */
export async function GET(request: Request, context: { params: Promise<{ scanId: string; asset: string }> }) {
  const { scanId, asset } = await context.params;
  return getScanAsset(request, scanId, asset);
}
