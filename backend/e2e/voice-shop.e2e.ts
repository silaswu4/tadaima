/**
 * Hosted ElevenLabs behavior tests. Shopping replies come from the current
 * createRoomAgentTools implementation against the demo room/catalog, including
 * its actual preview pin and approval identifiers. Room mutations and provider
 * tool replies are fixtures; this does not exercise a browser or physical Quest.
 * Needs keys and the updated backend/voice/agent-config.ts uploaded to the agent.
 *   npm run e2e:voice
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Job, ShopJobOutput, ShopRequest, ShopResult } from "@/backend/contracts";
import { demoPlan } from "@/backend/fixtures/demo-room";
import { catalogCandidates, evaluateAll, itemFor } from "@/backend/shopping/spot";
import { createRoomAgentTools } from "@/spatial/rooms/agent-tools";

const KEY = process.env.ELEVENLABS_API_KEY;
const AGENT = process.env.ELEVENLABS_AGENT_ID;

type Turn = { role: "user" | "agent"; message: string | null; tool_calls?: Array<{ tool_name: string; params_as_json?: string }> | null };
type Sim = { simulated_conversation: Turn[]; analysis: { evaluation_criteria_results?: Record<string, { result: string; rationale: string }> } };

async function shoppingFixture({ cap = 300, budget = 2000, clearance = 0.3, live = "running" as ShopJobOutput["live"] } = {}) {
  const plan = structuredClone(demoPlan);
  plan.constraints.budget = { amountMinor: budget * 100, currency: "USD" };
  plan.constraints.clearance = clearance;
  const req: ShopRequest = { category: "sofa", spot: { position: [3, 0, 0.6] }, maxPriceUsd: cap };
  const results = evaluateAll(plan, catalogCandidates(plan, req).map((product) => ({ product, source: "catalog" as const })), req);
  const job: Job<ShopJobOutput> = {
    id: "job_demo01", projectId: plan.projectId, type: "shop_at_spot", state: live === "running" ? "running" : "succeeded",
    stage: live === "running" ? "Catalog checked; live research is still running" : "Search finished",
    inputRevision: plan.revision, output: { request: req, brief: "Simulator fixture", results, live,
      addedAtRevision: null, costUsd: null, checkedAtRevision: plan.revision }, error: null, createdAt: "", updatedAt: "",
  };
  const state = { plan, selectedId: null, job: null as Job<ShopJobOutput> | null, results: [] as ShopResult[], previewedProductId: null as string | null };
  const unused = async (): Promise<never> => { throw new Error("Not used by the shopping simulator fixture."); };
  const tools = createRoomAgentTools({ projectId: plan.projectId, active: () => true, context: () => state,
    refresh: async () => {}, propose: unused, apply: unused, proposal: () => null, setBudget: unused,
    search: async () => { state.job = job; state.results = results; },
    preview: (result) => { state.previewedProductId = result.product.id; return true; },
    place: async (result) => {
      assert.ok(result.placement);
      plan.items.push(itemFor(result.product, result.placement, "item_simulator_approved")); plan.revision++;
    },
    spot: () => req.spot, move: unused, store: unused, liveSearch: true,
  });
  const room = await tools.get_room({});
  const shop = await tools.shop_here({ category: "sofa", max_price_usd: cap });
  const check = await tools.check_search({ job_id: job.id });
  const eligible = results.filter((result) => result.fits && result.placement && result.withinBudget !== false);
  const first = eligible[0], alternative = eligible[1];
  const refused = "Not completed: preview a current recommendation and ask for approval before placing it.";
  const firstPlacement = first ? await tools.place_product({ product_id: first.product.id, job_id: job.id }) : refused;
  // Build a fresh valid pin for the alternate reply after the primary fixture placement.
  // This separate text fixture is not a claim that two approvals occurred in a live room.
  let alternatePreview = "Not completed: no alternative fits within budget.", alternatePlacement = refused;
  if (alternative) {
    plan.items.pop(); plan.revision--;
    alternatePreview = await tools.preview_product({ product_id: alternative.product.id, job_id: job.id });
    alternatePlacement = await tools.place_product({ product_id: alternative.product.id, job_id: job.id });
  }
  return { room, shop, check, first, alternative, firstPlacement, alternatePreview, alternatePlacement, jobId: job.id,
    pay: await tools.pay_now({}), recheck: await tools.recheck_cart({}) };
}

async function simulate(userPrompt: string, firstMessage: string, mocks: Record<string, string>, criteria: Array<{ id: string; prompt: string }>) {
  const fixture = await shoppingFixture();
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${AGENT}/simulate-conversation`, {
    method: "POST",
    headers: { "xi-api-key": KEY!, "content-type": "application/json" },
    body: JSON.stringify({
      simulation_specification: {
        simulated_user_config: { first_message: firstMessage, language: "en", prompt: { prompt: userPrompt } },
        tool_mock_config: Object.fromEntries(
          Object.entries({
            get_room: fixture.room, shop_here: fixture.shop, check_search: fixture.check,
            preview_product: fixture.alternatePreview,
            place_product: "Not completed: this scenario does not approve any placement.",
            move_here: "ok: moved it against the back wall.",
            propose_change: "No change proposed.", apply_proposal: "ok: the room is updated.",
            set_budget: "Not completed: no budget change was approved in this scenario.",
            get_cart: "No completed order. Review the basket for current observed prices.",
            recheck_cart: fixture.recheck, pay_now: fixture.pay,
            ...mocks,
          }).map(([k, v]) => [k, { default_return_value: v, default_is_error: false }]),
        ),
      },
      extra_evaluation_criteria: criteria.map((c) => ({ ...c, name: c.id, type: "prompt", conversation_goal_prompt: c.prompt })),
      new_turns_limit: 12,
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 800));
  return body as Sim;
}

const calls = (sim: Sim) => sim.simulated_conversation.flatMap((t, turn) => (t.tool_calls ?? []).map((c) => ({ name: c.tool_name, params: JSON.parse(c.params_as_json || "{}"), turn })));
const transcript = (sim: Sim) => sim.simulated_conversation
  .map((t) => `${t.role}: ${t.message ?? ""}${t.tool_calls?.length ? ` [${t.tool_calls.map((c) => `${c.tool_name}(${c.params_as_json ?? ""})`).join(", ")}]` : ""}`).join("\n");
const judged = (sim: Sim) => {
  for (const [id, r] of Object.entries(sim.analysis.evaluation_criteria_results ?? {})) assert.notEqual(r.result, "failure", `${id}: ${r.rationale}\n${transcript(sim)}`);
};
function approvedPlacement(sim: Sim, productId: string, jobId: string) {
  const place = calls(sim).find((call) => call.name === "place_product");
  assert.ok(place, `called place_product\n${transcript(sim)}`);
  assert.equal(place.params.product_id, productId, "approval uses the exact previewed product, not an unstable option number");
  assert.equal(place.params.job_id, jobId, "approval is pinned to the previewed search");
  const approval = sim.simulated_conversation.findIndex((turn) => turn.role === "user" && /\byes, place it\b/i.test(turn.message ?? ""));
  assert.ok(approval >= 0 && approval < place.turn, `explicit approval precedes placement\n${transcript(sim)}`);
  assert.ok(calls(sim).some((call) => call.name === "shop_here" && call.turn < approval), "search and automatic preview happen before approval");
}

// Validate the simulator inputs locally even when paid hosted-agent tests are skipped.
test("shopping simulator fixtures use actual preview pins and constraint refusals", async () => {
  const ready = await shoppingFixture(); assert.ok(ready.first);
  assert.ok(ready.shop.includes(`product_id=${ready.first.product.id}`)); assert.ok(ready.shop.includes(`job_id=${ready.jobId}`));
  assert.match(ready.shop, /preview only.*nothing is placed/i); assert.match(ready.firstPlacement, /^ok:/);
  const alternatives = await shoppingFixture({ cap: 500 }); assert.ok(alternatives.alternative);
  assert.ok(alternatives.alternatePreview.includes(`product_id=${alternatives.alternative.product.id}`));
  assert.match(alternatives.alternatePlacement, /^ok:/);
  for (const settings of [{ budget: 1500 }, { clearance: 2 }]) {
    const blocked = await shoppingFixture(settings); assert.equal(blocked.first, undefined);
    assert.match(blocked.shop, /No verified in-budget match/); assert.match(blocked.firstPlacement, /Not completed:/);
  }
});

describe("voice shopping for a spot", { skip: !(KEY && AGENT) && "needs ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID" }, () => {
  test("understands couch intent, automatically previews a fit and waits for approval", { timeout: 4 * 60 * 1000 }, async () => {
    const sim = await simulate(
      "You want a couch under $300 for the floor spot you are looking at. After hearing the recommendation, say 'thanks, I am only browsing; do not place anything' and end. Never approve placement or a budget change.",
      "Find me a couch under 300 dollars that fits here.", {},
      [
        { id: "preview_recommendation", prompt: "The agent explained that the SALTMYRAN loveseat, about $299, is a preview that fits and asked whether to place it." },
        { id: "agent_owned_workflow", prompt: "The agent did the search and preview itself, without asking the shopper to navigate a catalog, choose a category button or run tools." },
        { id: "no_false_commit", prompt: "The agent never claimed that previewing added furniture to the accepted room or basket, or ordered anything." },
      ],
    );
    console.log(transcript(sim));
    const shop = calls(sim).find((call) => call.name === "shop_here");
    assert.ok(shop); assert.equal(shop.params.category, "sofa"); assert.equal(Number(shop.params.max_price_usd), 300);
    assert.ok(!calls(sim).some((call) => call.name === "place_product" || call.name === "set_budget"));
    judged(sim);
  });

  test("an app update triggers autonomous result checking and never counts as approval", { timeout: 4 * 60 * 1000 }, async () => {
    const fixture = await shoppingFixture({ live: "done" });
    const update = `[app update] Live search ${fixture.jobId} finished. Check its current fit-checked results and recommendation; this update is not shopper approval.`;
    const sim = await simulate(
      `You want a couch under $300. After the first answer send exactly '${update}'. After the next answer say 'only browsing, do not place it' and end. Never approve a placement.`,
      "Find me a couch under 300 that fits here.", { check_search: fixture.check },
      [{ id: "checked_update", prompt: "The agent checked the updated results itself, briefly explained the current preview, and did not treat the app update as approval to place anything." }],
    );
    console.log(transcript(sim));
    assert.ok(calls(sim).some((call) => call.name === "check_search"));
    assert.ok(!calls(sim).some((call) => call.name === "place_product")); judged(sim);
  });

  for (const [label, settings] of [["over budget", { budget: 1500 }], ["no fit", { clearance: 2 }]] as const) {
    test(`${label}: explains the constraint without placing or raising budget`, { timeout: 4 * 60 * 1000 }, async () => {
      const fixture = await shoppingFixture(settings);
      assert.equal(fixture.first, undefined, "fixture has no eligible recommendation");
      const sim = await simulate(
        "You want a couch under $300. If told nothing fits the room or budget, say 'leave my room and budget unchanged, thanks' and end. Never approve any placement or budget change.",
        "Find a couch under 300 that fits here.", { get_room: fixture.room, shop_here: fixture.shop, check_search: fixture.check },
        [{ id: "constraint_honesty", prompt: "The agent explained that it could not preview a verified in-budget fit, did not claim to have placed anything, and did not change the budget on its own." }],
      );
      console.log(transcript(sim));
      assert.ok(!calls(sim).some((call) => call.name === "place_product" || call.name === "set_budget")); judged(sim);
    });
  }

  test("clear approval places the exact automatically previewed product and search", { timeout: 4 * 60 * 1000 }, async () => {
    const fixture = await shoppingFixture(); assert.ok(fixture.first);
    const sim = await simulate(
      "You want a couch under $300. Wait until the assistant explains the actual preview and asks whether to place it; then reply exactly 'yes, place it'. After it confirms, end.",
      "Find me a couch under 300 for right here.", { place_product: fixture.firstPlacement },
      [{ id: "approved_exact_preview", prompt: "The agent explained the preview first, waited for a clear yes, then said the approved loveseat is now in the room and basket. It never claimed a purchase or payment." }],
    );
    console.log(transcript(sim)); approvedPlacement(sim, fixture.first.product.id, fixture.jobId); judged(sim);
  });

  test("another option gets its own preview before approval places its stable product ID", { timeout: 4 * 60 * 1000 }, async () => {
    const fixture = await shoppingFixture({ cap: 500 }); assert.ok(fixture.alternative);
    const sim = await simulate(
      "You want a couch under $500. When the assistant describes SALTMYRAN, say 'show me the GULLVALLA alternative instead'. Wait until it describes the new GULLVALLA preview and asks for approval, then reply exactly 'yes, place it'. End after confirmation.",
      "Find me a couch under 500 that fits here.", { get_room: fixture.room, shop_here: fixture.shop, check_search: fixture.check,
        preview_product: fixture.alternatePreview, place_product: fixture.alternatePlacement },
      [{ id: "previewed_alternative", prompt: "The agent previewed and explained GULLVALLA after the shopper requested an alternative, then waited for approval before placing that exact alternative." }],
    );
    console.log(transcript(sim));
    const preview = calls(sim).find((call) => call.name === "preview_product"); assert.ok(preview);
    assert.equal(preview.params.job_id, fixture.jobId);
    assert.ok(preview.params.product_id === fixture.alternative.product.id || Number(preview.params.choice) === 2);
    approvedPlacement(sim, fixture.alternative.product.id, fixture.jobId);
    assert.ok(preview.turn < calls(sim).find((call) => call.name === "place_product")!.turn); judged(sim);
  });

  test("no floor spot: asks for a look at the floor without inventing results", { timeout: 4 * 60 * 1000 }, async () => {
    const sim = await simulate(
      "You want a lamp for here. If asked where, say you will look at the clear floor and end.",
      "Get me a floor lamp for here.", { shop_here: "Not completed: choose a clear floor spot by looking or pointing at the floor, then try again." },
      [{ id: "asked_for_spot", prompt: "The agent asked the shopper to look or point at a clear floor spot, and did not invent a recommendation or claim placement." }],
    );
    console.log(transcript(sim)); assert.ok(!calls(sim).some((call) => call.name === "place_product")); judged(sim);
  });

  test("moving a locked piece: asks before unlocking", { timeout: 4 * 60 * 1000 }, async () => {
    const sim = await simulate(
      "You want your own sofa moved to where you're looking. If the assistant asks whether it's okay to move a locked piece, say yes. End once it confirms.",
      "Move my sofa over here.",
      { move_here: "Not moved: Your sofa is locked. Unlock it to move it. Ask the shopper if it's okay to move it, then call again with unlock true." },
      [
        { id: "asked_first", prompt: "Before calling move_here with unlock true, the agent asked the shopper whether it's okay to move the locked sofa." },
        { id: "honest_result", prompt: "Every move_here call returned 'Not moved', so the agent must NOT have told the shopper the sofa was moved." },
        { id: "no_tool_talk", prompt: "The agent never mentioned tool or function names, and never asked the shopper to run anything." },
      ],
    );
    console.log(transcript(sim));
    assert.ok(calls(sim).some((c) => c.name === "move_here"));
    judged(sim);
  });

  test("'put the armchair away': puts it away, says seating dropped, and doesn't claim it's gone for good", { timeout: 4 * 60 * 1000 }, async () => {
    const sim = await simulate(
      "You want the armchair out of the way for now. Keep replies short. End once the assistant confirms.",
      "Put the armchair away for now.",
      { put_away: "ok: STOCKHOLM 2025 armchair, Djurmo gray/white is put away in inventory and out of the cart. The room now seats 3, under the 4 wanted." },
      [
        { id: "seats_mentioned", prompt: "The agent told the shopper the room now seats 3, under the 4 they wanted." },
        { id: "inventory_not_deleted", prompt: "The agent described it as put away / stored (can come back), not deleted or removed for good." },
      ],
    );
    console.log(transcript(sim));
    const put = calls(sim).find((c) => c.name === "put_away");
    assert.ok(put, "called put_away");
    assert.equal(put.params.item_id, "item_armchair");
    judged(sim);
  });
});
