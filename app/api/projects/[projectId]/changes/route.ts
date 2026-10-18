import { z } from "zod";
import { handleProject, PlanChangeSchema } from "@/backend/http";
import { applyPlanChanges } from "@/backend/plan/operations";

const Body = z.object({ expectedRevision: z.number().int(), changes: z.array(PlanChangeSchema).min(1) });

export async function POST(req: Request, ctx: RouteContext<"/api/projects/[projectId]/changes">) {
  const { projectId } = await ctx.params;
  return handleProject(req, projectId, async () => {
    const { expectedRevision, changes } = Body.parse(await req.json());
    return applyPlanChanges(projectId, expectedRevision, changes);
  });
}
