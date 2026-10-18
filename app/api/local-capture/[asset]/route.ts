import "server-only";
import { localPreviewResponse } from "@/reconstruction/local-preview";

export async function GET(request: Request, context: { params: Promise<{ asset: string }> }) {
  return localPreviewResponse(request, (await context.params).asset);
}
