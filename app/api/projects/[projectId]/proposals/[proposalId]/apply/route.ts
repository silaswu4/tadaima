import { z } from "zod";
import { handleProject } from "@/backend/http";
import { applyProposal } from "@/backend/plan/operations";

const Body = z.object({ expectedRevision: z.number().int() });

export async function POST(req: Request, ctx: RouteContext<"/api/projects/[projectId]/proposals/[proposalId]/apply">) {
  const { projectId, proposalId } = await ctx.params;
  return handleProject(req, projectId, async () => {
    const { expectedRevision } = Body.parse(await req.json());
    return applyProposal(projectId, proposalId, expectedRevision);
  });
}
