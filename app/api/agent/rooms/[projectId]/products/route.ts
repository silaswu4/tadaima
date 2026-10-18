import { z } from "zod";
import { agentRoute } from "@/backend/accounts/http";
import { addResearchedProducts } from "@/backend/accounts/service";

const vec3 = z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]);
const Product = z.object({
  id: z.string().min(3).max(200),
  category: z.enum(["sofa", "chair", "table", "desk", "storage", "bed", "rug", "lamp", "decor", "other"]),
  merchant: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  sourceUrl: z.url(),
  imageUrl: z.url().nullable(),
  priceUsd: z.number().nonnegative().nullable(),
  dimensions: vec3.nullable(),
  seats: z.number().int().min(0).max(12).nullable(),
  availability: z.enum(["available", "unavailable", "unknown"]),
  observedAt: z.string().max(40),
});
const Body = z.object({ products: z.array(Product).min(1).max(20), source: z.string().max(120) });

/** Products another agent (Scout) observed live join the room's catalog, so spot search can fit-check and place them. */
export async function POST(req: Request, ctx: RouteContext<"/api/agent/rooms/[projectId]/products">) {
  const { projectId } = await ctx.params;
  return agentRoute(req, async () => {
    const { products, source } = Body.parse(await req.json());
    return addResearchedProducts(projectId, products, source);
  });
}
