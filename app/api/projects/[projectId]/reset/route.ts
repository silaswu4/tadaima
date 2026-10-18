import { handleProject } from "@/backend/http";
import { resetProject } from "@/backend/plan/operations";

/** Demo only: put a fixture project back to its starting plan. */
export async function POST(_req: Request, ctx: RouteContext<"/api/projects/[projectId]/reset">) {
  const { projectId } = await ctx.params;
  return handleProject(_req, projectId, () => resetProject(projectId));
}
