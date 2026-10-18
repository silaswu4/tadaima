import { handleProject } from "@/backend/http";
import { execute } from "@/backend/checkout/service";

/** The agent pays, within the active mandate only. Refused (409) if the cart changed or nothing is approved. */
export async function POST(_req: Request, ctx: RouteContext<"/api/projects/[projectId]/checkout/execute">) {
  const { projectId } = await ctx.params;
  return handleProject(_req, projectId, () => execute(projectId));
}
