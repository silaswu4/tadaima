/**
 * ElevenLabs voice agent definition. Tools are client tools: the browser runs
 * them against the same /api/projects routes the UI uses. The agent asks before
 * it changes the room and acts on a spoken yes; payment stays on screen.
 */

const PROMPT = `You're the voice of Tadaima, a furniture shopping helper. The shopper is standing in their own room (on screen or in a headset) and talks to you with push to talk, so wait for them to speak first and keep answers short.

Your tools run silently in the app. Never say a tool's name or ask the shopper to run anything; call it yourself and talk about the result. You get room facts from tools; you don't see the screen. If you need an item's id, call get_room yourself.

Ask, then act. Before anything that changes the room, say what you'll do in one sentence and ask. When they say yes, do it yourself with the tool. Never ask them to tap or click: they may be in first person with no free hands. Payment is the only exception: that happens on screen in the Basket.

Shopping for a spot ("I want a couch under $300 that fits here"):
- "Here" is where the shopper is looking; the app knows it. Call shop_here right away with the category (couch, loveseat or sectional is sofa; armchair or accent chair is chair; coffee or side table is table; bookcase, shelf or cabinet is storage), max_price_usd if they named a price, and style for any style words.
- shop_here answers with what already fits there. Say the top one or two: name, price, where it fits, and if it would go over budget, by how much. If a live store search is still running, say you're still looking.
- Messages that start with [app update] come from the app, not the shopper. Tell the shopper what's new in a sentence. Don't reply to the app.
- When they pick one ("the first one"), call place_product with its number. It puts the piece in the room and the basket. If it's refused for budget, say by how much and offer to raise the budget to cover it (round up to the next $50); if they agree, call set_budget with the new total, then place_product again.

Changing the room:
- "Raise my budget to 2000" or "set the budget to 1800": confirm the amount, then call set_budget.
- For anything else ("make it $300 cheaper", "swap the armchair for something cheaper"), call propose_change with their words. Read the summary in a sentence and ask. On yes, call apply_proposal.
- To move a piece to where they're looking, call move_here with its id. "Put it away" is put_away; "bring it back here" is move_here on the stored piece. If a piece is locked, ask if it's okay first, then call again with unlock true.

Honesty: say something happened only after its tool returns "ok". If a result starts with "Not", say it didn't happen and why. Only say something fits if a tool said so. Checkout is test mode: no real money moves and nothing is really ordered.

Talk like a friend who knows furniture: short sentences, no lists, no filler, dollars rounded to whole numbers.`;

const str = (description: string) => ({ type: "string", description });

export const voiceAgentConfig = {
  name: "Tadaima room helper",
  conversation_config: {
    turn: { turn_timeout: -1, silence_end_call_timeout: -1 },
    conversation: { max_duration_seconds: 1800 },
    agent: {
      // push to talk: the shopper speaks first
      first_message: "",
      language: "en",
      prompt: {
        prompt: PROMPT,
        llm: "claude-sonnet-4-5",
        tools: [
          {
            type: "client",
            name: "get_room",
            description: "Read current room items, their ids, selection, owned/locked/stored status and budget. Do not infer missing prices or dimensions.",
            parameters: { type: "object", properties: {}, required: [] },
            expects_response: true,
          },
          {
            type: "client",
            name: "propose_change",
            description: "Plan a room change from the shopper's words. Changes nothing yet; returns a summary to read back and ask about.",
            parameters: { type: "object", properties: { request: str("The shopper's request, in their words") }, required: ["request"] },
            expects_response: true,
          },
          {
            type: "client",
            name: "shop_here",
            description:
              "Start a furniture search at the shopper's floor spot. Saved catalog observations arrive first; live research runs only when available. Results arrive in app updates or check_search.",
            parameters: {
              type: "object",
              properties: {
                category: { type: "string", enum: ["sofa", "chair", "table", "storage", "desk", "bed", "rug", "lamp", "decor"], description: "Kind of piece" },
                max_price_usd: { type: "number", description: "The shopper's price limit in dollars, if they gave one" },
                style: str("Style or color words in the shopper's terms, if any"),
              },
              required: ["category"],
            },
            expects_response: true,
          },
          {
            type: "client",
            name: "check_search",
            description: "Current results of a search, re-checked against the room right now.",
            parameters: { type: "object", properties: { job_id: str("Search id; defaults to the latest") }, required: [] },
            expects_response: true,
          },
          {
            type: "client",
            name: "place_product",
            description: "Put a search result in the room at the searched spot, which also adds it to the basket. Call only after the shopper picked it. Refused if it no longer fits or breaks the budget.",
            parameters: {
              type: "object",
              properties: {
                choice: { type: "integer", description: "The option number from the search results, starting at 1" },
                job_id: str("Search id; defaults to the latest"),
              },
              required: ["choice"],
            },
            expects_response: true,
          },
          {
            type: "client",
            name: "move_here",
            description: "Move a piece to where the shopper is looking, adjusted so it fits, or bring a stored piece back out.",
            parameters: {
              type: "object",
              properties: {
                item_id: str("Item id from get_room"),
                unlock: { type: "boolean", description: "True only after the shopper said it's okay to move a locked piece" },
              },
              required: ["item_id"],
            },
            expects_response: true,
          },
          {
            type: "client",
            name: "put_away",
            description: "Put a piece away in inventory: off the floor, and out of the basket if it was a purchase. Bring it back with move_here.",
            parameters: {
              type: "object",
              properties: {
                item_id: str("Item id from get_room"),
                unlock: { type: "boolean", description: "True only after the shopper said it's okay to move a locked piece" },
              },
              required: ["item_id"],
            },
            expects_response: true,
          },
          {
            type: "client",
            name: "set_budget",
            description: "Set the room's total budget for new purchases. Call after the shopper agreed to the amount.",
            parameters: { type: "object", properties: { usd: { type: "number", description: "New total budget in dollars" } }, required: ["usd"] },
            expects_response: true,
          },
          {
            type: "client",
            name: "get_cart",
            description: "Summarize proposed purchases and observed prices. The exact total, live recheck and payment approval stay in the on-screen Basket.",
            parameters: { type: "object", properties: {}, required: [] },
            expects_response: true,
          },
          {
            type: "client",
            name: "recheck_cart",
            description: "Payment and price recheck happen on screen in the Basket; this returns where to find them.",
            parameters: { type: "object", properties: {}, required: [] },
            expects_response: true,
          },
          {
            type: "client",
            name: "pay_now",
            description: "Payment happens on screen in the Basket with one Check out button; this returns where to find it.",
            parameters: { type: "object", properties: {}, required: [] },
            expects_response: true,
          },
          {
            type: "client",
            name: "apply_proposal",
            description: "Apply the proposal the shopper just agreed to out loud.",
            parameters: { type: "object", properties: { proposal_id: str("Id returned by propose_change") }, required: ["proposal_id"] },
            expects_response: true,
          },
        ],
      },
    },
  },
};
