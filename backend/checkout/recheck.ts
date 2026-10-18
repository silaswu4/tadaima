import "server-only";

import type { ProductCandidate, RecheckLine } from "@/backend/contracts";
import { observeProductPage } from "@/backend/checkout/observation";

/**
 * Re-read price and stock from the live product page right before checkout.
 * IKEA publishes both in the page's JSON-LD Offer, so a plain fetch is enough
 * (about a second, no browser). Anything we can't read comes back
 * `unverified`, which blocks approval rather than passing quietly.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

export async function recheckProduct(p: ProductCandidate): Promise<RecheckLine & { observed: ProductCandidate | null }> {
  const base = { productId: p.id, label: p.label, catalogPrice: p.price };
  if (p.merchant !== "IKEA") {
    return { ...base, status: "unverified", observedPrice: null, note: `live recheck isn't supported for ${p.merchant} yet`, observed: null };
  }
  try {
    const url = new URL(p.sourceUrl);
    if (url.protocol !== "https:" || !["www.ikea.com", "ikea.com"].includes(url.hostname) || url.username || url.password || (url.port && url.port !== "443")) return { ...base, status: "unverified", observedPrice: null, note: "unsupported product page URL", observed: null };
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ...base, status: "unverified", observedPrice: null, note: `product page returned ${res.status}`, observed: null };
    const html = await res.text();
    return observeProductPage(p, html);
  } catch (e) {
    return { ...base, status: "unverified", observedPrice: null, note: e instanceof Error ? e.message : "fetch failed", observed: null };
  }
}
