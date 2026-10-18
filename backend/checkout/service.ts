import "server-only";

import type { Cart, Mandate, Order, PaymentMethod, Recheck } from "@/backend/contracts";
import { cartOf } from "@/backend/checkout/cart";
import { recheckProduct } from "@/backend/checkout/recheck";
import { applyPlanChanges, getProject } from "@/backend/plan/operations";
import { projectKv } from "@/backend/plan/store";
import { attachTestVisa, chargeSavedCard, createCustomer, createSetupIntent, paymentMethodFromSetupIntent, publishableKey } from "@/backend/payments/stripe";

/**
 * Checkout with an agent that pays, under rules the shopper sets:
 *
 *   recheck   live price and stock for every line; changed prices update the plan
 *   approve   the shopper approves THIS cart (by digest) with a saved card,
 *             creating a mandate: max amount, allowed merchants, 30 min expiry
 *   execute   the agent charges the card, only if the cart is still exactly the
 *             approved one and within the mandate. Idempotent per mandate.
 *
 * Money is Stripe test mode. Retailer orders are simulated and labeled so.
 */

const RECHECK_FRESH_MS = 15 * 60 * 1000;
const MANDATE_TTL_MS = 30 * 60 * 1000;

export class CheckoutRefused extends Error {}

interface Wallet {
  customerId: string;
  methods: PaymentMethod[];
}

const wallet = (projectId: string) => projectKv.get<Wallet>(projectId, "wallet");
const mandate = (projectId: string) => projectKv.get<Mandate>(projectId, "mandate");
const orders = async (projectId: string) => (await projectKv.get<Order[]>(projectId, "orders")) ?? [];

async function ensureWallet(projectId: string): Promise<Wallet> {
  const w = await wallet(projectId);
  if (w) return w;
  const fresh = { customerId: await createCustomer(projectId), methods: [] };
  await projectKv.set(projectId, "wallet", fresh);
  return fresh;
}

async function addMethod(projectId: string, w: Wallet, pm: PaymentMethod) {
  w.methods = [...w.methods.filter((m) => m.id !== pm.id), pm];
  await projectKv.set(projectId, "wallet", w);
  return pm;
}

const live = (m: Mandate | null) => (m && m.status === "active" && Date.parse(m.expiresAt) > Date.now() ? m : null);

export interface CheckoutView {
  cart: Cart;
  /** Latest recheck, only if it was run against this exact cart. */
  recheck: Recheck | null;
  paymentMethods: PaymentMethod[];
  mandate: Mandate | null;
  orders: Order[];
  /** Why approval isn't possible yet, if it isn't. */
  blockers: string[];
  stripePublishableKey: string | null;
}

export async function getCheckout(projectId: string): Promise<CheckoutView> {
  const { plan } = await getProject(projectId);
  const cart = cartOf(plan);
  const [rc, w, m, o] = await Promise.all([projectKv.get<Recheck>(projectId, "recheck"), wallet(projectId), mandate(projectId), orders(projectId)]);
  const recheck = rc && rc.cartDigest === cart.digest ? rc : null;
  const blockers: string[] = [];
  if (!cart.merchants.length) blockers.push("the cart is empty");
  if (cart.unpricedProductIds.length) blockers.push("some items have no known price");
  if (!recheck) blockers.push("prices and stock need a recheck");
  else if (!recheck.allOk) blockers.push("the recheck found problems");
  else if (Date.now() - Date.parse(recheck.checkedAt) > RECHECK_FRESH_MS) blockers.push("the last recheck is older than 15 minutes");
  if (!w?.methods.length) blockers.push("no card connected");
  return { cart, recheck, paymentMethods: w?.methods ?? [], mandate: live(m), orders: o, blockers, stripePublishableKey: publishableKey() };
}

export async function runRecheck(projectId: string): Promise<CheckoutView> {
  const { plan } = await getProject(projectId);
  const cart = cartOf(plan);
  const ids = cart.merchants.flatMap((g) => g.lines.map((l) => l.productId));
  const results = await Promise.all(ids.map((id) => recheckProduct(plan.products.find((p) => p.id === id)!)));

  // live prices replace stale ones in the plan, so the cart (and its digest) shows what checkout would really cost
  const changed = results.flatMap((r) => (r.observed && r.status !== "ok" ? [r.observed] : []));
  let digest = cart.digest;
  let updateNote: string | null = null;
  if (changed.length) {
    const applied = await applyPlanChanges(projectId, plan.revision, [{ kind: "add_products", products: changed, evidence: [] }]);
    if (applied.ok) digest = cartOf(applied.plan).digest;
    else updateNote = applied.reason === "stale_revision" ? "the room changed during the recheck" : applied.validations.filter((v) => v.status === "fail").map((v) => v.message).join(" ");
  }

  const lines = results.map((r) => ({ productId: r.productId, label: r.label, status: r.status, catalogPrice: r.catalogPrice, observedPrice: r.observedPrice, note: r.note }));
  const recheck: Recheck = {
    projectId,
    cartDigest: digest,
    // a price change is fine once the plan reflects it; missing stock or an unreadable page is not
    allOk: !updateNote && lines.every((l) => l.status === "ok" || l.status === "price_changed"),
    lines: updateNote ? [...lines, { productId: "", label: "plan update", status: "unverified", catalogPrice: null, observedPrice: null, note: updateNote }] : lines,
    checkedAt: new Date().toISOString(),
  };
  await projectKv.set(projectId, "recheck", recheck);
  return getCheckout(projectId);
}

