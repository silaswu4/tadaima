import { agentRoute } from "@/backend/accounts/http";
import { NotFound } from "@/backend/plan/operations";
import { getAgentResearchJob } from "@/backend/research/agentResearch";

export async function GET(req: Request, ctx: RouteContext<"/api/agent/research/[jobId]">) {
  const { jobId } = await ctx.params;
  return agentRoute(req, async () => {
    const job = await getAgentResearchJob(jobId);
    if (!job) throw new NotFound(`no job ${jobId}`);
    return job;
  });
}
