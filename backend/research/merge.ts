import type { ProductCandidate } from "@/backend/contracts";

/** Pure merge/filter/stage helpers for agentResearch.ts. */

export interface MerchantRun {
  merchant: string;
  status: "searching" | "done" | "failed";
  found: number;
  note: string | null;
}

export interface MergeFilter {
  maxPriceUsd?: number | null;
  maxWidthM?: number | null;
  maxDepthM?: number | null;
  /** Per merchant; the merged list keeps up to limit x merchants. */
  limit?: number;
}

const MAX_RESULTS = 20;

/**
 * One list from every merchant's results: deduped by id, anything known to be
 * over a cap dropped (unknown price or size is kept, the caller flags it),
 * cheapest first, products with known size and price ahead of the rest.
 */
export function mergeResults(perMerchant: ProductCandidate[][], f: MergeFilter = {}): ProductCandidate[] {
  const seen = new Set<string>();
  const out: ProductCandidate[] = [];
  for (const list of perMerchant) {
    for (const p of list) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (f.maxPriceUsd != null && p.price && p.price.amountMinor > Math.round(f.maxPriceUsd * 100)) continue;
      if (f.maxWidthM != null && p.dimensions && p.dimensions[0] > f.maxWidthM) continue;
      if (f.maxDepthM != null && p.dimensions && p.dimensions[2] > f.maxDepthM) continue;
      out.push(p);
    }
  }
  const known = (p: ProductCandidate) => (p.price ? 0 : 2) + (p.dimensions ? 0 : 1);
  out.sort((a, b) => known(a) - known(b) || (a.price?.amountMinor ?? 0) - (b.price?.amountMinor ?? 0) || a.label.localeCompare(b.label));
  const cap = Math.min(MAX_RESULTS, (f.limit ?? 5) * Math.max(1, perMerchant.length));
  return out.slice(0, cap);
}

/** "IKEA done, 3 found; Target searching" */
export function stageLine(runs: MerchantRun[]): string {
  return runs
    .map((r) => (r.status === "searching" ? `${r.merchant} searching` : r.status === "done" ? `${r.merchant} done, ${r.found} found` : `${r.merchant} failed`))
    .join("; ");
}
