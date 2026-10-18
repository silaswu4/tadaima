import { z } from "zod";
import { FloorSpotSchema, handle } from "@/backend/http";
import { startShopping } from "@/backend/shopping/shop";

const Body = z.object({
  category: z.enum(["sofa", "chair", "table", "desk", "storage", "bed", "rug", "lamp", "decor", "other"]),
  spot: FloorSpotSchema,
  maxPriceUsd: z.number().positive().max(100000).nullable().optional(),
  request: z.string().max(300).nullable().optional(),
  merchant: z.enum(["IKEA", "Target"]).optional(),
  live: z.boolean().optional(),
});

/**
 * Shop for a spot on the floor. Answers at once with catalog products that fit
 * there; unless `live: false`, a live store search keeps going in the
 * background. Poll /shop/{jobId} for merged, re-checked results.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[projectId]/shop">) {
  const { projectId } = await ctx.params;
  return handle(async () => startShopping(projectId, Body.parse(await req.json())));
}
