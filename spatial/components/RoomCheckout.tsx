"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Money, Order } from "@/backend/contracts";
import { checkoutClient } from "@/backend/checkout/client";
import type { CheckoutView } from "@/backend/checkout/types";
import "./RoomCheckout.css";

export interface RoomCheckoutProps {
  projectId: string;
  planRevision: number;
  onPlanRefresh: () => Promise<void>;
  testPaymentsAvailable?: boolean;
}

const money = (value: Money | null | undefined) =>
  value ? new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency }).format(value.amountMinor / 100) : "price unknown";
const message = (error: unknown) => (error instanceof Error ? error.message : "Checkout couldn't finish.");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A new room or revision starts a fresh checkout. */
export function RoomCheckout(props: RoomCheckoutProps) {
  return <CheckoutSession key={`${props.projectId}:${props.planRevision}`} {...props} />;
}

/**
 * One button: "Check out $X". Clicking it is the shopper's approval of that
 * exact amount; the app then rechecks live price and stock, connects the test
 * card if needed, approves this exact cart and pays it, saying each step. If
 * anything changed (a price, stock), it stops and says what.
 */
function CheckoutSession({ projectId, onPlanRefresh, testPaymentsAvailable = false }: RoomCheckoutProps) {
  const client = useMemo(() => checkoutClient(projectId), [projectId]);
  const [view, setView] = useState<CheckoutView | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Order | null>(null);
  const alive = useRef(new AbortController());

  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    client.get(controller.signal).then((v) => !controller.signal.aborted && setView(v)).catch((e) => !controller.signal.aborted && setProblem(message(e)));
    return () => controller.abort();
  }, [client]);

  async function checkout() {
    if (!view || step) return;
    const signal = alive.current.signal;
    const approvedTotal = view.cart.subtotal.amountMinor;
    setProblem(null);
    try {
      setStep("Checking live prices and stock");
      let next = await client.recheck(signal);
      await onPlanRefresh();
      const issues = (next.recheck?.lines ?? []).filter((l) => l.status === "unavailable" || l.status === "price_changed");
      if (issues.length || next.cart.subtotal.amountMinor !== approvedTotal) {
        setView(next);
        setProblem(
          `${issues.map((l) => (l.status === "unavailable" ? `${l.label.split(",")[0]} is out of stock` : `${l.label.split(",")[0]} is now ${money(l.observedPrice)}`)).join(". ") || "The total changed"}. Review the new total, then check out again.`,
        );
        return;
      }
      if (!next.paymentMethods.length) {
        setStep("Connecting the test card");
        await client.connectTestCard(signal);
        next = await client.get(signal);
      }
      if (next.blockers.length) {
        setView(next);
        setProblem(`${capital(next.blockers[0])}.`);
        return;
      }
      setStep(`Approving ${money(next.cart.subtotal)}`);
      const card = next.paymentMethods[next.paymentMethods.length - 1];
      await client.approve(next.cart.digest, card.id, signal);
      setStep("Paying");
      const order = await client.execute(signal);
      setReceipt(order);
      setView(await client.get(signal));
    } catch (e) {
      if (!signal.aborted) setProblem(message(e));
    } finally {
      if (!signal.aborted) setStep(null);
    }
  }

  const paid = receipt ?? view?.orders.find((o) => o.cartDigest === view.cart.digest) ?? null;
  const payable = !!view && view.cart.merchants.length > 0 && (testPaymentsAvailable || view.testPaymentsAvailable);
  const overBudget = view?.blockers.find((b) => /budget/i.test(b));

  if (paid) {
    return (
      <section className="room-checkout" aria-label="Checkout">
        <div className="room-checkout__receipt" role="status">
          <strong>Paid {money(paid.amount)}</strong>
          <span>
            {paid.payment.card} · test mode, nothing was ordered
          </span>
        </div>
      </section>
    );
  }

  return (
    <section className="room-checkout" aria-label="Checkout" aria-busy={!!step}>
      {problem && (
        <p className="room-checkout__error" role="alert">
          {problem}
        </p>
      )}
      {overBudget && !problem && <p className="room-checkout__note">{capital(overBudget)}. Raise the budget or remove something first.</p>}
      <button className="room-checkout__primary" type="button" disabled={!payable || !!step || !!overBudget} onClick={() => void checkout()}>
        {step ? `${step}…` : view ? `Check out ${money(view.cart.subtotal)}` : "Loading…"}
      </button>
      <p className="room-checkout__note">Stripe test mode. No real money moves and nothing is ordered.</p>
    </section>
  );
}
