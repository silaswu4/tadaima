import { z } from "zod";
import { handleProject } from "@/backend/http";
import { storeItem } from "@/backend/shopping/shop";

const Body = z.object({
  /** Required to put away a locked piece; it stays locked. */
  unlock: z.boolean().optional(),
  expectedRevision: z.number().int().nullable().optional(),
});

/** Put a piece away in inventory. Bring it back with move-to. */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[projectId]/items/[itemId]/store">) {
  const { projectId, itemId } = await ctx.params;
  return handleProject(req, projectId, async () => storeItem(projectId, { itemId, ...Body.parse(await req.json().catch(() => ({}))) }));
}
