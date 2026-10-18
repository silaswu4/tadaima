import "server-only";

import { after } from "next/server";
import type { FloorSpot, Job, PlaceResult, ProductCandidate, ShopJobOutput, ShopRequest, ShopResult } from "@/backend/contracts";
import { applyPlanChanges, getProject, NotFound, Unprocessable } from "@/backend/plan/operations";
import { getJob, saveJob } from "@/backend/plan/store";
import { researchProducts } from "@/backend/research/browserUse";
import { placeAt } from "@/backend/shopping/placement";
import { catalogCandidates, evaluateAll, itemFor, onFloor, SEARCH_TERM, spotBrief, underCap } from "@/backend/shopping/spot";

/**
 * "I want a couch under $300 that fits here." The shopper points at a floor
 * spot; this finds products that fit there.
 *
 * Two passes, one job. The catalog pass is instant: products we already know
 * (real, observed) are fit-checked at the spot and returned in the start
 * response, so there's something to show and say right away. The live pass
 * browses the store with Browser Use in the background, measured at the same
 * spot, and merges what it finds into the job; products that fit join the
 * plan's catalog. Every read re-checks results against the live plan, so a
 * piece placed in the meantime makes the others honestly stop fitting.
 */

const MAX_RESULTS = 8;
type Entry = { product: ProductCandidate; source: ShopResult["source"] };

export async function startShopping(projectId: string, req: ShopRequest): Promise<Job<ShopJobOutput>> {
  const { plan } = await getProject(projectId);
  if (!onFloor(plan, req)) throw new Unprocessable("That spot isn't on the floor of a room.");

  const live = req.live !== false;
  const brief = spotBrief(plan, req);
  const entries: Entry[] = catalogCandidates(plan, req).map((product) => ({ product, source: "catalog" }));
  const results = evaluateAll(plan, entries, req).slice(0, MAX_RESULTS);
  const fits = results.filter((r) => r.fits).length;
  const term = SEARCH_TERM[req.category];
  const merchant = req.merchant ?? "IKEA";

  const now = new Date().toISOString();
  const job: Job<ShopJobOutput> = {
    id: `job_${crypto.randomUUID().slice(0, 8)}`,
    projectId,
    type: "shop_at_spot",
    state: live ? "running" : "succeeded",
    stage: live
      ? `${fits} in our catalog fit there. Checking ${merchant} live for more`
      : `${fits} in our catalog fit there`,
    inputRevision: plan.revision,
    output: { request: req, brief: brief.text, results, live: live ? "running" : "skipped", addedAtRevision: null, costUsd: null, checkedAtRevision: plan.revision },
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  await saveJob(job);
  if (live) after(() => browse(job, entries, term, brief.maxWidthM, brief.budgetLeftUsd));
  return job;
}

async function update(job: Job<ShopJobOutput>, patch: Partial<Job<ShopJobOutput>>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  await saveJob(job);
}

async function browse(job: Job<ShopJobOutput>, catalog: Entry[], term: string, maxWidthM: number | null, budgetLeftUsd: number | null) {
  const req = job.output!.request;
  const merchant = req.merchant ?? "IKEA";
  let done = false;
  try {
    const cap = req.maxPriceUsd ?? budgetLeftUsd ?? 2000;
    const query = req.request ? `${term}, ${req.request}` : term;
    await update(job, { stage: `Browsing ${merchant} for ${query} under $${Math.floor(cap)}` });
    const found = await researchProducts(
      {
        category: req.category,
        query,
        maxPriceUsd: cap,
        maxWidthM: maxWidthM ?? undefined,
        merchant,
        limit: 5,
        roomBrief: job.output!.brief,
      },
      {
        timeoutMs: 6 * 60 * 1000,
        onActivity: (e) => {
          // the live url is a session credential: never stored on the job
          if (e.type !== "live" && !done) void update(job, { stage: e.message });
        },
      },
    );

    const fresh = found.products.filter((p) => p.category === req.category && underCap(p, req));
    const { plan } = await getProject(job.projectId);
    const merged: Entry[] = [
      ...catalog.filter((c) => !fresh.some((p) => p.id === c.product.id)),
      ...fresh.map((product) => ({ product, source: "live" as const })),
    ];
    const results = evaluateAll(plan, merged, req).slice(0, MAX_RESULTS);
    const keep = results.filter((r) => r.source === "live" && r.fits).map((r) => r.product);

    // live finds that fit join the plan's catalog so they can be placed; this commutes with any edit, so retry a race
    let addedAtRevision: number | null = null;
    if (keep.length) {
      const ids = new Set(keep.flatMap((p) => p.evidenceIds));
      const evidence = found.evidence.filter((e) => ids.has(e.id));
      for (let attempt = 0; attempt < 3 && addedAtRevision === null; attempt++) {
        const { plan: latest } = await getProject(job.projectId);
        const r = await applyPlanChanges(job.projectId, latest.revision, [{ kind: "add_products", products: keep, evidence }]);
        if (r.ok) addedAtRevision = r.plan.revision;
      }
    }

    done = true;
    const liveFits = results.filter((r) => r.source === "live" && r.fits).length;
    const failed = found.run.status !== "completed" && !found.products.length;
    await update(job, {
      state: "succeeded",
      stage: failed
        ? `${merchant} live search didn't finish${found.run.notes ? `: ${found.run.notes}` : ""}. Showing catalog matches`
        : `Found ${fresh.length} at ${merchant}, ${liveFits} fit there`,
      output: {
        ...job.output!,
        results,
        live: failed ? "failed" : "done",
        addedAtRevision,
        costUsd: found.run.costUsd,
        checkedAtRevision: addedAtRevision ?? plan.revision,
      },
      error: failed ? found.run.error : null,
    });
  } catch (e) {
    done = true;
    console.error("[shop]", e);
    // the catalog results still stand
    await update(job, {
      state: "succeeded",
      stage: `${merchant} live search failed. Showing catalog matches`,
      output: { ...job.output!, live: "failed" },
      error: e instanceof Error ? e.message : "unknown error",
    });
  }
}

/** The job with every result re-checked against the room as it is now. */
export async function getShopJob(projectId: string, jobId: string) {
  const job = await getJob<ShopJobOutput>(projectId, jobId);
  if (!job || job.type !== "shop_at_spot") throw new NotFound(`no shopping job ${jobId}`);
  if (!job.output) return job;
  const { plan } = await getProject(projectId);
  // re-read each product from the plan when it's there (a recheck may have updated its price)
  const entries = job.output.results.map((r) => ({ product: plan.products.find((p) => p.id === r.product.id) ?? r.product, source: r.source }));
  return { ...job, output: { ...job.output, results: evaluateAll(plan, entries, job.output.request), checkedAtRevision: plan.revision } };
}

/**
 * Put a product in the room at a spot: placement is recomputed against the
 * current plan, then the add goes through the same validation as any change
 * (fit, budget, stock). On a race with another edit it re-places and retries.
 */
export async function placeProduct(
  projectId: string,
  body: { productId: string; spot: FloorSpot; expectedRevision?: number | null },
): Promise<PlaceResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { plan } = await getProject(projectId);
    if (body.expectedRevision != null && body.expectedRevision !== plan.revision) return { ok: false, reason: "stale_revision", currentRevision: plan.revision };
    const product = plan.products.find((p) => p.id === body.productId);
    if (!product) throw new NotFound(`no product ${body.productId} in this room's catalog`);
    const fit = placeAt(plan, product, body.spot);
    if (!fit.ok) {
      if (fit.reason === "off_floor") throw new Unprocessable(fit.message);
      return { ok: false, reason: "no_fit", message: fit.message, nearest: fit.nearest };
    }
    const itemId = `item_${product.category}_${crypto.randomUUID().slice(0, 6)}`;
    const r = await applyPlanChanges(projectId, plan.revision, [{ kind: "add", item: itemFor(product, fit.placement, itemId) }]);
    if (r.ok) return { ok: true, plan: r.plan, itemId, placement: fit.placement };
    if (r.reason === "validation_failed") return r;
    // someone else saved first: re-place against their change, unless the caller pinned a revision
    if (body.expectedRevision != null) return r;
  }
  const { plan } = await getProject(projectId);
  return { ok: false, reason: "stale_revision", currentRevision: plan.revision };
}

