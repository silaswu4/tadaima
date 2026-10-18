import { z } from "zod";
import { handleProject } from "@/backend/http";
import { startResearch } from "@/backend/shopping/research";

const Body = z.object({
  itemId: z.string(),
  request: z.string().max(300).nullable().optional(),
  merchant: z.enum(["IKEA", "Target"]).optional(),
});

/** Starts room-aware product research for one item. Poll /jobs/{id} for results. */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[projectId]/research">) {
  const { projectId } = await ctx.params;
  return handleProject(req, projectId, async () => startResearch(projectId, Body.parse(await req.json())));
}
