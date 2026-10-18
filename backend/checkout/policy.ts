import type { Cart, Order, PaymentMethod, Recheck } from "@/backend/contracts";

export const RECHECK_FRESH_MS = 15 * 60 * 1000;

/** A malformed or future timestamp cannot establish a recent observation. */
export function freshRecheck(recheck: Recheck | null, cartDigest: string, now = Date.now()): boolean {
  if (!recheck || recheck.cartDigest !== cartDigest || !recheck.allOk || !recheck.lines.length) return false;
  if (recheck.lines.some((line) => line.status !== "ok" && line.status !== "price_changed")) return false;
  const checked = Date.parse(recheck.checkedAt);
  return Number.isFinite(checked) && checked <= now && now - checked <= RECHECK_FRESH_MS;
}

export function checkoutBlockers(cart: Cart, recheck: Recheck | null, methods: PaymentMethod[], orders: Order[], now = Date.now()): string[] {
  const blockers: string[] = [];
  if (!cart.merchants.length) blockers.push("the cart is empty");
  if (orders.some((order) => order.cartDigest === cart.digest)) blockers.push("this exact cart was already paid for");
  if (cart.unpricedProductIds.length) blockers.push("some items have no known price");
  if (!recheck || recheck.cartDigest !== cart.digest) blockers.push("prices and stock need a recheck");
  else if (!recheck.allOk || recheck.lines.some((line) => line.status !== "ok" && line.status !== "price_changed")) blockers.push("the recheck found problems");
  else if (!freshRecheck(recheck, cart.digest, now)) blockers.push("the last recheck is older than 15 minutes or has an invalid timestamp");
  const ids = new Set(cart.merchants.flatMap((merchant) => merchant.lines.map((line) => line.productId)));
  const checked = new Set(recheck?.lines.map((line) => line.productId) ?? []);
  if (recheck && (ids.size !== checked.size || [...ids].some((id) => !checked.has(id)))) blockers.push("the recheck does not cover every cart item");
  if (!methods.length) blockers.push("no card connected");
  return blockers;
}
