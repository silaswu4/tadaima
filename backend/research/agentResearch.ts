import "server-only";

import { after } from "next/server";
import type { FurnitureCategory, Job, ProductCandidate } from "@/backend/contracts";
import { getJob, saveJob } from "@/backend/plan/store";
import { merchantForUrl, researchProducts, type Merchant } from "@/backend/research/browserUse";
import { mergeResults, stageLine, type MerchantRun } from "@/backend/research/merge";

/**
 * Room-free product research for the Scout agent (backend/fetch/scout). One
 * Browser Use run per merchant, all in parallel, merged into one list. Jobs
 * live under a fixed pseudo project so they share the normal job store.
 */

export const SCOUT_PROJECT = "agent_scout";

export interface AgentResearchInput {
  category: FurnitureCategory;
  query: string;
  maxPriceUsd?: number | null;
  maxWidthM?: number | null;
  maxDepthM?: number | null;
  merchants: Merchant[];
  limit?: number;
  /** Measure this one product page instead of searching. */
  productUrl?: string | null;
}

export interface AgentResearchOutput {
  products: ProductCandidate[];
  merchants: MerchantRun[];
  costUsd: number | null;
}

// no cap given: the task still needs a number, and a high one doesn't bias results
const NO_PRICE_CAP = 20_000;

export class BadResearchInput extends Error {}

export async function startAgentResearch(input: AgentResearchInput): Promise<Job<AgentResearchOutput>> {
  let merchants = [...new Set(input.merchants)];
  if (input.productUrl) {
    const m = merchantForUrl(input.productUrl);
    if (!m) throw new BadResearchInput("that link isn't on a store I can read (IKEA, Target, Walmart, Article, West Elm)");
    merchants = [m];
  }
  if (!merchants.length) throw new BadResearchInput("no merchants");
  const now = new Date().toISOString();
  const runs: MerchantRun[] = merchants.map((merchant) => ({ merchant, status: "searching", found: 0, note: null }));
  const job: Job<AgentResearchOutput> = {
    id: `job_${crypto.randomUUID().slice(0, 8)}`,
    projectId: SCOUT_PROJECT,
    type: "product_research",
    state: "running",
    stage: stageLine(runs),
    inputRevision: 0,
    output: { products: [], merchants: runs, costUsd: null },
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await saveJob(job);
  after(() => run(job, { ...input, merchants }));
  return job;
}

export const getAgentResearchJob = (jobId: string) => getJob<AgentResearchOutput>(SCOUT_PROJECT, jobId);

async function run(job: Job<AgentResearchOutput>, input: AgentResearchInput) {
  const out = job.output!;
  const found: ProductCandidate[][] = [];
  const costs: number[] = [];
  // runs finish in any order; saves are serialized so a slow write can't undo a newer one
  let saving = Promise.resolve();
  const save = () => {
    job.stage = stageLine(out.merchants);
    job.updatedAt = new Date().toISOString();
    const snapshot = structuredClone(job);
    saving = saving.then(() => saveJob(snapshot)).catch((e) => console.error("[agent research] save", e));
    return saving;
  };

  await Promise.all(
    out.merchants.map(async (m) => {
      try {
        const r = await researchProducts(
          {
            category: input.category,
            query: input.query,
            maxPriceUsd: input.maxPriceUsd ?? NO_PRICE_CAP,
            maxWidthM: input.maxWidthM ?? undefined,
            merchant: m.merchant as Merchant,
            limit: input.productUrl ? 1 : (input.limit ?? 5),
            productUrl: input.productUrl ?? undefined,
          },
          { timeoutMs: 6 * 60 * 1000 },
        );
        found.push(r.products);
        if (r.run.costUsd != null) costs.push(r.run.costUsd);
        m.found = r.products.length;
        m.status = r.run.status === "completed" || r.products.length ? "done" : "failed";
        m.note = r.run.notes ?? (m.status === "failed" ? r.run.error ?? r.run.status : null);
      } catch (e) {
        console.error(`[agent research] ${m.merchant}`, e);
        m.status = "failed";
        m.note = e instanceof Error ? e.message.slice(0, 200) : "unknown error";
      }
      out.products = mergeResults(found, input);
      await save();
    }),
  );

  out.costUsd = costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  const anyOk = out.merchants.some((m) => m.status === "done");
  job.state = anyOk ? "succeeded" : "failed";
  job.error = anyOk ? null : out.merchants.map((m) => `${m.merchant}: ${m.note ?? "failed"}`).join("; ");
  await save();
}
