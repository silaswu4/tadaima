import type { ApplyResult, ValidationResult, Cart, FloorSpot, FurnitureCategory, Job, Mandate, Order, PaymentMethod, PlaceResult, PlanProposal, Recheck, RoomPlan, ShopJobOutput, ShopResult } from "@/backend/contracts";

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
 *
 * Shopping is async: shop_here answers at once with catalog matches, then
 * keeps polling the live search and calls `onShopUpdate` with an
 * "[app update] ..." sentence when it lands. Pass that to the conversation's
 * sendUserMessage so the agent tells the shopper without being asked.
 */

/** Only the checks this change broke; others may have been failing already and aren't the reason. */
const whyBlocked = (r: { validations: ValidationResult[]; blocking?: ValidationResult[] }) =>
  (r.blocking ?? r.validations.filter((v) => v.status === "fail")).map((v) => v.message).join(" ");

const dollars = (minor: number) => `$${Math.round(minor / 100).toLocaleString("en-US")}`;
const cm = (m: number) => `${Math.round(m * 100)} cm`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 3000;
const POLL_LIMIT_MS = 8 * 60 * 1000;
const SAY = 4;

/** One result as a sentence, numbered so the shopper can say "the first one". */
function describeResult(r: ShopResult, n: number) {
  const p = r.product;
  const [w, , d] = p.dimensions ?? [0, 0, 0];
  const where = r.placement
    ? r.placement.againstWallId
      ? `fits against the ${r.placement.againstWallId.replace("wall_", "")} wall`
      : r.placement.distanceM > 0.3
        ? `fits ${r.placement.distanceM} m from the spot`
        : "fits right there"
    : r.problems[0] ?? "doesn't fit";
  const money = r.withinBudget === false && r.overBudgetUsd !== null ? `, but it'd put you $${Math.ceil(r.overBudgetUsd)} over budget` : "";
  return `${n}) ${p.label}, ${p.price ? dollars(p.price.amountMinor) : "price unknown"}, ${p.dimensions ? `${cm(w)} wide x ${cm(d)} deep, ` : ""}${r.fits ? where : `doesn't fit: ${where}`}${r.fits ? money : ""}${r.source === "live" ? " (just found live)" : ""}`;
}

export function describeShop(job: Job<ShopJobOutput>) {
  const out = job.output!;
  const fitting = out.results.filter((r) => r.fits);
  const shown = (fitting.length ? fitting : out.results).slice(0, SAY);
  const list = shown.map((r) => describeResult(r, out.results.indexOf(r) + 1)).join(". ");
  const status =
    out.live === "running"
      ? "Still searching the store live; I'll get an update in a minute or two."
      : out.live === "failed"
        ? "The live store search didn't finish, so these are from our catalog."
        : out.live === "done"
          ? "The live search is done."
          : "";
  if (!out.results.length) return `Search ${job.id}: nothing under that price in our catalog yet. ${status}`;
  return `Search ${job.id}: ${fitting.length} of ${out.results.length} fit. ${list}. ${status}`.trim();
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json as T;
}

