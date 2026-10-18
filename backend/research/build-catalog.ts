/**
 * Build backend/fixtures/real-catalog.json from live Browser Use research runs.
 *
 *   npx tsx backend/research/build-catalog.ts              # all jobs
 *   npx tsx backend/research/build-catalog.ts ikea-chair   # only jobs whose key contains "ikea-chair"
 *
 * Runs jobs concurrently and merges into the existing catalog by product id,
 * so a failed job can be retried alone. Live view urls are printed, never written.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Evidence, ProductCandidate } from "@/backend/contracts";
import { researchProducts, type ResearchInput } from "./browserUse";

const OUT = path.join(process.cwd(), "backend/fixtures/real-catalog.json");

if (!process.env.BROWSER_USE_API_KEY && existsSync(".env.local")) process.loadEnvFile(".env.local");

const JOBS: Array<ResearchInput & { key: string }> = [
  { key: "ikea-chair", merchant: "IKEA", category: "chair", query: "armchair", maxPriceUsd: 700, maxWidthM: 1.0, limit: 5 },
  { key: "ikea-sofa", merchant: "IKEA", category: "sofa", query: "loveseat", maxPriceUsd: 900, maxWidthM: 1.7, limit: 3 },
  { key: "ikea-table", merchant: "IKEA", category: "table", query: "coffee table", maxPriceUsd: 400, maxWidthM: 1.3, limit: 4 },
  { key: "ikea-rug", merchant: "IKEA", category: "rug", query: "rug 4'4\" x 6'5\"", maxPriceUsd: 300, limit: 4 },
  { key: "ikea-lamp", merchant: "IKEA", category: "lamp", query: "floor lamp", maxPriceUsd: 200, limit: 4 },
  { key: "ikea-storage", merchant: "IKEA", category: "storage", query: "bookcase", maxPriceUsd: 400, maxWidthM: 1.0, limit: 4 },
  { key: "target-chair", merchant: "Target", category: "chair", query: "accent armchair", maxPriceUsd: 400, maxWidthM: 1.0, limit: 4 },
  { key: "target-table", merchant: "Target", category: "table", query: "coffee table", maxPriceUsd: 300, maxWidthM: 1.3, limit: 3 },
  { key: "target-rug", merchant: "Target", category: "rug", query: "area rug 5x7", maxPriceUsd: 250, limit: 3 },
  { key: "target-lamp", merchant: "Target", category: "lamp", query: "floor lamp", maxPriceUsd: 150, limit: 3 },
];

interface Catalog {
  generatedAt: string;
  note: string;
  products: ProductCandidate[];
  evidence: Evidence[];
  runs: Array<{ key: string; runId: string; status: string; costUsd: number | null; found: number; error: string | null; notes: string | null }>;
}

async function main() {
  const filter = process.argv[2];
  const jobs = filter ? JOBS.filter((j) => j.key.includes(filter)) : JOBS;
  if (jobs.length === 0) throw new Error(`no job matches ${filter}`);

  const prior: Catalog | null = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  console.log(`running ${jobs.length} jobs: ${jobs.map((j) => j.key).join(", ")}`);

  const results = await Promise.all(
    jobs.map(async ({ key, ...input }) => {
      try {
        const r = await researchProducts(input, {
          onActivity: (e) => console.log(`[${key}] ${e.message}${e.liveUrl ? ` ${e.liveUrl}` : ""}`),
        });
        for (const x of r.rejected) console.log(`[${key}] rejected ${x.name}: ${x.reason}`);
        if (r.run.error || r.run.notes) console.log(`[${key}] error=${r.run.error} notes=${r.run.notes}`);
        return { key, r };
      } catch (err) {
        console.log(`[${key}] threw ${(err as Error).message}`);
        return { key, r: null };
      }
    }),
  );

  const products = new Map((prior?.products ?? []).map((p) => [p.id, p]));
  const evidence = new Map((prior?.evidence ?? []).map((e) => [e.id, e]));
  const runs = new Map((prior?.runs ?? []).map((x) => [x.key, x]));
  let cost = 0;
  for (const { key, r } of results) {
    if (!r) continue;
    cost += r.run.costUsd ?? 0;
    for (const p of r.products) products.set(p.id, p);
    for (const e of r.evidence) evidence.set(e.id, e);
    runs.set(key, { key, runId: r.run.runId, status: r.run.status, costUsd: r.run.costUsd, found: r.products.length, error: r.run.error, notes: r.run.notes });
  }

  const catalog: Catalog = {
    generatedAt: new Date().toISOString(),
    note: "Real retailer observations collected by Browser Use. Prices and stock change; recheck before cart.",
    products: [...products.values()].sort((a, b) => a.category.localeCompare(b.category) || (a.price?.amountMinor ?? 0) - (b.price?.amountMinor ?? 0)),
    evidence: [...evidence.values()],
    runs: [...runs.values()],
  };
  writeFileSync(OUT, JSON.stringify(catalog, null, 2) + "\n");
  console.log(`wrote ${catalog.products.length} products to ${OUT}; this batch cost $${cost.toFixed(3)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
