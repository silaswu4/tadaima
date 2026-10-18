import { z } from "zod";
import { FloorSpotSchema, handle } from "@/backend/http";
import { placeProduct } from "@/backend/shopping/shop";

const Body = z.object({
  productId: z.string().max(200),
  spot: FloorSpotSchema,
  expectedRevision: z.number().int().nullable().optional(),
});

/** Add a catalog product to the room at a spot (placed so it fits). It joins the cart as a proposed purchase. */
export async function POST(req: Request, ctx: RouteContext<"/api/projects/[projectId]/place">) {
  const { projectId } = await ctx.params;
  return handle(async () => placeProduct(projectId, Body.parse(await req.json())));
}
