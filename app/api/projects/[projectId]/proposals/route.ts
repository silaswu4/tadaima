import { z } from "zod";
import { handle } from "@/backend/http";
import { proposePlanChange } from "@/backend/plan/operations";

const Body = z.object({ intent: z.string().min(1).max(500), selectedItemId: z.string().nullable().default(null) });

export async function POST(req: Request, ctx: RouteContext<"/api/projects/[projectId]/proposals">) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const { intent, selectedItemId } = Body.parse(await req.json());
    return proposePlanChange(projectId, intent, selectedItemId);
  });
}
