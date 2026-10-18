import { z } from "zod";
import { agentRoute } from "@/backend/accounts/http";
import { recordChatPayment } from "@/backend/checkout/service";

const Body = z.object({ sessionId: z.string().regex(/^cs_test_[A-Za-z0-9]+$/) });

/** The agent reports a Stripe Checkout session the shopper paid in ASI:One; the server verifies it with Stripe before recording the order. */
export async function POST(req: Request, ctx: RouteContext<"/api/agent/rooms/[projectId]/orders">) {
  const { projectId } = await ctx.params;
  return agentRoute(req, async () => {
    const { sessionId } = Body.parse(await req.json());
    return recordChatPayment(projectId, sessionId);
  });
}