/** Move an existing piece to a spot, re-placed so it fits. Locked pieces need `unlock: true`. */
export async function moveItemTo(
  projectId: string,
  body: { itemId: string; spot: FloorSpot; unlock?: boolean; expectedRevision?: number | null },
): Promise<PlaceResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { plan } = await getProject(projectId);
    if (body.expectedRevision != null && body.expectedRevision !== plan.revision) return { ok: false, reason: "stale_revision", currentRevision: plan.revision };
    const item = plan.items.find((i) => i.id === body.itemId);
    if (!item) throw new NotFound(`no item ${body.itemId}`);
    if (item.locked && !body.unlock) return { ok: false, reason: "locked", message: `${item.label} is locked. Unlock it to move it.` };
    const fit = placeAt(plan, item, body.spot, { ignoreItemId: item.id });
    if (!fit.ok) {
      if (fit.reason === "off_floor") throw new Unprocessable(fit.message);
      return { ok: false, reason: "no_fit", message: fit.message, nearest: fit.nearest };
    }
    const { position, rotationY, roomId } = fit.placement;
    if (roomId !== item.roomId) throw new Unprocessable("Moving a piece to another room isn't supported yet.");
    // a locked piece is unlocked just for this move, then locked again where it lands
    const changes = item.locked
      ? [
          { kind: "lock" as const, itemId: item.id, locked: false },
          { kind: "move" as const, itemId: item.id, position, rotationY },
          { kind: "lock" as const, itemId: item.id, locked: true },
        ]
      : [{ kind: "move" as const, itemId: item.id, position, rotationY }];
    const r = await applyPlanChanges(projectId, plan.revision, changes);
    if (r.ok) return { ok: true, plan: r.plan, itemId: item.id, placement: fit.placement };
    if (r.reason === "validation_failed" || body.expectedRevision != null) return r;
  }
  const { plan } = await getProject(projectId);
  return { ok: false, reason: "stale_revision", currentRevision: plan.revision };
}
