import { handleProject } from "@/backend/http";
import { getProject } from "@/backend/plan/operations";

export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[projectId]">) {
  const { projectId } = await ctx.params;
  return handleProject(_req, projectId, () => getProject(projectId));
}
