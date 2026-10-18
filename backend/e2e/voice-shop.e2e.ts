/**
 * Voice shopping for a spot, via ElevenLabs' conversation simulator against
 * the real agent. Tool replies are the exact sentences clientTools.ts builds,
 * generated here from the real demo room and catalog, so the agent hears what
 * it would hear live. Needs ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID.
 *   npm run e2e:voice
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Job, ShopJobOutput, ShopRequest } from "@/backend/contracts";
import { demoPlan } from "@/backend/fixtures/demo-room";
import { catalogCandidates, evaluateAll } from "@/backend/shopping/spot";
import { describeShop } from "@/backend/voice/clientTools";

const KEY = process.env.ELEVENLABS_API_KEY;
const AGENT = process.env.ELEVENLABS_AGENT_ID;

type Turn = { role: "user" | "agent"; message: string | null; tool_calls?: Array<{ tool_name: string; params_as_json?: string }> | null };
type Sim = { simulated_conversation: Turn[]; analysis: { evaluation_criteria_results?: Record<string, { result: string; rationale: string }> } };

const req: ShopRequest = { category: "sofa", spot: { position: [3.0, 0, 0.6] }, maxPriceUsd: 300 };
const job = (live: ShopJobOutput["live"]): Job<ShopJobOutput> => ({
  id: "job_demo01",
  projectId: "proj_demo",
  type: "shop_at_spot",
  state: live === "running" ? "running" : "succeeded",
  stage: "",
  inputRevision: 1,
  output: {
    request: req,
    brief: "",
    results: evaluateAll(demoPlan, catalogCandidates(demoPlan, req).map((product) => ({ product, source: "catalog" as const })), req),
    live,
    addedAtRevision: null,
    costUsd: null,
    checkedAtRevision: 1,
  },
  error: null,
  createdAt: "",
  updatedAt: "",
});
const SHOP_NOW = describeShop(job("running"));
const ROOM =
  "Items: Your sofa [id item_sofa] (owned, locked, seats 3); Your desk [id item_desk] (owned, locked); STOCKHOLM 2025 armchair [id item_armchair] ($399, seats 1); TONSTAD coffee table [id item_coffee_table] ($350); LOHALS rug [id item_rug] ($100); SIMRISHAMN floor lamp [id item_lamp] ($200); HEMNES bookcase [id item_shelf] ($349). New purchases total $1,398 of a $1,500 budget. Needs to seat 4 people.";
const OVER_BUDGET = "Not placed: New items come to $1,696.97, over the $1,500 cap. Offer to raise the budget or drop something to make room.";

async function simulate(userPrompt: string, firstMessage: string, mocks: Record<string, string>, criteria: Array<{ id: string; prompt: string }>) {
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${AGENT}/simulate-conversation`, {
    method: "POST",
    headers: { "xi-api-key": KEY!, "content-type": "application/json" },
    body: JSON.stringify({
      simulation_specification: {
        simulated_user_config: { first_message: firstMessage, language: "en", prompt: { prompt: userPrompt } },
        tool_mock_config: Object.fromEntries(
          Object.entries({
            get_room: ROOM,
            shop_here: SHOP_NOW,
            check_search: SHOP_NOW,
            place_product: OVER_BUDGET,
            move_here: "ok: moved it against the back wall.",
            propose_change: "No change proposed.",
            apply_proposal: "ok: the room is updated.",
            get_cart: "Cart total $1,398. Not approved yet.",
            recheck_cart: "Rechecked. Every price and stock status matches.",
            pay_now: "Not paid: there's no active approval",
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

const calls = (sim: Sim) => sim.simulated_conversation.flatMap((t) => (t.tool_calls ?? []).map((c) => ({ name: c.tool_name, params: JSON.parse(c.params_as_json || "{}") })));
const transcript = (sim: Sim) =>
  sim.simulated_conversation
    .map((t) => `${t.role}: ${t.message ?? ""}${t.tool_calls?.length ? ` [${t.tool_calls.map((c) => `${c.tool_name}(${c.params_as_json ?? ""})`).join(", ")}]` : ""}`)
    .join("\n");
const judged = (sim: Sim) => {
  for (const [id, r] of Object.entries(sim.analysis.evaluation_criteria_results ?? {})) assert.notEqual(r.result, "failure", `${id}: ${r.rationale}\n${transcript(sim)}`);
};

describe("voice shopping for a spot", { skip: !(KEY && AGENT) && "needs ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID" }, () => {
  test("'a couch under $300 that fits here': shops right away with the right category and price, and reports honestly", { timeout: 4 * 60 * 1000 }, async () => {
    const sim = await simulate(
      "You're standing in your living room looking at the empty spot by the back wall. You want a couch under $300 that fits there. Keep replies short. After the assistant tells you what it found, say thanks and end.",
      "Hey, I want a couch that's less than 300 dollars that can fit here.",
      {},
      [
        { id: "named_option", prompt: "The agent named the SALTMYRAN loveseat and its price of about $299." },
        { id: "budget_warning", prompt: "The agent mentioned that it would put the shopper over budget (by roughly $197)." },
        { id: "still_searching", prompt: "The agent said it is still searching the store live or will update soon." },
      ],
    );
    console.log(transcript(sim));
    const shop = calls(sim).find((c) => c.name === "shop_here");
    assert.ok(shop, "called shop_here");
    assert.equal(shop.params.category, "sofa");
    assert.equal(Number(shop.params.max_price_usd), 300);
    judged(sim);
  });

  test("an [app update] mid-conversation gets relayed to the shopper", { timeout: 4 * 60 * 1000 }, async () => {
    const update = `[app update] Live search job_demo01 finished: 1 new that fits. Search job_demo01: 2 of 2 fit. 1) SALTMYRAN loveseat, Öreryd gray-beige, $299, 147 cm wide x 79 cm deep, fits against the back wall, but it'd put you $197 over budget. 2) KLIPPAN loveseat, Vissle gray, $249, 180 cm wide x 88 cm deep, fits against the back wall, but it'd put you $147 over budget (just found live). The live search is done.`;
    const sim = await simulate(
      `You want a couch under $300 for the spot you're looking at. After the assistant's first answer, send this exact message and nothing else: "${update}". Then after the assistant replies, end the conversation.`,
      "Find me a couch under 300 that fits here.",
      {},
      [{ id: "relayed_update", prompt: "After the [app update] message, the agent told the shopper about the newly found KLIPPAN loveseat (about $249), without treating the update as something the shopper said." }],
    );
    console.log(transcript(sim));
    judged(sim);
  });

  test("'add the first one' over budget: picks by number, never claims it's added, offers a way out", { timeout: 4 * 60 * 1000 }, async () => {
    const sim = await simulate(
      "You want a couch under $300 for the spot you're looking at. When the assistant lists options, reply exactly 'add the first one anyway', even if it mentions the budget. After it answers that, say you'll think about it and end.",
      "I want a couch under $300 that fits here.",
      {},
      [
        { id: "no_false_add", prompt: "The agent never said the couch was added to the room or the cart." },
        { id: "explained_budget", prompt: "The agent explained it's over the budget and offered to raise the budget or swap something out." },
      ],
    );
    console.log(transcript(sim));
    const place = calls(sim).find((c) => c.name === "place_product");
    assert.ok(place, "called place_product");
    assert.equal(Number(place.params.choice), 1);
    judged(sim);
  });

  test("placing succeeds: says it's in the room and the cart", { timeout: 4 * 60 * 1000 }, async () => {
    const sim = await simulate(
      "You want a couch under $300 for the spot you're looking at. When the assistant lists options, say 'put the first one in'. After it confirms, end.",
      "Couch under 300 for right here please.",
      { place_product: "ok: placed SALTMYRAN loveseat [id item_sofa_a1b2c3] against the back wall. It's in the cart. New purchases now $1,697 of $2,000." },
      [{ id: "confirmed", prompt: "The agent confirmed the loveseat is now in the room and in the cart." }],
    );
    console.log(transcript(sim));
    assert.ok(calls(sim).some((c) => c.name === "place_product"));
    judged(sim);
  });

  test("no spot known: asks the shopper to look at or tap the floor", { timeout: 4 * 60 * 1000 }, async () => {
    const sim = await simulate(
      "You want a lamp for here. Keep replies short. If asked where, say you'll tap it, and end.",
      "Get me a floor lamp for here.",
      { shop_here: "I don't know which spot you mean. Ask the shopper to look at or tap the spot on the floor, then try again." },
      [{ id: "asked_for_spot", prompt: "The agent asked the shopper to look at or tap the spot on the floor, and did not invent results." }],
    );
    console.log(transcript(sim));
    judged(sim);
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
