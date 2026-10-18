import { z } from "zod";
import { agentRoute } from "@/backend/accounts/http";
import { BadResearchInput, startAgentResearch } from "@/backend/research/agentResearch";
import { MERCHANTS, type Merchant } from "@/backend/research/browserUse";

const CATEGORIES = ["sofa", "chair", "table", "desk", "storage", "bed", "rug", "lamp", "decor", "other"] as const;

// "ikea", "west elm" and friends map to the canonical names
const merchant = z.string().transform((s, c) => {
  const m = MERCHANTS.find((x) => x.toLowerCase() === s.trim().toLowerCase());
  if (!m) c.addIssue({ code: "custom", message: `unknown merchant ${s}` });
  return m as Merchant;
});

const Body = z.object({
  category: z.enum(CATEGORIES),
  query: z.string().trim().min(1).max(160),
  maxPriceUsd: z.number().positive().max(100_000).nullish(),
  maxWidthM: z.number().positive().max(20).nullish(),
  maxDepthM: z.number().positive().max(20).nullish(),
  merchants: z.array(merchant).max(5).default(["IKEA", "Target"]),
  limit: z.number().int().min(1).max(8).default(5),
  productUrl: z.string().url().max(600).nullish(),
});

export async function POST(req: Request) {
  return agentRoute(req, async () => {
    try {
      return await startAgentResearch(Body.parse(await req.json()));
    } catch (e) {
      if (e instanceof BadResearchInput) return Response.json({ error: e.message }, { status: 422 });
      throw e;
    }
  });
}
