import { handleProject } from "@/backend/http";
import { getCheckout } from "@/backend/checkout/service";

/** Cart derived from the plan, latest recheck, connected cards, active approval, orders, and what blocks approval. */
export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[projectId]/checkout">) {
  const { projectId } = await ctx.params;
  return handleProject(_req, projectId, () => getCheckout(projectId));
}
