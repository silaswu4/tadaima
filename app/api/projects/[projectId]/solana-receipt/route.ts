import { handleProject } from "@/backend/http";
import { getProject } from "@/backend/plan/operations";
import { ReceiptUnavailable, recordApproval } from "@/backend/solana/receipt";

/** Record the approved basket for this room revision on Solana devnet (memo receipt). */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[projectId]/solana-receipt">) {
  const { projectId } = await ctx.params;
  return handleProject(req, projectId, async () => {
    try { return await recordApproval((await getProject(projectId)).plan); }
    catch (error) {
      if (error instanceof ReceiptUnavailable) return Response.json({ error: error.message }, { status: 503 });
      throw error;
    }
  });
}
