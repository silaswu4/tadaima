"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Money, Order } from "@/backend/contracts";
import { checkoutClient } from "@/backend/checkout/client";
import type { CheckoutView } from "@/backend/checkout/types";
import { freshRecheck } from "@/backend/checkout/policy";
import "./RoomCheckout.css";

export interface RoomCheckoutProps {
  projectId: string;
  planRevision: number;
  onPlanRefresh: () => Promise<void>;
  onClose?: () => void;
  testPaymentsAvailable?: boolean;
}

const money = (value: Money | null) => value ? new Intl.NumberFormat("en-US", { style: "currency", currency: value.currency }).format(value.amountMinor / 100) : "price unknown";
const message = (error: unknown) => error instanceof Error ? error.message : "checkout request failed";

/** A new room/revision clears local approval and cancels outstanding UI requests. */
export function RoomCheckout(props: RoomCheckoutProps) {
  return <CheckoutSession key={`${props.projectId}:${props.planRevision}`} {...props} />;
}

function CheckoutSession({ projectId, planRevision, onPlanRefresh, onClose, testPaymentsAvailable = false }: RoomCheckoutProps) {
  const client = useMemo(() => checkoutClient(projectId), [projectId]);
  const [view, setView] = useState<CheckoutView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cardId, setCardId] = useState("");
  const [approvedDigest, setApprovedDigest] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Order | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lifecycle = useRef({ active: false, controller: new AbortController() });
  const operation = useRef(false);

  const read = useCallback(async (signal: AbortSignal) => {
    const next = await client.get(signal);
    if (next.cart.projectId !== projectId) throw new Error("checkout returned a different room; reload your room before continuing");
    if (!signal.aborted) { setView(next); setNow(Date.now()); }
    return next;
  }, [client, projectId]);

  useEffect(() => {
    const current = { active: true, controller: new AbortController() };
    lifecycle.current = current;
    void client.get(current.controller.signal).then((next) => {
      if (next.cart.projectId !== projectId) throw new Error("checkout returned a different room; reload your room before continuing");
      if (current.active) { setView(next); setNow(Date.now()); }
    }).catch((reason) => { if (current.active) setError(message(reason)); });
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => { current.active = false; current.controller.abort(); clearInterval(timer); };
  }, [client, projectId]);

  async function run(label: string, action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    const current = lifecycle.current;
    const signal = current.controller.signal;
    setBusy(label);
    setError(null);
    try { await action(signal); }
    catch (reason) { if (current.active && !signal.aborted) { setApprovedDigest(null); setError(message(reason)); } }
    finally { operation.current = false; if (current.active && !signal.aborted) setBusy(null); }
  }

  const methods = view?.paymentMethods ?? [];
  const card = methods.find((method) => method.id === cardId) ?? methods[methods.length - 1] ?? null;
  const synchronized = view?.cart.planRevision === planRevision;
  const mandate = view?.mandate;
  const readyToApprove = !!view && synchronized && !busy && !view.blockers.length && !!card && freshRecheck(view.recheck, view.cart.digest, now);
  const readyToPay = readyToApprove && !!mandate && mandate.cartDigest === approvedDigest && mandate.paymentMethodId === card?.id && Date.parse(mandate.expiresAt) > now;
  const paid = receipt ?? view?.orders.find((order) => order.cartDigest === view.cart.digest);

  return (
    <section className="room-checkout" aria-label="Room checkout" aria-busy={!!busy}>
      <div className="room-checkout__heading">
        <h3>Checkout</h3><span>Stripe test mode</span>
        {onClose && <button type="button" onClick={onClose} disabled={!!busy}>Back to basket</button>}
      </div>
      <p className="room-checkout__disclosure">Test payments only. Retailer orders are simulated; no furniture is ordered. Shipping and tax remain unknown.</p>
      {error && <p className="room-checkout__error" role="alert">{error}</p>}
      {!view ? <p role="status">{error ? "Checkout is unavailable for this room." : "Loading this room’s checkout…"}</p> : <>
        {view.cart.merchants.map((merchant) => (
          <div className="room-checkout__merchant" key={merchant.merchant}>
            <h4>{merchant.merchant}<span>{money(merchant.subtotal)}</span></h4>
            <ul>{merchant.lines.map((line) => <li key={line.productId}>
              <span>{line.label}<small>{line.variantId ? `Variant: ${line.variantId} · ` : ""}{line.quantity} × {money(line.observedPrice)}</small></span>
              <strong>{money(line.observedPrice ? { ...line.observedPrice, amountMinor: line.observedPrice.amountMinor * line.quantity } : null)}</strong>
            </li>)}</ul>
          </div>
        ))}
        {!view.cart.merchants.length && <p>The room has no proposed purchases.</p>}
        <dl className="room-checkout__summary"><dt>Subtotal before shipping and tax</dt><dd>{money(view.cart.subtotal)}</dd><dt>Exact cart</dt><dd><code>{view.cart.digest}</code></dd><dt>Room revision</dt><dd>{view.cart.planRevision}</dd></dl>
        {!synchronized && <p className="room-checkout__error">The room changed on the server. Refresh it before approving this cart. <button type="button" disabled={!!busy} onClick={() => void run("refresh", async () => { await onPlanRefresh(); })}>Refresh room</button></p>}
        <div className="room-checkout__step">
          <h4>1. Verify live price and stock</h4>
          <button type="button" disabled={!!busy || !view.cart.merchants.length} onClick={() => void run("recheck", async (signal) => {
            setApprovedDigest(null);
            const next = await client.recheck(signal);
            if (!signal.aborted) { setView(next); setNow(Date.now()); }
            if (!signal.aborted) await onPlanRefresh();
          })}>{busy === "recheck" ? "Checking retailer pages…" : "Recheck price and stock"}</button>
          {view.recheck && <><p>Checked {new Date(view.recheck.checkedAt).toLocaleTimeString()} · {view.recheck.allOk ? "verified" : "review needed"}</p><ul className="room-checkout__rechecks">{view.recheck.lines.map((line, index) => <li key={`${line.productId}:${index}`} data-status={line.status}><span>{line.label}</span><small>{line.status.replaceAll("_", " ")}{line.observedPrice ? ` · ${money(line.observedPrice)}` : ""}{line.note ? ` · ${line.note}` : ""}</small></li>)}</ul></>}
        </div>
        <div className="room-checkout__step">
          <h4>2. Choose a test card</h4>
          {methods.map((method) => <label className="room-checkout__card" key={method.id}><input type="radio" name={`checkout-card-${projectId}`} checked={method.id === card?.id} disabled={!!busy} onChange={() => { setCardId(method.id); setApprovedDigest(null); }} /><span>{method.brand} ending {method.last4} · test card</span></label>)}
          {(testPaymentsAvailable || view.testPaymentsAvailable) ? <button type="button" disabled={!!busy} onClick={() => void run("card", async (signal) => {
            const method = await client.connectTestCard(signal);
            if (!signal.aborted) { setCardId(method.id); setApprovedDigest(null); await read(signal); }
          })}>{busy === "card" ? "Connecting test card…" : "Connect Stripe test Visa"}</button> : <p>Test payments will become available when the local Stripe test key is configured.</p>}
        </div>
        {!!view.blockers.length && <div className="room-checkout__blockers"><h4>Before approval</h4><ul>{view.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
        <div className="room-checkout__step">
          <h4>3. Approve this exact cart</h4>
          <p>Authorize {money(view.cart.subtotal)} at {view.cart.merchants.map((merchant) => merchant.merchant).join(", ") || "no retailer"}, for this cart only, for 30 minutes.</p>
          <button className="room-checkout__primary" type="button" disabled={!readyToApprove} onClick={() => void run("approve", async (signal) => {
            if (!card) return;
            const approved = await client.approve(view.cart.digest, card.id, signal);
            const next = await read(signal);
            if (!signal.aborted && next.mandate?.id === approved.id && next.cart.digest === approved.cartDigest) setApprovedDigest(approved.cartDigest);
          })}>{busy === "approve" ? "Approving…" : `Approve ${money(view.cart.subtotal)} test payment`}</button>
          {view.staleMandate && <p>Your earlier approval belongs to a different cart. Review and approve this one.</p>}
          {mandate && <div className="room-checkout__approval"><p>{approvedDigest === mandate.cartDigest ? "Approved" : "An earlier approval exists; confirm it again after this room change."} · expires {new Date(mandate.expiresAt).toLocaleTimeString()}</p><button type="button" disabled={!!busy} onClick={() => void run("revoke", async (signal) => { const next = await client.revoke(signal); if (!signal.aborted) { setApprovedDigest(null); setView(next); } })}>Revoke approval</button></div>}
        </div>
        <div className="room-checkout__step">
          <h4>4. Run the approved test payment</h4>
          <button className="room-checkout__primary" type="button" disabled={!readyToPay} onClick={() => void run("execute", async (signal) => {
            const order = await client.execute(signal);
            if (!signal.aborted) { setReceipt(order); setApprovedDigest(null); await read(signal); }
          })}>{busy === "execute" ? "Running Stripe test payment…" : `Pay ${money(view.cart.subtotal)} in test mode`}</button>
        </div>
        {paid && <div className="room-checkout__receipt" role="status"><h4>Stripe test payment succeeded</h4><p>{money(paid.amount)} · {paid.payment.card}</p><p>Test receipt: {paid.id}</p><p className="room-checkout__reference">{paid.payment.paymentIntentId}</p><ul>{paid.merchantOrders.map((order) => <li key={order.merchant}>{order.note}</li>)}</ul></div>}
      </>}
      <button className="room-checkout__reload" type="button" disabled={!!busy} onClick={() => void run("reload", async (signal) => { setApprovedDigest(null); await read(signal); })}>Reload checkout</button>
    </section>
  );
}
