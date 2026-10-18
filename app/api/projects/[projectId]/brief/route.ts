import { z } from "zod";
import { handleProject } from "@/backend/http";
import { getProject } from "@/backend/plan/operations";
import { shoppingBrief } from "@/backend/shopping/roomBrief";

/** What the shopping agent knows about a spot: free space, budget left, seats needed. ?itemId= */
export async function GET(req: Request, ctx: RouteContext<"/api/projects/[projectId]/brief">) {
  const { projectId } = await ctx.params;
  return handleProject(req, projectId, async () => {
    const itemId = z.string().parse(new URL(req.url).searchParams.get("itemId"));
    const { plan } = await getProject(projectId);
    return shoppingBrief(plan, { itemId });
  });
}
