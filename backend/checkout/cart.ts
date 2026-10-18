import { createHash } from "node:crypto";
import type { Cart, CartLine, Money, RoomPlan } from "@/backend/contracts";

/**
 * The cart is not stored: it is derived from the plan's proposed purchases
 * every time, so it can never drift from the room. Its digest changes when
 * anything that would be paid for changes (product, variant, quantity, price).
 */
export function cartOf(plan: RoomPlan): Cart {
  const currency = plan.constraints.budget?.currency ?? "USD";
  const byProduct = new Map<string, CartLine & { merchant: string }>();
  const unpriced: string[] = [];
  for (const item of plan.items) {
    if (item.origin !== "proposed_purchase" || !item.productId) continue;
    const product = plan.products.find((p) => p.id === item.productId);
    if (!product) continue;
    if (!product.price) unpriced.push(product.id);
    const line = byProduct.get(product.id);
    if (line) line.quantity += 1;
    else
      byProduct.set(product.id, {
        merchant: product.merchant,
        productId: product.id,
        variantId: product.variantId,
        label: product.label,
        quantity: 1,
        observedPrice: product.price,
      });
  }

  const merchants = new Map<string, CartLine[]>();
  for (const { merchant, ...line } of byProduct.values()) merchants.set(merchant, [...(merchants.get(merchant) ?? []), line]);
  const sum = (lines: CartLine[]): Money => ({
    amountMinor: lines.reduce((n, l) => n + (l.observedPrice?.amountMinor ?? 0) * l.quantity, 0),
    currency,
  });
  const groups = [...merchants.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([merchant, lines]) => ({ merchant, lines: lines.sort((a, b) => a.productId.localeCompare(b.productId)), subtotal: sum(lines) }));
  const all = groups.flatMap((g) => g.lines);

  const digest = createHash("sha256")
    .update(JSON.stringify(all.map((l) => [l.productId, l.variantId, l.quantity, l.observedPrice?.amountMinor ?? null, l.observedPrice?.currency ?? null])))
    .digest("hex")
    .slice(0, 16);

  return {
    projectId: plan.projectId,
    planRevision: plan.revision,
    merchants: groups,
    subtotal: sum(all),
    unpricedProductIds: unpriced,
    unknownCosts: ["shipping", "tax"],
    digest,
  };
}
