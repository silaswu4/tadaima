"use client";

import { useCallback, useEffect, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import type { Cart, Mandate, Order, PaymentMethod, Recheck, RecheckLine, RoomPlan } from "@/backend/contracts";
import { api, money } from "./api";

/** Mirrors backend/checkout/service.ts CheckoutView (server-only module, so not imported). */
interface CheckoutView {
  cart: Cart;
  recheck: Recheck | null;
  paymentMethods: PaymentMethod[];
  mandate: Mandate | null;
  orders: Order[];
  blockers: string[];
  stripePublishableKey: string | null;
}

type Msg = { kind: "ok" | "err" | "warn"; text: string } | null;

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const cardName = (m: PaymentMethod) => `${cap(m.brand)} ending ${m.last4}`;
const when = (iso: string) => new Date(iso).toLocaleTimeString();

/** 409 is a rule saying no, 503 is Stripe not configured. */
function errMsg(status: number, error: string | null): Msg {
  if (status === 503) return { kind: "warn", text: `Payments not connected yet${error ? ` (${error})` : ""}.` };
  if (status === 409) return { kind: "err", text: `Refused: ${error}` };
  return { kind: "err", text: error ?? "Request failed" };
}

/** Every approval requirement, ticked unless the server lists a matching blocker. Unknown blockers are appended. */
const REQUIREMENTS: Array<{ label: string; blockers: string[] }> = [
  { label: "Cart has items", blockers: ["the cart is empty"] },
  { label: "Every price is known", blockers: ["some items have no known price"] },
  {
    label: "Price and stock rechecked in the last 15 minutes",
    blockers: ["prices and stock need a recheck", "the recheck found problems", "the last recheck is older than 15 minutes"],
  },
  { label: "Card connected", blockers: ["no card connected"] },
];
function checklist(blockers: string[]) {
  const rows = REQUIREMENTS.map((r) => {
    const blocker = blockers.find((b) => r.blockers.includes(b)) ?? null;
    // say which reason only when there are several
    return { label: r.label, blocker, reason: r.blockers.length > 1 ? blocker : null };
  });
  const known = new Set(REQUIREMENTS.flatMap((r) => r.blockers));
  return [...rows, ...blockers.filter((b) => !known.has(b)).map((b) => ({ label: cap(b), blocker: b, reason: null }))];
}

const stripeCache = new Map<string, Promise<Stripe | null>>();
const stripeFor = (key: string) => {
  if (!stripeCache.has(key)) stripeCache.set(key, loadStripe(key));
  return stripeCache.get(key)!;
};

export function CheckoutPanel({ base, plan, onPlanChanged }: { base: string; plan: RoomPlan | null; onPlanChanged: () => Promise<void> }) {
  const [view, setView] = useState<CheckoutView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [payMsg, setPayMsg] = useState<Msg>(null);
  const [approveMsg, setApproveMsg] = useState<Msg>(null);
  const [execMsg, setExecMsg] = useState<Msg>(null);
  const [receipt, setReceipt] = useState<Order | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ clientSecret: string; publishableKey: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<CheckoutView>("GET", `${base}/checkout`);
    if (r.ok && r.data) {
      setView(r.data);
      setLoadErr(null);
    } else setLoadErr(r.error);
  }, [base]);

  // reload on project switch and whenever the plan (and so the cart) changes
  const revision = plan?.revision;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, revision]);

  async function run<T>(label: string, fn: () => Promise<T>) {
    setBusy(label);
    try {
      return await fn();
    } finally {
      setBusy(null);
    }
  }

  const recheck = () =>
    run("recheck", async () => {
      const r = await api<CheckoutView>("POST", `${base}/checkout/recheck`);
      if (r.ok && r.data) setView(r.data);
      else setLoadErr(r.error);
      await onPlanChanged(); // changed prices land in the plan
    });

  const testCard = () =>
    run("card", async () => {
      setPayMsg(null);
      const r = await api<PaymentMethod>("POST", `${base}/checkout/card/test`);
      if (r.ok && r.data) {
        setCardId(r.data.id);
        setPayMsg({ kind: "ok", text: `Connected ${cardName(r.data)}` });
      } else setPayMsg(errMsg(r.status, r.error));
      await load();
    });

  const startSetup = () =>
    run("card", async () => {
      setPayMsg(null);
      const r = await api<{ clientSecret: string; publishableKey: string | null }>("POST", `${base}/checkout/card`, {});
      if (!r.ok || !r.data) return setPayMsg(errMsg(r.status, r.error));
      const pk = r.data.publishableKey ?? view?.stripePublishableKey ?? process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null;
      if (!pk) return setPayMsg({ kind: "warn", text: "Payments not connected yet. No Stripe publishable key is set." });
      setSetup({ clientSecret: r.data.clientSecret, publishableKey: pk });
    });

  async function finishSetup(setupIntentId: string) {
    const r = await api<PaymentMethod>("POST", `${base}/checkout/card`, { setupIntentId });
    if (r.ok && r.data) {
      setCardId(r.data.id);
      setSetup(null);
      setPayMsg({ kind: "ok", text: `Connected ${cardName(r.data)}` });
    } else setPayMsg(errMsg(r.status, r.error));
    await load();
  }

  const methods = view?.paymentMethods ?? [];
  const card = methods.find((m) => m.id === cardId) ?? methods[methods.length - 1] ?? null;

  const approve = () =>
    run("approve", async () => {
      if (!view || !card) return;
      setApproveMsg(null);
      const r = await api<Mandate>("POST", `${base}/checkout/approve`, { cartDigest: view.cart.digest, paymentMethodId: card.id });
      if (!r.ok) setApproveMsg(errMsg(r.status, r.error));
      await load();
    });

  const revoke = () =>
    run("revoke", async () => {
      const r = await api<CheckoutView>("POST", `${base}/checkout/revoke`);
      if (r.ok && r.data) setView(r.data);
      else setApproveMsg(errMsg(r.status, r.error));
    });

  const execute = () =>
    run("execute", async () => {
      setExecMsg(null);
      setReceipt(null);
      const r = await api<Order>("POST", `${base}/checkout/execute`);
      if (r.ok && r.data) setReceipt(r.data);
      else setExecMsg(errMsg(r.status, r.error));
      await load();
    });

  if (!view)
    return (
      <section className="card">
        <div className="card-title">Checkout</div>
        <p className="py-6 text-center text-sm text-zinc-400">{loadErr ? `Could not load checkout: ${loadErr}` : "Loading..."}</p>
      </section>
    );

  const { cart, mandate } = view;
  const budget = plan?.constraints.budget ?? null;
  const overBudget = budget != null && cart.subtotal.amountMinor > budget.amountMinor;
  const stores = cart.merchants.map((g) => g.merchant).join(" and ") || "no store";
  const paidAlready = view.orders.find((o) => o.cartDigest === cart.digest) ?? null;
  const mandateCard = mandate ? methods.find((m) => m.id === mandate.paymentMethodId) : null;

  return (
    <section className="card">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="card-title mb-0">Checkout</div>
        <span className="rounded bg-amber-100 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-800">Stripe test mode</span>
        <button className="btn ml-auto" onClick={() => void load()}>
          Reload
        </button>
      </div>
      {loadErr && <Note msg={{ kind: "err", text: loadErr }} />}

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Step n={1} title="Cart">
            {cart.merchants.length === 0 && <p className="text-sm text-zinc-500">Nothing to buy. The plan has no proposed purchases.</p>}
            {cart.merchants.map((g) => (
              <div key={g.merchant} className="mb-3">
                <div className="mb-1 flex items-baseline text-[13px] font-semibold">
                  {g.merchant}
                  <span className="ml-auto font-medium tabular-nums">{money(g.subtotal)}</span>
                </div>
                <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
                  {g.lines.map((l) => {
                    const url = plan?.products.find((p) => p.id === l.productId)?.sourceUrl;
                    return (
                      <li key={l.productId} className="flex items-baseline gap-2 px-2.5 py-1.5 text-[13px]">
                        <span className="min-w-0 flex-1 truncate">
                          {url ? (
                            <a href={url} target="_blank" rel="noreferrer" className="text-blue-700 underline-offset-2 hover:underline">
                              {l.label}
                            </a>
                          ) : (
                            l.label
                          )}
                        </span>
                        <span className="text-zinc-500">x{l.quantity}</span>
                        <span className="w-16 text-right tabular-nums">{money(l.observedPrice)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-[13px]">
              <dt className="text-zinc-500">Subtotal</dt>
              <dd className={`text-right font-semibold tabular-nums ${overBudget ? "text-red-600" : ""}`}>{money(cart.subtotal)}</dd>
              <dt className="text-zinc-500">Budget</dt>
              <dd className="text-right tabular-nums">{budget ? money(budget) : "no cap"}</dd>
              <dt className="text-zinc-500">Shipping and tax</dt>
              <dd className="text-right text-zinc-500">unknown until the retailer checkout</dd>
              <dt className="text-zinc-500">Cart fingerprint</dt>
              <dd className="text-right text-zinc-500">
                {cart.digest.slice(0, 10)} · revision {cart.planRevision}
              </dd>
            </dl>

            <div className="mt-3 text-xs font-medium text-zinc-500">Before approval</div>
            <ul className="mt-1 space-y-1 text-[13px]">
              {checklist(view.blockers).map((c) => (
                <Check key={c.label} ok={!c.blocker}>
                  {c.label}
                  {c.reason && <span className="text-zinc-400"> ({c.reason})</span>}
                </Check>
              ))}
            </ul>
          </Step>

          <Step n={2} title="Recheck price and stock">
            <div className="mb-2 flex items-center gap-3">
              <button className="btn" disabled={!!busy || cart.merchants.length === 0} onClick={() => void recheck()}>
                {busy === "recheck" ? "Checking live prices..." : "Recheck"}
              </button>
              {view.recheck && (
                <span className="text-xs text-zinc-500">
                  Checked at {when(view.recheck.checkedAt)}
                  {view.recheck.allOk ? "" : ", problems found"}
                </span>
              )}
            </div>
            {view.recheck ? (
              <ul className="space-y-1.5">
                {view.recheck.lines.map((l, i) => (
                  <RecheckRow key={l.productId || i} line={l} />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-zinc-500">Not checked against this cart yet. Reads each product page live, takes a few seconds.</p>
            )}
          </Step>
        </div>

        <div className="space-y-5">
          <Step n={3} title="Payment">
            {methods.length > 0 ? (
              <ul className="mb-2 space-y-1">
                {methods.map((m) => (
                  <li key={m.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-200 px-2.5 py-1.5 text-[13px]">
                      <input type="radio" name="card" checked={card?.id === m.id} onChange={() => setCardId(m.id)} />
                      <span className="font-medium">{cardName(m)}</span>
                      <span className="ml-auto text-xs text-zinc-500">
                        exp {String(m.expMonth).padStart(2, "0")}/{String(m.expYear).slice(-2)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-2 text-sm text-zinc-500">No card connected.</p>
            )}
            {!setup && (
              <div className="flex gap-2">
                <button className="btn" disabled={!!busy} onClick={() => void startSetup()}>
                  Add card
                </button>
                <button className="btn" disabled={!!busy} onClick={() => void testCard()}>
                  {busy === "card" ? "Connecting..." : "Use test Visa"}
                </button>
              </div>
            )}
            {setup && (
              <Elements stripe={stripeFor(setup.publishableKey)} options={{ fonts: [{ cssSrc: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500" }] }}>
                <CardForm clientSecret={setup.clientSecret} onDone={finishSetup} onCancel={() => setSetup(null)} onError={(t) => setPayMsg({ kind: "err", text: t })} />
              </Elements>
            )}
            <p className="mt-2 text-xs text-zinc-500">Test mode. Use 4242 4242 4242 4242, any future date, any CVC.</p>
            {payMsg && <Note msg={payMsg} />}
          </Step>

          <Step n={4} title="Approve">
            {mandate ? (
              <MandateBox mandate={mandate} card={mandateCard ?? null} cartDigest={cart.digest} busy={!!busy} onRevoke={() => void revoke()} />
            ) : (
              <>
                <button className="btn btn-primary h-9" disabled={!!busy || view.blockers.length > 0 || !card} onClick={() => void approve()}>
                  {busy === "approve" ? "Approving..." : `Approve ${money(cart.subtotal)} at ${stores}${card ? ` with ${cardName(card)}` : ""}`}
                </button>
                {paidAlready && <Note msg={{ kind: "warn", text: `This exact cart was already paid (${paidAlready.id}). Approving again would buy it twice.` }} />}
                <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                  The agent can spend up to {money(cart.subtotal)} at {stores} for 30 minutes, only for this exact cart. Any change to the cart cancels it.
                </p>
              </>
            )}
            {approveMsg && <Note msg={approveMsg} />}
          </Step>

          <Step n={5} title="Agent pays">
            <button className={`btn h-9 ${mandate ? "btn-primary" : ""}`} disabled={!!busy} onClick={() => void execute()}>
              {busy === "execute" ? "Paying..." : "Agent pays"}
            </button>
            <p className="mt-2 text-xs text-zinc-500">Charges the approved card only if the cart still matches the approval. The server refuses anything else.</p>
            {execMsg && <Note msg={execMsg} />}
            {receipt && <Receipt order={receipt} />}
          </Step>
        </div>
      </div>

      {view.orders.length > 0 && (
        <div className="mt-5 border-t border-zinc-100 pt-3">
          <div className="mb-1 text-xs font-medium text-zinc-500">Orders ({view.orders.length})</div>
          <ul className="space-y-1 text-[13px]">
            {view.orders.map((o) => (
              <li key={o.id} className="flex flex-wrap gap-x-3 rounded bg-zinc-50 px-2 py-1">
                <span className="font-medium">{o.id}</span>
                <span className="tabular-nums">{money(o.amount)}</span>
                <span className="text-zinc-500">{cap(o.payment.card)}</span>
                <span className="text-zinc-500">{o.merchantOrders.map((m) => m.merchant).join(", ")}</span>
                <span className="ml-auto text-zinc-400">{new Date(o.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <span className="flex size-5 items-center justify-center rounded-full bg-zinc-900 text-[11px] text-white">{n}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

function Check({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span
        className={`flex size-4 shrink-0 items-center justify-center rounded border text-[10px] ${ok ? "border-emerald-600 bg-emerald-600 text-white" : "border-zinc-300 bg-white"}`}
      >
        {ok ? "✓" : ""}
      </span>
      <span className={ok ? "text-emerald-800" : "text-zinc-700"}>{children}</span>
    </li>
  );
}

function Note({ msg }: { msg: NonNullable<Msg> }) {
  const cls = { ok: "bg-emerald-50 text-emerald-800", err: "bg-red-50 text-red-800", warn: "bg-amber-50 text-amber-800" }[msg.kind];
  return <p className={`mt-2 rounded-md px-2 py-1.5 text-[13px] ${cls}`}>{msg.text}</p>;
}

function RecheckRow({ line: l }: { line: RecheckLine }) {
  const badge = {
    ok: ["ok", "bg-emerald-100 text-emerald-800"],
    price_changed: ["price changed", "bg-amber-100 text-amber-800"],
    unavailable: ["unavailable", "bg-red-100 text-red-800"],
    unverified: ["unverified", "bg-zinc-200 text-zinc-700"],
  }[l.status];
  return (
    <li className="flex items-start gap-2 text-[13px] leading-snug">
      <span className={`mt-px shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase ${badge[1]}`}>{badge[0]}</span>
      <span className="min-w-0">
        {l.label}
        {l.status === "price_changed" && (
          <span className="tabular-nums text-zinc-600">
            {" "}
            {money(l.catalogPrice)} to <b className="font-semibold">{money(l.observedPrice)}</b>
          </span>
        )}
        {l.status === "ok" && l.observedPrice && <span className="tabular-nums text-zinc-500"> {money(l.observedPrice)}</span>}
        {l.note && <span className="block text-xs text-zinc-500">{l.note}</span>}
      </span>
    </li>
  );
}

function useCountdown(to: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((Date.parse(to) - now) / 1000));
  return { s, text: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` };
}

function MandateBox({
  mandate: m,
  card,
  cartDigest,
  busy,
  onRevoke,
}: {
  mandate: Mandate;
  card: PaymentMethod | null;
  cartDigest: string;
  busy: boolean;
  onRevoke: () => void;
}) {
  const left = useCountdown(m.expiresAt);
  const drifted = m.cartDigest !== cartDigest;
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50/60 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[13px] font-semibold text-emerald-900">Approved</span>
        <span className="text-xs text-emerald-800">{left.s > 0 ? `expires in ${left.text}` : "expired"}</span>
        <button className="btn btn-danger ml-auto" disabled={busy} onClick={onRevoke}>
          Revoke
        </button>
      </div>
      <dl className="grid grid-cols-[96px_1fr] gap-y-1 text-[13px]">
        <dt className="text-zinc-500">Up to</dt>
        <dd className="font-semibold tabular-nums">{money(m.maxAmount)}</dd>
        <dt className="text-zinc-500">Stores</dt>
        <dd>{m.merchants.join(", ")}</dd>
        <dt className="text-zinc-500">Card</dt>
        <dd>{card ? cardName(card) : m.paymentMethodId}</dd>
        <dt className="text-zinc-500">For cart</dt>
        <dd className="text-zinc-600">{m.cartDigest.slice(0, 10)}</dd>
        <dt className="text-zinc-500">Mandate</dt>
        <dd className="text-zinc-600">{m.id}</dd>
      </dl>
      {drifted && <Note msg={{ kind: "warn", text: "The cart changed after this approval. The agent will be refused until you approve again." }} />}
    </div>
  );
}

function Receipt({ order: o }: { order: Order }) {
  return (
    <div className="mt-3 rounded-md border border-zinc-300 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[13px] font-semibold">Paid</span>
        <span className="rounded bg-amber-400 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-950">Test mode</span>
        <span className="ml-auto text-xs text-zinc-500">{new Date(o.createdAt).toLocaleString()}</span>
      </div>
      <dl className="grid grid-cols-[96px_1fr] gap-y-1 text-[13px]">
        <dt className="text-zinc-500">Order</dt>
        <dd>{o.id}</dd>
        <dt className="text-zinc-500">Amount</dt>
        <dd className="font-semibold tabular-nums">{money(o.amount)}</dd>
        <dt className="text-zinc-500">Card</dt>
        <dd>{cap(o.payment.card)}</dd>
        <dt className="text-zinc-500">Stripe</dt>
        <dd className="break-all">{o.payment.paymentIntentId}</dd>
      </dl>
      <ul className="mt-2 space-y-1">
        {o.merchantOrders.map((m) => (
          <li key={m.merchant} className="rounded bg-zinc-50 px-2 py-1 text-xs text-zinc-600">
            <span className="mr-1 rounded bg-zinc-200 px-1 py-px text-[10px] font-semibold uppercase text-zinc-700">{m.status}</span>
            {m.note}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Card only: the SetupIntent allows other methods too, and the agent can only reuse a card off-session. */
function CardForm({
  clientSecret,
  onDone,
  onCancel,
  onError,
}: {
  clientSecret: string;
  onDone: (setupIntentId: string) => Promise<void>;
  onCancel: () => void;
  onError: (t: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [saving, setSaving] = useState(false);
  const ready = !!stripe && !!elements;

  async function save() {
    const card = elements?.getElement(CardElement);
    if (!stripe || !card) return;
    setSaving(true);
    const { setupIntent, error } = await stripe.confirmCardSetup(clientSecret, { payment_method: { card } });
    if (error || !setupIntent) {
      setSaving(false);
      return onError(error?.message ?? "Card setup failed");
    }
    await onDone(setupIntent.id);
    setSaving(false);
  }

  return (
    <div className="space-y-2 rounded-md border border-zinc-200 p-3">
      <div className="rounded-md border border-zinc-300 bg-white px-2.5 py-2">
        <CardElement options={{ hidePostalCode: true, style: { base: { fontFamily: "Inter, system-ui, sans-serif", fontSize: "14px", color: "#18181b" } } }} />
      </div>
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={!ready || saving} onClick={() => void save()}>
          {saving ? "Saving..." : "Save card"}
        </button>
        <button className="btn" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
