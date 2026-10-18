import { z } from "zod";
import { handleProject } from "@/backend/http";
import { approve } from "@/backend/checkout/service";

const Body = z.object({ cartDigest: z.string(), paymentMethodId: z.string() });

/** The shopper approves this exact cart. Creates the mandate the agent pays under. */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[projectId]/checkout/approve">) {
  const { projectId } = await ctx.params;
  return handleProject(req, projectId, async () => {
    const { cartDigest, paymentMethodId } = Body.parse(await req.json());
    return approve(projectId, cartDigest, paymentMethodId);
  });
}
