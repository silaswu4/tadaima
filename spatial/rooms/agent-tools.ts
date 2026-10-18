import type { FloorSpot, FurnitureCategory, Job, PlanProposal, RoomPlan, ShopJobOutput, ShopRequest, ShopResult } from "../../backend/contracts";

export type AgentContext = { plan: RoomPlan; selectedId: string | null; job: Job<ShopJobOutput> | null; results: ShopResult[]; previewedProductId?: string | null };
type Options = {
  projectId: string;
  active(): boolean;
  context(): AgentContext;
  refresh(): Promise<unknown>;
  propose(request: string): Promise<PlanProposal>;
  search(request: Omit<ShopRequest, "spot">): Promise<void>;
  preview(result: ShopResult): boolean;
  spot(): FloorSpot;
  move(itemId: string, spot: FloorSpot, unlock: boolean): Promise<void>;
  store(itemId: string, unlock: boolean): Promise<void>;
  /** Put a search result in the room for real (the shopper said yes out loud). */
  place(result: ShopResult, job: Job<ShopJobOutput>): Promise<void>;
  /** Apply the proposal the shopper just agreed to out loud. */
  apply(proposalId: string): Promise<void>;
  /** The proposal on screen, if any. */
  proposal(): PlanProposal | null;
  /** Set the room's budget for new purchases, in cents. */
  setBudget(amountMinor: number): Promise<void>;
  liveSearch: boolean;
};
const categories = new Set<FurnitureCategory>(["sofa", "chair", "table", "storage", "desk", "bed", "rug", "lamp", "decor", "other"]);
const money = (minor: number, currency = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
/** Whole dollars, for what the agent says out loud. */
const dollars = (minor: number) => `$${Math.round(minor / 100).toLocaleString("en-US")}`;

/** Voice uses the same queued operations as text/touch, never a second
 * mutation channel. The agent asks before it changes anything and acts on a
 * spoken yes (the shopper may be in first person with no free pointer).
 * Payments stay an on-screen approval. */
export function createRoomAgentTools(options: Options): Record<string, (params: Record<string, unknown>) => Promise<string>> {
  let previewPin: { jobId: string; productId: string; revision: number; approvalKey: string } | null = null;
  let placementPending = false;
  let searchEpoch = 0;
  const eligible = (result: ShopResult) => result.fits && !!result.placement && result.withinBudget !== false;
  // Approval covers this product, observed price and pose, never a changing result index.
  const approvalKey = (result: ShopResult) => JSON.stringify([result.product.price?.amountMinor, result.product.price?.currency,
    result.product.dimensions, result.placement?.roomId, result.placement?.position, result.placement?.rotationY]);
  function context() {
    const value = options.context();
    if (!options.active() || value.plan.projectId !== options.projectId) throw new Error("This room assistant session has ended.");
    return value;
  }
  const guard = (run: (params: Record<string, unknown>) => Promise<string> | string) => async (params: Record<string, unknown> = {}) => {
    try { context(); return await run(params); }
    catch (cause) { return `Not completed: ${cause instanceof Error ? cause.message : "The room service could not finish this action."}`; }
  };
  function searchContext(jobId?: unknown) {
    const value = context();
    if (!value.job || value.job.projectId !== options.projectId || (jobId != null && jobId !== value.job.id)) throw new Error("That search is no longer selected. Search this room again.");
    return value as AgentContext & { job: Job<ShopJobOutput> };
  }
  function choose(value: AgentContext, choice: unknown, productId: unknown): ShopResult {
    if (choice != null && (typeof choice !== "number" || !Number.isInteger(choice) || choice < 1)) throw new Error("Choose a result by its whole option number.");
    if (productId != null && (typeof productId !== "string" || !productId)) throw new Error("Choose a current product ID.");
    const byNumber = typeof choice === "number" ? value.results[choice - 1] : undefined;
    const byId = typeof productId === "string" ? value.results.find((entry) => entry.product.id === productId) : undefined;
    if ((choice != null && !byNumber) || (productId != null && !byId) || (byId && byNumber && byId.product.id !== byNumber.product.id)) throw new Error("That choice changed. Preview the current product again.");
    const result = byId ?? byNumber;
    if (!result) throw new Error("Choose a result to preview first.");
    return result;
  }
  function previewText(value: AgentContext & { job: Job<ShopJobOutput> }, result: ShopResult) {
    return `Previewing ${result.product.label}, ${result.product.price ? money(result.product.price.amountMinor, result.product.price.currency) : "price unknown"}; fits this spot${value.plan.constraints.budget ? " and the room budget" : ""}. product_id=${result.product.id}; job_id=${value.job.id}. This is a preview only: nothing is placed or added to the basket. Explain this recommendation in one sentence and ask for approval. Call place_product with these exact IDs only after the shopper agrees.`;
  }
  function showPreview(value: AgentContext & { job: Job<ShopJobOutput> }, result: ShopResult) {
    if (!eligible(result)) throw new Error(`${result.product.label} cannot be recommended: ${result.withinBudget === false ? "over the room budget" : result.problems.join("; ") || "no verified fit"}. Nothing placed.`);
    previewPin = null;
    if (!options.preview(result)) throw new Error("The room could not show this preview. Nothing placed; try again when the room is ready.");
    previewPin = { jobId: value.job.id, productId: result.product.id, revision: value.plan.revision, approvalKey: approvalKey(result) };
    return previewText(value, result);
  }
  function resultText() {
    const value = searchContext();
    const choices = value.results.slice(0, 6).map((result, i) => `${i + 1}) ${result.product.label}: ${result.product.price ? money(result.product.price.amountMinor, result.product.price.currency) : "price unknown"}; product_id=${result.product.id}; ${result.fits ? "fits this spot" : result.problems.join("; ") || "fit unverified"}${result.withinBudget === false && result.overBudgetUsd != null ? `; ${dollars(Math.ceil(result.overBudgetUsd) * 100)} over the room budget` : ""}.`);
    const live = value.job.output?.live;
    const current = previewPin?.jobId === value.job.id ? value.results.find((entry) => entry.product.id === previewPin?.productId) : undefined;
    const samePreview = current && eligible(current) && previewPin?.revision === value.plan.revision && previewPin.approvalKey === approvalKey(current)
      && (value.previewedProductId === undefined || value.previewedProductId === current.product.id);
    let recommendation: string;
    if (samePreview) recommendation = previewText(value, current);
    else {
      previewPin = null;
      // The shopping service already ranks by fit, budget, request words and price.
      const best = value.results.find(eligible);
      recommendation = best ? showPreview(value, best) : "No verified in-budget match is available to preview. Nothing placed. Ask whether to try a different style, location or price limit; never raise the budget automatically.";
    }
    return `${value.job.stage}. job_id=${value.job.id}. ${recommendation} Alternatives: ${choices.join(" ") || "No results yet."} ${live === "running" ? "Live store research is still running." : live === "failed" ? "Live research failed; these are saved catalog observations." : live === "skipped" ? "Saved catalog observations; no live store search was performed." : ""}`;
  }

  return {
    get_room: guard(async () => {
      await options.refresh();
      const { plan, selectedId } = context();
      return `Current room revision ${plan.revision}. ${plan.items.slice(0, 80).map((item) => `${item.label} [id ${item.id}]${item.id === selectedId ? " selected" : ""}${item.locked ? " locked" : ""}${item.stored ? " stored" : ""}${item.origin === "existing_owned" ? " owned" : ""}`).join("; ")}. Budget: ${plan.constraints.budget ? money(plan.constraints.budget.amountMinor, plan.constraints.budget.currency) : "not set"}.`;
    }),
    propose_change: guard(async ({ request }) => {
      if (typeof request !== "string") throw new Error("Describe the room change first.");
      const proposal = await options.propose(request);
      if (!proposal.changes.length) return `No change proposed. ${proposal.summary}`;
      // only what this proposal would break; checks already failing in the room aren't its fault
      const blocked = proposal.blocking ?? proposal.validations.filter((check) => check.status === "fail");
      const cost = proposal.costAfter.knownSubtotal.amountMinor - proposal.costBefore.knownSubtotal.amountMinor;
      return `Proposal ${proposal.id}: ${proposal.summary} ${blocked.length ? `It can't be applied: ${blocked.map((check) => check.message).join(" ")}` : "It passes every check."}${cost ? ` New purchases ${cost > 0 ? "go up" : "go down"} by ${money(Math.abs(cost))}.` : ""} Not applied yet: ask the shopper, and call apply_proposal if they say yes.`;
    }),
    set_budget: guard(async ({ usd }) => {
      if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > 1000000) throw new Error("Say the new budget in dollars.");
      await options.setBudget(Math.round(usd * 100));
      return `ok: the room budget is now ${dollars(Math.round(usd * 100))}.`;
    }),
    apply_proposal: guard(async ({ proposal_id }) => {
      const proposal = options.proposal();
      if (!proposal || (proposal_id && proposal_id !== proposal.id)) throw new Error("That proposal is gone. Plan it again.");
      await options.apply(proposal.id);
      return "ok: the room is updated.";
    }),
    shop_here: guard(async ({ category, max_price_usd, style }) => {
      if (!categories.has(category as FurnitureCategory)) throw new Error("Choose a furniture category.");
      if (max_price_usd != null && (typeof max_price_usd !== "number" || !Number.isFinite(max_price_usd) || max_price_usd <= 0 || max_price_usd > 100000)) throw new Error("Choose a price cap between $0.01 and $100,000.");
      if (style != null && (typeof style !== "string" || style.length > 300)) throw new Error("Keep the furniture description under 300 characters.");
      if (placementPending) throw new Error("Wait for the approved placement to finish before starting another search.");
      const epoch = ++searchEpoch;
      previewPin = null;
      const before = context().job?.id;
      await options.search({ category: category as FurnitureCategory, maxPriceUsd: max_price_usd as number | undefined, request: typeof style === "string" ? style : undefined, live: options.liveSearch });
      // the catalog pass answers within a second; wait for it so there's something to say
      for (let i = 0; i < 40 && epoch === searchEpoch && (context().job?.id ?? before) === before; i++) await new Promise((r) => setTimeout(r, 150));
      if (epoch !== searchEpoch || context().job?.id === before) throw new Error("That search did not produce current results. Try again.");
      return resultText();
    }),
    check_search: guard(({ job_id }) => {
      searchContext(job_id);
      if (placementPending) throw new Error("Wait for the approved placement to finish.");
      return resultText();
    }),
    preview_product: guard(({ choice, product_id, job_id }) => {
      if (placementPending) throw new Error("Wait for the approved placement to finish.");
      const value = searchContext(job_id);
      return showPreview(value, choose(value, choice, product_id));
    }),
    place_product: guard(async ({ choice, product_id, job_id }) => {
      if (placementPending) throw new Error("This placement is already being saved.");
      const value = searchContext(job_id), pin = previewPin;
      if (!pin || pin.jobId !== value.job.id) throw new Error("Preview a current recommendation and ask for approval before placing it.");
      if (product_id != null && product_id !== pin.productId) throw new Error("That is not the previewed product. Preview it and ask for approval first.");
      const result = choose(value, choice, product_id ?? pin.productId);
      if (result.product.id !== pin.productId || (value.previewedProductId !== undefined && value.previewedProductId !== pin.productId)) throw new Error("That preview was cancelled or changed. Preview it and ask for approval again.");
      if (!result.fits || !result.placement) throw new Error(`${result.product.label} doesn't fit there: ${result.problems.join(" ") || "no verified placement"}`);
      const budget = value.plan.constraints.budget;
      if (result.withinBudget === false) {
        const detail = budget && result.overBudgetUsd != null ? `it's ${dollars(Math.ceil(result.overBudgetUsd) * 100)} over the ${dollars(budget.amountMinor)} budget` : "it exceeds the current room budget";
        return `Not placed: ${detail}. Ask whether the shopper wants a cheaper match or a new budget; never raise it automatically. Preview again after any change.`;
      }
      if (pin.revision !== value.plan.revision || pin.approvalKey !== approvalKey(result)) throw new Error("The room, price or placement changed since this preview. Preview it and ask for approval again.");
      placementPending = true;
      try { await options.place(result, value.job); }
      finally { placementPending = false; }
      previewPin = null;
      const { plan } = context();
      const spent = plan.items.filter((item) => item.origin === "proposed_purchase" && !item.stored).reduce((n, item) => n + (plan.products.find((p) => p.id === item.productId)?.price?.amountMinor ?? 0), 0);
      return `ok: ${result.product.label} is in the room and the basket. New purchases now ${money(spent)}${plan.constraints.budget ? ` of ${money(plan.constraints.budget.amountMinor)}` : ""}.`;
    }),
    move_here: guard(async ({ item_id, unlock }) => {
      const item = context().plan.items.find((entry) => entry.id === item_id);
      if (!item) throw new Error("That piece is not in this room.");
      if (item.locked && unlock !== true) return `Not moved: ${item.label} is locked. Ask the shopper if it's okay to move it, then call again with unlock true.`;
      await options.move(item.id, options.spot(), unlock === true);
      return `ok: moved ${item.label}.`;
    }),
    put_away: guard(async ({ item_id, unlock }) => {
      const item = context().plan.items.find((entry) => entry.id === item_id);
      if (!item) throw new Error("That piece is not in this room.");
      if (item.locked && unlock !== true) return `Not put away: ${item.label} is locked. Ask the shopper if it's okay, then call again with unlock true.`;
      await options.store(item.id, unlock === true);
      return `ok: ${item.label} is put away in inventory${item.origin === "proposed_purchase" ? " and out of the basket" : ""}.`;
    }),
    get_cart: guard(() => {
      const { plan } = context();
      const items = plan.items.filter((item) => item.origin === "proposed_purchase" && !item.stored);
      return `${items.length} proposed purchases: ${items.map((item) => { const product = plan.products.find((entry) => entry.id === item.productId); return `${item.label}, ${product?.price ? money(product.price.amountMinor, product.price.currency) : "price unknown"}`; }).join("; ")}. Open Basket for the exact total, price and stock review, and payment approval. Nothing ordered.`;
    }),
    recheck_cart: guard(() => "Not rechecked: open Basket and tap Recheck price and stock. Payment stays in the basket review."),
    pay_now: guard(() => "Not paid: open Basket to review, approve the exact cart and use the separate test payment button. Voice cannot approve or execute payment."),
  };
}
