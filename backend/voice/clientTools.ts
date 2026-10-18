import type { ApplyResult, Cart, Mandate, Order, PaymentMethod, PlanProposal, Recheck, RoomPlan } from "@/backend/contracts";

type CheckoutView = { cart: Cart; recheck: Recheck | null; paymentMethods: PaymentMethod[]; mandate: Mandate | null; orders: Order[]; blockers: string[] };

/**
 * Browser-safe implementations of the voice agent's client tools. They call
 * the same routes as the UI and return plain sentences, which is what the
 * agent hears. Pass the result to ElevenLabs' `clientTools`:
 *
 *   const tools = voiceClientTools({ projectId, getSelectedItemId: () => selected, onPlan: setPlan });
 *   <ConversationProvider clientTools={tools}> ... startSession({ conversationToken })
 *
 * Get the token from GET /api/voice/token.
 */

const dollars = (minor: number) => `$${Math.round(minor / 100).toLocaleString("en-US")}`;

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json as T;
}

export function voiceClientTools(opts: {
  projectId: string;
  getSelectedItemId: () => string | null;
  /** Called with the new plan after an applied change, so the viewer updates. */
  onPlan?: (plan: RoomPlan) => void;
  /** Called with each proposal so the UI can show the diff while it's read aloud. */
  onProposal?: (proposal: PlanProposal) => void;
  /** Called after recheck or payment so checkout UI can refresh. */
  onCheckout?: () => void;
}) {
  const base = `/api/projects/${opts.projectId}`;
  const proposals = new Map<string, PlanProposal>();

  return {
    get_room: async () => {
      const res = await fetch(base);
      if (!res.ok) return "I couldn't load the room.";
      const { plan, cost } = (await res.json()) as { plan: RoomPlan; cost: { knownSubtotal: { amountMinor: number } } };
      const selected = opts.getSelectedItemId();
      const lines = plan.items.map((i) => {
        const price = plan.products.find((p) => p.id === i.productId)?.price;
        const tag = i.origin === "existing_owned" ? "owned" : price ? dollars(price.amountMinor) : "price unknown";
        return `${i.label} (${tag}${i.locked ? ", locked" : ""}${i.seats ? `, seats ${i.seats}` : ""}${i.id === selected ? ", selected" : ""})`;
      });
      const budget = plan.constraints.budget;
      return `Items: ${lines.join("; ")}. New purchases total ${dollars(cost.knownSubtotal.amountMinor)}${
        budget ? ` of a ${dollars(budget.amountMinor)} budget` : ""
      }. Needs to seat ${plan.constraints.minimumSeats ?? "any number of"} people.`;
    },

    propose_change: async ({ request }: { request: string }) => {
      try {
        const p = await post<PlanProposal>(`${base}/proposals`, { intent: request, selectedItemId: opts.getSelectedItemId() });
        proposals.set(p.id, p);
        opts.onProposal?.(p);
        const failed = p.validations.filter((v) => v.status === "fail");
        const diff = p.costBefore.knownSubtotal.amountMinor - p.costAfter.knownSubtotal.amountMinor;
        if (p.changes.length === 0) return `No change proposed. ${p.summary}`;
        return `Proposal ${p.id}. ${p.summary} ${
          failed.length ? `It fails these checks: ${failed.map((f) => f.message).join(" ")}` : "It passes every check."
        } New purchases go from ${dollars(p.costBefore.knownSubtotal.amountMinor)} to ${dollars(p.costAfter.knownSubtotal.amountMinor)}${
          diff > 0 ? `, saving ${dollars(diff)}` : ""
        }.`;
      } catch (e) {
        return `Planning failed: ${(e as Error).message}`;
      }
    },

    get_cart: async () => {
      const res = await fetch(`${base}/checkout`);
      if (!res.ok) return "I couldn't load the cart.";
      return describeCheckout((await res.json()) as CheckoutView);
    },

    recheck_cart: async () => {
      try {
        const v = await post<CheckoutView>(`${base}/checkout/recheck`, {});
        opts.onCheckout?.();
        const issues = (v.recheck?.lines ?? []).filter((l) => l.status !== "ok");
        const changes = issues.map((l) =>
          l.status === "price_changed" && l.catalogPrice && l.observedPrice
            ? `${l.label} is now ${dollars(l.observedPrice.amountMinor)} (was ${dollars(l.catalogPrice.amountMinor)})`
            : `${l.label}: ${l.status.replace("_", " ")}${l.note ? `, ${l.note}` : ""}`,
        );
        return `Rechecked. ${changes.length ? changes.join(". ") + "." : "Every price and stock status matches."} ${describeCheckout(v)}`;
      } catch (e) {
        return `Recheck failed: ${(e as Error).message}`;
      }
    },

    pay_now: async () => {
      const res = await fetch(`${base}/checkout/execute`, { method: "POST" });
      const json = await res.json();
      opts.onCheckout?.();
      if (!res.ok) return `Not paid: ${json.error ?? `request failed (${res.status})`}`;
      const o = json as Order;
      return `paid: ${dollars(o.amount.amountMinor)} on ${o.payment.card}, order ${o.id}. Test mode, so no real money moved and the retailer orders are simulated.`;
    },

    apply_proposal: async ({ proposal_id }: { proposal_id: string }) => {
      const p = proposals.get(proposal_id);
      if (!p) return "I don't have that proposal anymore. Ask me to plan it again.";
      try {
        const r = await post<ApplyResult>(`${base}/proposals/${proposal_id}/apply`, { expectedRevision: p.baseRevision });
        if (r.ok) {
          opts.onPlan?.(r.plan);
          return "ok: the room is updated.";
        }
        if (r.reason === "stale_revision") return "Not applied: the room changed since this was planned. Ask me to plan it again.";
        return `Not applied: ${r.validations.filter((v) => v.status === "fail").map((v) => v.message).join(" ")}`;
      } catch (e) {
        return `Not applied: ${(e as Error).message}`;
      }
    },
  };
}

function describeCheckout(v: CheckoutView) {
  const stores = v.cart.merchants.map((g) => `${g.merchant}: ${g.lines.map((l) => `${l.label} ${l.observedPrice ? dollars(l.observedPrice.amountMinor) : "price unknown"}`).join(", ")}`);
  const card = v.paymentMethods[0];
  return [
    `Cart total ${dollars(v.cart.subtotal.amountMinor)} before shipping and tax. ${stores.join(". ")}.`,
    card ? `Card on file: ${card.brand} ending ${card.last4}.` : "No card connected.",
    v.mandate
      ? `Approved by the shopper for up to ${dollars(v.mandate.maxAmount.amountMinor)} until ${new Date(v.mandate.expiresAt).toLocaleTimeString()}.`
      : v.blockers.length
        ? `Not ready to approve: ${v.blockers.join("; ")}.`
        : "Ready for the shopper to approve on screen. Not approved yet.",
  ].join(" ");
}
