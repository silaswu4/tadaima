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
  move(itemId: string, spot: FloorSpot): Promise<void>;
  store(itemId: string): Promise<void>;
  liveSearch: boolean;
};
const categories = new Set<FurnitureCategory>(["sofa", "chair", "table", "storage", "desk", "bed", "rug", "lamp", "decor", "other"]);
const money = (minor: number, currency = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);

/** Voice uses the same queued operations and review UI as text/touch. Never a
 * second mutation channel, and never a way to approve or execute payments. */
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
    const choices = value.results.slice(0, 6).map((result, i) => `${i + 1}) ${result.product.label}: ${result.product.price ? money(result.product.price.amountMinor, result.product.price.currency) : "price unknown"}; ${result.fits ? "fits this spot" : result.problems.join("; ") || "fit unverified"}${result.withinBudget === false ? "; over budget" : ""}.`);
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
      const issues = proposal.validations.filter((check) => check.status !== "pass");
      return `Proposal ${proposal.id}: ${proposal.summary}. ${issues.map((check) => `${check.status}: ${check.message}`).join(" ")} No changes applied. The shopper must review the proposal and tap Apply changes on screen.`;
    }),
    apply_proposal: guard(() => "Not applied: review the proposal and tap Apply changes on screen. Voice does not approve a plan."),
    shop_here: guard(async ({ category, max_price_usd, style }) => {
      if (!categories.has(category as FurnitureCategory)) throw new Error("Choose a furniture category.");
      if (max_price_usd != null && (typeof max_price_usd !== "number" || !Number.isFinite(max_price_usd) || max_price_usd <= 0 || max_price_usd > 100000)) throw new Error("Choose a price cap between $0.01 and $100,000.");
      if (style != null && (typeof style !== "string" || style.length > 300)) throw new Error("Keep the furniture description under 300 characters.");
      await options.search({ category: category as FurnitureCategory, maxPriceUsd: max_price_usd as number | undefined, request: typeof style === "string" ? style : undefined, live: options.liveSearch });
      return `Search started at the shopper's current floor spot. ${options.liveSearch ? "Saved catalog results arrive first, then live research updates." : "Live store research is unavailable; searching saved catalog observations."}`;
    }),
    check_search: guard(({ job_id }) => {
      if (job_id && job_id !== context().job?.id) throw new Error("That search is no longer selected. Use the current search results.");
      return resultText();
    }),
    place_product: guard(({ choice, job_id }) => {
      const value = context();
      if (!value.job || value.job.projectId !== options.projectId || (job_id && job_id !== value.job.id)) throw new Error("Search this room again before choosing a result.");
      if (typeof choice !== "number" || !Number.isInteger(choice) || choice < 1) throw new Error("Choose a result by its whole option number.");
      const result = value.results[choice - 1];
      if (!result?.fits || !result.placement) throw new Error("That option does not have a verified placement at this spot.");
      if (!options.preview(result)) throw new Error("The room is busy or changed. Preview this piece again.");
      return `Previewing ${result.product.label}. Not placed or added to the basket yet. The shopper must tap Confirm placement.`;
    }),
    move_here: guard(async ({ item_id }) => {
      const item = context().plan.items.find((entry) => entry.id === item_id);
      if (!item) throw new Error("That piece is not in this room.");
      if (item.locked) throw new Error("That piece is locked. The shopper must unlock it on screen first.");
      await options.move(item.id, options.spot());
      return `ok: moved ${item.label} in this room.`;
    }),
    put_away: guard(async ({ item_id }) => {
      const item = context().plan.items.find((entry) => entry.id === item_id);
      if (!item) throw new Error("That piece is not in this room.");
      if (item.locked) throw new Error("That piece is locked. The shopper must unlock it on screen first.");
      await options.store(item.id);
      return `ok: put ${item.label} away in inventory.`;
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
