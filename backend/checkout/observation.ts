import type { Money, ProductCandidate, RecheckLine } from "@/backend/contracts";

type Observation = RecheckLine & { observed: ProductCandidate | null };

/** Only a complete, unambiguous Offer can establish both price and stock. */
export function observeProductPage(product: ProductCandidate, html: string, now = Date.now()): Observation {
  const base = { productId: product.id, label: product.label, catalogPrice: product.price };
  const offers: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 20 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((entry) => visit(entry, depth + 1)); return; }
    const record = value as Record<string, unknown>;
    const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
    if (types.includes("Offer")) offers.push(record);
    Object.values(record).forEach((entry) => visit(entry, depth + 1));
  };
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* malformed structured data cannot verify a purchase */ }
  }
  const parsed = offers.flatMap((offer) => {
    const rawPrice = offer.price;
    const amount = (typeof rawPrice === "number" || typeof rawPrice === "string") && String(rawPrice).trim() !== "" ? Number(rawPrice) : NaN;
    const currency = typeof offer.priceCurrency === "string" ? offer.priceCurrency : "";
    if (!Number.isFinite(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency) || !Number.isSafeInteger(Math.round(amount * 100))) return [];
    const stock = typeof offer.availability === "string" ? offer.availability.replace(/^https?:\/\/schema\.org\//, "") : null;
    return [{ price: { amountMinor: Math.round(amount * 100), currency } satisfies Money, stock }];
  });
  const distinct = new Map(parsed.map((offer) => [JSON.stringify(offer), offer]));
  if (distinct.size !== 1) return { ...base, status: "unverified", observedPrice: null, note: distinct.size ? "multiple offers need an exact variant check" : "no complete price and currency on the page", observed: null };
  const { price: observedPrice, stock } = [...distinct.values()][0];
  const availability = stock === "InStock" || stock === "LimitedAvailability" ? "available" : stock ? "unavailable" : "unknown";
  const observed: ProductCandidate = { ...product, price: observedPrice, availability, observedAt: new Date(now).toISOString() };
  if (availability === "unknown") return { ...base, status: "unverified", observedPrice, note: "stock not stated on the product page", observed };
  if (availability === "unavailable") return { ...base, status: "unavailable", observedPrice, note: `page says ${stock}`, observed };
  if (!product.price || product.price.amountMinor !== observedPrice.amountMinor || product.price.currency !== observedPrice.currency) return { ...base, status: "price_changed", observedPrice, note: null, observed };
  return { ...base, status: "ok", observedPrice, note: null, observed };
}
