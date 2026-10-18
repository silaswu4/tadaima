import { getScan } from "@/reconstruction/scans.server";

export async function GET(request: Request, context: { params: Promise<{ scanId: string }> }) {
  return getScan(request, (await context.params).scanId);
}