export async function startCardSetup(projectId: string) {
  const w = await ensureWallet(projectId);
  return { clientSecret: await createSetupIntent(w.customerId), publishableKey: publishableKey() };
}

export async function finishCardSetup(projectId: string, setupIntentId: string) {
  const w = await ensureWallet(projectId);
  return addMethod(projectId, w, await paymentMethodFromSetupIntent(setupIntentId, w.customerId));
}

export async function connectTestCard(projectId: string) {
  const w = await ensureWallet(projectId);
  return addMethod(projectId, w, await attachTestVisa(w.customerId));
}

/** The shopper's approval. Only callable from the UI with the digest they were shown. */
export async function approve(projectId: string, cartDigest: string, paymentMethodId: string): Promise<Mandate> {
  const view = await getCheckout(projectId);
  if (view.cart.digest !== cartDigest) throw new CheckoutRefused("the cart changed since you looked at it; review it again");
  if (view.blockers.length) throw new CheckoutRefused(`can't approve yet: ${view.blockers.join("; ")}`);
  if (!view.paymentMethods.some((m) => m.id === paymentMethodId)) throw new CheckoutRefused("that card isn't connected");
  const now = Date.now();
  const m: Mandate = {
    id: `mdt_${crypto.randomUUID().slice(0, 12)}`,
    projectId,
    cartDigest,
    maxAmount: view.cart.subtotal,
    merchants: view.cart.merchants.map((g) => g.merchant),
    paymentMethodId,
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + MANDATE_TTL_MS).toISOString(),
    status: "active",
  };
  await projectKv.set(projectId, "mandate", m);
  return m;
}

export async function revoke(projectId: string) {
  const m = await mandate(projectId);
  if (m && m.status === "active") await projectKv.set(projectId, "mandate", { ...m, status: "revoked" });
  return getCheckout(projectId);
}

/** The agent's action. Pays only for exactly what was approved. */
export async function execute(projectId: string): Promise<Order> {
  const m = live(await mandate(projectId));
  if (!m) throw new CheckoutRefused("there's no active approval; the shopper has to approve the cart first");
  const { cart, paymentMethods } = await getCheckout(projectId);
  if (cart.digest !== m.cartDigest) throw new CheckoutRefused("the cart changed after it was approved; it needs a new approval");
  if (cart.subtotal.amountMinor > m.maxAmount.amountMinor || cart.subtotal.currency !== m.maxAmount.currency) throw new CheckoutRefused("the total is above the approved amount");
  if (cart.merchants.some((g) => !m.merchants.includes(g.merchant))) throw new CheckoutRefused("the cart includes a store that wasn't approved");
  const card = paymentMethods.find((p) => p.id === m.paymentMethodId);
  if (!card) throw new CheckoutRefused("the approved card is no longer connected");

  // claim the mandate before charging so two agents can't both spend it
  await projectKv.set(projectId, "mandate", { ...m, status: "used" });
  const w = (await wallet(projectId))!;
  const charge = await chargeSavedCard({
    customerId: w.customerId,
    paymentMethodId: card.id,
    amount: cart.subtotal,
    mandateId: m.id,
    description: `Tadaima room plan ${cart.digest} (${cart.merchants.map((g) => g.merchant).join(", ")})`,
  });
  if (charge.status !== "succeeded") {
    await projectKv.set(projectId, "mandate", { ...m, status: "active" });
    throw new CheckoutRefused(`the card was declined: ${charge.error}`);
  }

  const order: Order = {
    id: `ord_${crypto.randomUUID().slice(0, 12)}`,
    projectId,
    mandateId: m.id,
    cartDigest: cart.digest,
    lines: cart.merchants.flatMap((g) => g.lines),
    amount: cart.subtotal,
    payment: { provider: "stripe_test", paymentIntentId: charge.id, status: "succeeded", card: `${card.brand} ending ${card.last4}` },
    merchantOrders: cart.merchants.map((g) => ({
      merchant: g.merchant,
      status: "simulated",
      note: `Not placed with ${g.merchant}: retailer ordering is simulated in this build. Shipping and tax were not charged.`,
    })),
    testMode: true,
    createdAt: new Date().toISOString(),
  };
  await projectKv.set(projectId, "orders", [order, ...(await orders(projectId))]);
  return order;
}
