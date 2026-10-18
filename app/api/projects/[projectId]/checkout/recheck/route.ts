import { handle } from "@/backend/http";
import { runRecheck } from "@/backend/checkout/service";

/** Re-reads live price and stock for every cart line. Changed prices update the plan. */
export async function POST(_req: Request, ctx: RouteContext<"/api/projects/[projectId]/checkout/recheck">) {
  const { projectId } = await ctx.params;
  return handle(() => runRecheck(projectId));
}
