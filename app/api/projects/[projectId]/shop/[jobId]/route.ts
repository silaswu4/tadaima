import { handleProject } from "@/backend/http";
import { getShopJob } from "@/backend/shopping/shop";

/** A shopping job, with every result re-checked against the room as it is now. */
export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[projectId]/shop/[jobId]">) {
  const { projectId, jobId } = await ctx.params;
  return handleProject(_req, projectId, () => getShopJob(projectId, jobId));
}
