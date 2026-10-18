import "server-only";

import Stripe from "stripe";
import type { Money, PaymentMethod } from "@/backend/contracts";

/**
 * Stripe in TEST MODE only. Card numbers never touch our servers: the browser
 * collects them with Stripe Elements against a SetupIntent, and we only keep
 * Stripe's ids. A live key is refused outright so nothing here can move real money.
 */

let client: Stripe | null = null;
function stripe() {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new PaymentsUnavailable("payments are not configured (STRIPE_SECRET_KEY)");
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) throw new PaymentsUnavailable("refusing a non-test Stripe key");
  client = new Stripe(key);
  return client;
}

export class PaymentsUnavailable extends Error {}

export const publishableKey = () => process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? process.env.STRIPE_PUBLISHABLE_KEY ?? null;

export async function createCustomer(projectId: string) {
  const c = await stripe().customers.create({ metadata: { projectId }, description: `Tadaima test shopper (${projectId})` });
  return c.id;
}

/** Client secret for Stripe Elements to save a card for later, agent-initiated charges. */
export async function createSetupIntent(customerId: string) {
  const si = await stripe().setupIntents.create({ customer: customerId, usage: "off_session", automatic_payment_methods: { enabled: true, allow_redirects: "never" } });
  return si.client_secret!;
}

/** Read back the card a SetupIntent saved. */
export async function paymentMethodFromSetupIntent(setupIntentId: string, customerId: string): Promise<PaymentMethod> {
  const si = await stripe().setupIntents.retrieve(setupIntentId);
  if (si.customer !== customerId) throw new PaymentsUnavailable("that card setup belongs to someone else");
  if (si.status !== "succeeded" || !si.payment_method) throw new PaymentsUnavailable(`card setup is ${si.status}`);
  const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method.id;
  return describe(await stripe().paymentMethods.retrieve(pmId));
}

/** Dev shortcut: attach Stripe's built-in test Visa without a card form. */
export async function attachTestVisa(customerId: string): Promise<PaymentMethod> {
  const pm = await stripe().paymentMethods.attach("pm_card_visa", { customer: customerId });
  return describe(pm);
}

function describe(pm: Stripe.PaymentMethod): PaymentMethod {
  return {
    id: pm.id,
    provider: "stripe_test",
    brand: pm.card?.brand ?? "card",
    last4: pm.card?.last4 ?? "????",
    expMonth: pm.card?.exp_month ?? 0,
    expYear: pm.card?.exp_year ?? 0,
  };
}

/**
 * Charge a saved card without the shopper present, under an approved mandate.
 * The idempotency key is the mandate id, so a retried call can never charge twice.
 */
export async function chargeSavedCard(opts: { customerId: string; paymentMethodId: string; amount: Money; mandateId: string; description: string }) {
  try {
    const pi = await stripe().paymentIntents.create(
      {
        amount: opts.amount.amountMinor,
        currency: opts.amount.currency.toLowerCase(),
        customer: opts.customerId,
        payment_method: opts.paymentMethodId,
        off_session: true,
        confirm: true,
        description: opts.description,
        metadata: { mandateId: opts.mandateId },
      },
      { idempotencyKey: `mandate_${opts.mandateId}` },
    );
    return { id: pi.id, status: pi.status === "succeeded" ? ("succeeded" as const) : ("failed" as const), error: pi.status === "succeeded" ? null : `payment ${pi.status}` };
  } catch (e) {
    if (e instanceof Stripe.errors.StripeCardError) {
      return { id: (e.raw as { payment_intent?: { id?: string } })?.payment_intent?.id ?? "none", status: "failed" as const, error: e.message };
    }
    throw e;
  }
}
