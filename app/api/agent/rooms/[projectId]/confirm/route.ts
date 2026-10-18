import { z } from "zod";
import { agentRoute } from "@/backend/accounts/http";
import { confirmRoom } from "@/backend/accounts/service";

const Body = z.object({
  sender: z.string().min(8),
  ownedItemIds: z.array(z.string()),
  budgetUsd: z.number().positive().max(1_000_000).nullable().default(null),
  minimumSeats: z.number().int().min(0).max(20).nullable().default(null),
  style: z.string().trim().max(80).nullable().default(null),
});

export async function POST(req: Request, ctx: RouteContext<"/api/agent/rooms/[projectId]/confirm">) {
  const { projectId } = await ctx.params;
  return agentRoute(req, async () => {
    const { sender, ...brief } = Body.parse(await req.json());
    return confirmRoom(sender, projectId, brief);
  });
}
