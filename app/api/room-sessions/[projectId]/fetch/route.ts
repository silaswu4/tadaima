import { handle } from "@/backend/http";
import { createFetchPairing, fetchPairingStatus, revokeFetchPairing } from "@/backend/session/fetch";

type Context = { params: Promise<{ projectId: string }> };
export async function GET(req: Request, ctx: Context) {
  const { projectId } = await ctx.params;
  return handle(() => fetchPairingStatus(req, projectId));
}
export async function POST(req: Request, ctx: Context) {
  const { projectId } = await ctx.params;
  return handle(() => createFetchPairing(req, projectId));
}
export async function DELETE(req: Request, ctx: Context) {
  const { projectId } = await ctx.params;
  return handle(() => revokeFetchPairing(req, projectId));
}