export function voiceClientTools(opts: {
  projectId: string;
  getSelectedItemId: () => string | null;
  /** The floor point the shopper is looking at or last tapped, from the viewer. */
  getSpot?: () => FloorSpot | null;
  /** Called with each shopping job as it updates, so the UI can show the options. */
  onShop?: (job: Job<ShopJobOutput>) => void;
  /** Called after place_product puts a piece in the room (instead of onPlan/onCheckout), e.g. to select it. */
  onPlaced?: (itemId: string) => void;
  /** Called once when a live search finishes, with a sentence for the agent ("[app update] ..."). */
  onShopUpdate?: (message: string) => void;
  /** Return false once the conversation ends, to stop polling. */
  isActive?: () => boolean;
  /** Called with the new plan after an applied change, so the viewer updates. */
  onPlan?: (plan: RoomPlan) => void;
  /** Called with each proposal so the UI can show the diff while it's read aloud. */
  onProposal?: (proposal: PlanProposal) => void;
  /** Called after recheck or payment so checkout UI can refresh. */
  onCheckout?: () => void;
}) {
  const base = `/api/projects/${opts.projectId}`;
  const proposals = new Map<string, PlanProposal>();
  const searches = new Map<string, Job<ShopJobOutput>>();
  let latestSearch: string | null = null;

  async function follow(jobId: string) {
    const started = Date.now();
    while (Date.now() - started < POLL_LIMIT_MS && (opts.isActive?.() ?? true)) {
      await sleep(POLL_MS);
      const res = await fetch(`${base}/shop/${jobId}`).catch(() => null);
      if (!res?.ok) continue;
      const job = (await res.json()) as Job<ShopJobOutput>;
      searches.set(jobId, job);
      opts.onShop?.(job);
      if (job.output?.live !== "running") {
        const fresh = job.output!.results.filter((r) => r.source === "live" && r.fits).length;
        opts.onShopUpdate?.(
          `[app update] Live search ${jobId} finished: ${fresh ? `${fresh} new that fit.` : "nothing new that fits."} ${describeShop(job)}`,
        );
        return;
      }
    }
  }

  /** The shopping job a choice refers to: the one named, else the latest. */
  async function searchFor(jobId?: string | null) {
    const id = jobId || latestSearch;
    if (!id) return null;
    const res = await fetch(`${base}/shop/${id}`).catch(() => null);
    if (res?.ok) searches.set(id, (await res.json()) as Job<ShopJobOutput>);
    return searches.get(id) ?? null;
  }

  return {
    get_room: async () => {
      const res = await fetch(base);
      if (!res.ok) return "I couldn't load the room.";
      const { plan, cost } = (await res.json()) as { plan: RoomPlan; cost: { knownSubtotal: { amountMinor: number } } };
      const selected = opts.getSelectedItemId();
      const lines = plan.items.map((i) => {
        const price = plan.products.find((p) => p.id === i.productId)?.price;
        const tag = i.origin === "existing_owned" ? "owned" : price ? dollars(price.amountMinor) : "price unknown";
        return `${i.label} [id ${i.id}] (${tag}${i.stored ? ", put away in inventory" : ""}${i.locked ? ", locked" : ""}${i.seats ? `, seats ${i.seats}` : ""}${i.id === selected ? ", selected" : ""})`;
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

    shop_here: async ({ category, max_price_usd, style }: { category: FurnitureCategory; max_price_usd?: number | null; style?: string | null }) => {
      const spot = opts.getSpot?.() ?? null;
      if (!spot) return "I don't know which spot you mean. Ask the shopper to look at or tap the spot on the floor, then try again.";
      try {
        const job = await post<Job<ShopJobOutput>>(`${base}/shop`, {
          category,
          spot,
          maxPriceUsd: max_price_usd || null,
          request: style || null,
        });
        searches.set(job.id, job);
        latestSearch = job.id;
        opts.onShop?.(job);
        if (job.output?.live === "running") void follow(job.id);
        return describeShop(job);
      } catch (e) {
        return `Search failed: ${(e as Error).message}`;
      }
    },

    check_search: async ({ job_id }: { job_id?: string | null }) => {
      const job = await searchFor(job_id);
      if (!job) return "There's no search yet. Use shop_here first.";
      return describeShop(job);
    },

    place_product: async ({ choice, job_id }: { choice: number; job_id?: string | null }) => {
      const job = await searchFor(job_id);
      if (!job?.output) return "There's no search to pick from. Use shop_here first.";
      const r = job.output.results[Math.round(choice) - 1];
      if (!r) return `There's no option ${choice}; this search has ${job.output.results.length}.`;
      try {
        const res = await post<PlaceResult>(`${base}/place`, { productId: r.product.id, spot: job.output.request.spot, jobId: job.id });
        if (res.ok) {
          if (opts.onPlaced) opts.onPlaced(res.itemId);
          else {
            opts.onPlan?.(res.plan);
            opts.onCheckout?.();
          }
          const item = res.plan.items.find((i) => i.id === res.itemId)!;
          const total = res.plan.items.reduce((n, i) => n + (i.origin === "proposed_purchase" ? (res.plan.products.find((p) => p.id === i.productId)?.price?.amountMinor ?? 0) : 0), 0);
          const budget = res.plan.constraints.budget;
          return `ok: placed ${item.label} [id ${item.id}]${res.placement.againstWallId ? ` against the ${res.placement.againstWallId.replace("wall_", "")} wall` : ""}. It's in the cart. New purchases now ${dollars(total)}${budget ? ` of ${dollars(budget.amountMinor)}` : ""}.`;
        }
        if (res.reason === "no_fit") return `Not placed: ${res.message}`;
        if (res.reason === "stale_revision") return "Not placed: the room just changed. Try again.";
        if (res.reason === "validation_failed")
          return `Not placed: ${whyBlocked(res)} Offer to raise the budget or drop something to make room.`;
        return `Not placed: ${res.message}`;
      } catch (e) {
        return `Not placed: ${(e as Error).message}`;
      }
    },

    move_here: async ({ item_id, unlock }: { item_id: string; unlock?: boolean }) => {
      const spot = opts.getSpot?.() ?? null;
      if (!spot) return "I don't know where to move it. Ask the shopper to look at or tap the spot on the floor.";
      try {
        const res = await post<PlaceResult>(`${base}/items/${encodeURIComponent(item_id)}/move-to`, { spot, unlock: !!unlock });
        if (res.ok) {
          opts.onPlan?.(res.plan);
          return `ok: moved it${res.placement.againstWallId ? ` against the ${res.placement.againstWallId.replace("wall_", "")} wall` : ""}${res.placement.distanceM > 0.3 ? `, ${res.placement.distanceM} m from the exact spot so it clears everything` : ""}.`;
        }
        if (res.reason === "locked") return `Not moved: ${res.message} Ask the shopper if it's okay to move it, then call again with unlock true.`;
        if (res.reason === "no_fit") return `Not moved: ${res.message}`;
        if (res.reason === "stale_revision") return "Not moved: the room just changed. Try again.";
        return `Not moved: ${whyBlocked(res)}`;
      } catch (e) {
        return `Not moved: ${(e as Error).message}`;
      }
    },

    put_away: async ({ item_id, unlock }: { item_id: string; unlock?: boolean }) => {
      try {
        const res = await post<ApplyResult | { ok: false; reason: "locked"; message: string }>(`${base}/items/${encodeURIComponent(item_id)}/store`, { unlock: !!unlock });
        if (res.ok) {
          opts.onPlan?.(res.plan);
          opts.onCheckout?.();
          const item = res.plan.items.find((i) => i.id === item_id);
          const seats = res.plan.items.filter((i) => !i.stored).reduce((n, i) => n + (i.seats ?? 0), 0);
          const min = res.plan.constraints.minimumSeats;
          return `ok: ${item?.label ?? "it"} is put away in inventory${item?.origin === "proposed_purchase" ? " and out of the cart" : ""}.${
            min !== null && seats < min ? ` The room now seats ${seats}, under the ${min} wanted.` : ""
          }`;
        }
        if (res.reason === "locked") return `Not put away: ${res.message} Ask the shopper if that's okay, then call again with unlock true.`;
        if (res.reason === "stale_revision") return "Not put away: the room just changed. Try again.";
        return `Not put away: ${whyBlocked(res)}`;
      } catch (e) {
        return `Not put away: ${(e as Error).message}`;
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
        return `Not applied: ${whyBlocked(r)}`;
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
