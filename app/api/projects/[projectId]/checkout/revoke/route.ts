import { handle } from "@/backend/http";
import { revoke } from "@/backend/checkout/service";

export async function POST(_req: Request, ctx: RouteContext<"/api/projects/[projectId]/checkout/revoke">) {
  const { projectId } = await ctx.params;
  return handle(() => revoke(projectId));
}
