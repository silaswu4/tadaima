import { handle } from "@/backend/http";
import { NotFound } from "@/backend/plan/operations";
import { getResearchJob } from "@/backend/shopping/research";

export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[projectId]/jobs/[jobId]">) {
  const { projectId, jobId } = await ctx.params;
  return handle(async () => {
    const job = await getResearchJob(projectId, jobId);
    if (!job) throw new NotFound(`no job ${jobId}`);
    return job;
  });
}
