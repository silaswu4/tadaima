import { z } from "zod";
import { FloorSpotSchema, handleProject } from "@/backend/http";
import { moveItemTo } from "@/backend/shopping/shop";

const Body = z.object({
  spot: FloorSpotSchema,
  /** Required to move a locked piece; it's locked again where it lands. */
  unlock: z.boolean().optional(),
  expectedRevision: z.number().int().nullable().optional(),
});

/** Move a piece to a spot, re-placed so it fits. */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[projectId]/items/[itemId]/move-to">) {
  const { projectId, itemId } = await ctx.params;
  return handleProject(req, projectId, async () => moveItemTo(projectId, { itemId, ...Body.parse(await req.json()) }));
}
