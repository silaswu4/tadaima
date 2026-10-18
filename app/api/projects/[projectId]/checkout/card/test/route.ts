import { handle } from "@/backend/http";
import { connectTestCard } from "@/backend/checkout/service";

/** Dev shortcut: connect Stripe's test Visa (4242) without the card form. */
export async function POST(_req: Request, ctx: RouteContext<"/api/projects/[projectId]/checkout/card/test">) {
  const { projectId } = await ctx.params;
  return handle(() => connectTestCard(projectId));
}
