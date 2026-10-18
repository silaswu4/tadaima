import { z } from "zod";
import { handle } from "@/backend/http";
import { finishCardSetup, startCardSetup } from "@/backend/checkout/service";

/** POST {} starts a card setup (Stripe Elements client secret). POST { setupIntentId } finishes it. */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[projectId]/checkout/card">) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const body = z.object({ setupIntentId: z.string().optional() }).parse(await req.json().catch(() => ({})));
    return body.setupIntentId ? finishCardSetup(projectId, body.setupIntentId) : startCardSetup(projectId);
  });
}
