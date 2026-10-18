import { z } from "zod";
import { handle } from "@/backend/http";
import { applyProposal } from "@/backend/plan/operations";

const Body = z.object({ expectedRevision: z.number().int() });

export async function POST(req: Request, ctx: RouteContext<"/api/projects/[projectId]/proposals/[proposalId]/apply">) {
  const { projectId, proposalId } = await ctx.params;
  return handle(async () => {
    const { expectedRevision } = Body.parse(await req.json());
    return applyProposal(projectId, proposalId, expectedRevision);
  });
}
