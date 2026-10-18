import type { FloorSpot, FurnitureCategory, Job, PlanProposal, RoomPlan, ShopJobOutput, ShopRequest, ShopResult } from "../../backend/contracts";

export type AgentContext = { plan: RoomPlan; selectedId: string | null; job: Job<ShopJobOutput> | null; results: ShopResult[] };
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
  function context() {
    const value = options.context();
    if (!options.active() || value.plan.projectId !== options.projectId) throw new Error("This room assistant session has ended.");
    return value;
  }
  const guard = (run: (params: Record<string, unknown>) => Promise<string> | string) => async (params: Record<string, unknown> = {}) => {
    try { context(); return await run(params); }
    catch (cause) { return `Not completed: ${cause instanceof Error ? cause.message : "The room service could not finish this action."}`; }
  };
  function resultText() {
    const value = context();
    if (!value.job) return "No search yet. Ask what kind of furniture the shopper wants.";
    if (value.job.projectId !== options.projectId) throw new Error("These results belong to another room.");
    const choices = value.results.slice(0, 6).map((result, i) => `${i + 1}) ${result.product.label}: ${result.product.price ? money(result.product.price.amountMinor, result.product.price.currency) : "price unknown"}; ${result.fits ? "fits this spot" : result.problems.join("; ") || "fit unverified"}${result.withinBudget === false && result.overBudgetUsd != null ? `; ${dollars(Math.ceil(result.overBudgetUsd) * 100)} over the room budget` : ""}.`);
    const live = value.job.output?.live;
    return `${value.job.stage}. ${choices.join(" ") || "No results yet."} ${live === "running" ? "Live store research is still running." : live === "failed" ? "Live research failed; these are saved catalog observations." : live === "skipped" ? "Saved catalog observations; no live store search was performed." : ""}`;
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
      const before = context().job?.id;
      await options.search({ category: category as FurnitureCategory, maxPriceUsd: max_price_usd as number | undefined, request: typeof style === "string" ? style : undefined, live: options.liveSearch });
      // the catalog pass answers within a second; wait for it so there's something to say
      for (let i = 0; i < 40 && (context().job?.id ?? before) === before; i++) await new Promise((r) => setTimeout(r, 150));
      return resultText();
    }),
    check_search: guard(({ job_id }) => {
      if (job_id && job_id !== context().job?.id) throw new Error("That search is no longer selected. Use the current search results.");
      return resultText();
    }),
    place_product: guard(async ({ choice, job_id }) => {
      const value = context();
      if (!value.job || value.job.projectId !== options.projectId || (job_id && job_id !== value.job.id)) throw new Error("Search this room again before choosing a result.");
      if (typeof choice !== "number" || !Number.isInteger(choice) || choice < 1) throw new Error("Choose a result by its whole option number.");
      const result = value.results[choice - 1];
      if (!result) throw new Error(`There's no option ${choice}.`);
      if (!result.fits || !result.placement) throw new Error(`${result.product.label} doesn't fit there: ${result.problems.join(" ") || "no verified placement"}`);
      const budget = value.plan.constraints.budget;
      if (result.withinBudget === false && budget && result.overBudgetUsd != null) {
        // say the exact numbers so the agent doesn't do budget math out loud
        const needed = Math.ceil((budget.amountMinor + Math.round(result.overBudgetUsd * 100)) / 5000) * 5000;
        return `Not placed: it's ${dollars(Math.ceil(result.overBudgetUsd) * 100)} over the ${dollars(budget.amountMinor)} budget. Offer to raise the budget to ${dollars(needed)}; if they agree, call set_budget with ${needed / 100} and then place_product again.`;
      }
      await options.place(result, value.job);
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
