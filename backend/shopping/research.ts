import "server-only";

import { after } from "next/server";
import type { FurnitureCategory, Job, ResearchJobOutput } from "@/backend/contracts";
import { applyPlanChanges, getProject, NotFound } from "@/backend/plan/operations";
import { getJob, saveJob } from "@/backend/plan/store";
import { researchProducts, type Merchant } from "@/backend/research/browserUse";
import { fitCheck, shoppingBrief } from "@/backend/shopping/roomBrief";

/**
 * Room-aware product research. The search is built from the live plan (free
 * space at the spot, money left, seats needed, what's in the room), every
 * result is fit-checked against that same plan, and the ones that fit join
 * the plan's catalog so the planner and UI can use them.
 *
 * Browser runs take minutes, so this is a job: start returns at once, the run
 * continues after the response, and callers poll getResearchJob.
 */

const DEFAULT_QUERY: Partial<Record<FurnitureCategory, string>> = {
  chair: "armchair",
  sofa: "loveseat",
  table: "coffee table",
  rug: "area rug",
  lamp: "floor lamp",
  storage: "bookcase",
  desk: "desk",
};

export interface ResearchRequest {
  itemId: string;
  /** Shopper's words, e.g. "something green and cozy". Optional. */
  request?: string | null;
  merchant?: Merchant;
}

export async function startResearch(projectId: string, req: ResearchRequest): Promise<Job<ResearchJobOutput>> {
  const { plan } = await getProject(projectId);
  if (!plan.items.some((i) => i.id === req.itemId)) throw new NotFound(`no item ${req.itemId}`);
  const brief = shoppingBrief(plan, { itemId: req.itemId });
  const merchant = req.merchant ?? "IKEA";
  const now = new Date().toISOString();
  const job: Job<ResearchJobOutput> = {
    id: `job_${crypto.randomUUID().slice(0, 8)}`,
    projectId,
    type: "product_research",
    state: "queued",
    stage: `Looking for a ${DEFAULT_QUERY[brief.category] ?? brief.category} at ${merchant}`,
    inputRevision: plan.revision,
    output: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await saveJob(job);
  after(() => run(job, req, merchant));
  return job;
}

export const getResearchJob = (projectId: string, jobId: string) => getJob<ResearchJobOutput>(projectId, jobId);

async function update(job: Job<ResearchJobOutput>, patch: Partial<Job<ResearchJobOutput>>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  await saveJob(job);
}

async function run(job: Job<ResearchJobOutput>, req: ResearchRequest, merchant: Merchant) {
  try {
    const { plan } = await getProject(job.projectId);
    const brief = shoppingBrief(plan, { itemId: req.itemId });
    const base = DEFAULT_QUERY[brief.category] ?? brief.category;
    const query = req.request ? `${base}, ${req.request}` : base;
    await update(job, { state: "running", stage: `Browsing ${merchant} for ${query} under $${Math.floor(brief.budget.maxPriceUsd ?? 0)}` });

    const found = await researchProducts(
      {
        category: brief.category,
        query,
        maxPriceUsd: brief.budget.maxPriceUsd ?? 2000,
        maxWidthM: brief.space.maxWidthM ?? undefined,
        merchant,
        limit: 5,
        roomBrief: brief.text,
      },
      {
        timeoutMs: 6 * 60 * 1000,
        onActivity: (e) => {
          // the live url is a session credential: never stored on the job
          if (e.type !== "live") void update(job, { stage: e.message });
        },
      },
    );

    // fit-check against the plan as it is now, which may have moved on while we browsed
    const { plan: current } = await getProject(job.projectId);
    const results = current.items.some((i) => i.id === req.itemId) ? fitCheck(current, req.itemId, found.products) : [];
    const fitting = results.filter((r) => r.fits).map((r) => r.product);

    let addedAtRevision: number | null = null;
    if (fitting.length) {
      const ids = new Set(fitting.flatMap((p) => p.evidenceIds));
      const evidence = found.evidence.filter((e) => ids.has(e.id));
      // adding catalog entries commutes with any other change, so just retry on a race
      for (let attempt = 0; attempt < 3 && addedAtRevision === null; attempt++) {
        const { plan: latest } = await getProject(job.projectId);
        const r = await applyPlanChanges(job.projectId, latest.revision, [{ kind: "add_products", products: fitting, evidence }]);
        if (r.ok) addedAtRevision = r.plan.revision;
      }
    }

    const fits = results.filter((r) => r.fits).length;
    await update(job, {
      state: found.run.status === "completed" || found.products.length ? "succeeded" : "failed",
      stage: found.products.length
        ? `Found ${found.products.length} at ${merchant}, ${fits} fit your room`
        : `Nothing usable at ${merchant}${found.run.notes ? `: ${found.run.notes}` : ""}`,
      output: { brief: brief.text, itemId: req.itemId, merchant, results, addedAtRevision, costUsd: found.run.costUsd },
      error: found.run.error,
    });
  } catch (e) {
    console.error("[research]", e);
    await update(job, { state: "failed", stage: "Research failed", error: e instanceof Error ? e.message : "unknown error" });
  }
}
