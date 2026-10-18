import "server-only";

import type { Money, ProductCandidate, RecheckLine } from "@/backend/contracts";

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
    const res = await fetch(p.sourceUrl, { headers: { "User-Agent": UA, "Accept-Language": "en-US" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ...base, status: "unverified", observedPrice: null, note: `product page returned ${res.status}`, observed: null };
    const html = await res.text();
    const offer = html.match(/"@type":"Offer"[^}]*/)?.[0] ?? "";
    const price = offer.match(/"price":"?([\d.]+)"?/)?.[1];
    const currency = offer.match(/"priceCurrency":"([A-Z]{3})"/)?.[1] ?? "USD";
    const stock = offer.match(/"availability":"https?:\/\/schema\.org\/(\w+)"/)?.[1];
    if (!price) return { ...base, status: "unverified", observedPrice: null, note: "no price on the page", observed: null };

    const observedPrice: Money = { amountMinor: Math.round(Number(price) * 100), currency };
    const availability = stock === "InStock" || stock === "LimitedAvailability" ? "available" : stock ? "unavailable" : "unknown";
    const observed: ProductCandidate = { ...p, price: observedPrice, availability, observedAt: new Date().toISOString() };
    if (availability === "unavailable") return { ...base, status: "unavailable", observedPrice, note: `page says ${stock}`, observed };
    if (!p.price || p.price.amountMinor !== observedPrice.amountMinor || p.price.currency !== currency) {
      return { ...base, status: "price_changed", observedPrice, note: null, observed };
    }
    return { ...base, status: "ok", observedPrice, note: availability === "unknown" ? "stock not stated" : null, observed };
  } catch (e) {
    return { ...base, status: "unverified", observedPrice: null, note: e instanceof Error ? e.message : "fetch failed", observed: null };
  }
}
