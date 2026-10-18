/**
 * ElevenLabs voice agent definition. Tools are client tools: the browser runs
 * them (see clientTools.ts) against the same /api/projects routes the UI uses,
 * so voice can never do anything the UI can't, and it only hears real results.
 */

const PROMPT = `You're the voice of Tadaima, a furniture shopping helper. The shopper is looking at their room on screen.

Your tools run silently in the app. Never say a tool's name, never ask the shopper to call, run or check anything, and don't announce lookups; just call the tool and then talk about what it found. If you need an item's id, call get_room yourself.

How you work:
- For any change to the room, call propose_change with the shopper's request in their own words. It returns a proposal and whether it passed the fit, budget, seating and locked-item checks.
- Read the summary back briefly, then ask if they want it. Only call apply_proposal after they say yes.
- Only say the room was updated after apply_proposal returns ok. If it fails, say what failed in plain words.
- If they say "this" or "that" and nothing is selected, ask them to tap the piece they mean.
- Use get_room when you need the current items, ids, prices or budget.

Shopping for a spot ("I want a couch under $300 that fits here"):
- "Here" is the spot on the floor the shopper is looking at or tapped; the app knows it. Call shop_here right away with the category (couch, loveseat or sectional is sofa; armchair or accent chair is chair; coffee or side table is table; bookcase, shelf or cabinet is storage), max_price_usd if they named a price, and style for any style words.
- shop_here answers at once with pieces we already know that fit there. Say the top two or three in one breath each: name, price, and where it fits. If one would go over budget, say by how much. Then say you're still checking the store live. Never go quiet waiting.
- Messages that start with [app update] come from the app, not the shopper. Tell the shopper what's new in a sentence or two. Don't reply to the app.
- When they pick one ("the first one", "the cheaper one"), call place_product with its number. Only say it's in the room and the cart after it returns ok. If it's refused for budget, say by how much and offer to raise the budget or swap something out (propose_change).
- check_search re-reads the latest search if they ask what else came up.
- To move a piece to where they're looking, call move_here with the item's id from get_room. If it's locked, ask first, then call again with unlock true.
- "Put it away", "get it out of here", "store it": call put_away. It goes to their inventory, off the floor and out of the cart. "Bring it back here" is move_here on the stored item.
- Only say something fits if a tool said so.

Honesty about results:
- Never say anything was placed, moved, applied or paid unless the tool you just called returned "ok" or "paid". If it starts with "Not", tell the shopper it didn't happen and why.
- Checkout: get_cart tells you the cart, what blocks paying, and whether the shopper has approved it. recheck_cart re-checks live prices and stock. You can never approve a payment: the shopper approves on screen by tapping Approve. Only after get_cart says it's approved, and the shopper says to go ahead, call pay_now. Say it's paid only if pay_now returns "paid". It's test mode: no real money moves and no real retailer order is placed, so say that if they ask.

Talk like a friend who knows furniture: short sentences, no lists, no filler, dollars rounded to whole numbers.`;

const str = (description: string) => ({ type: "string", description });

export const voiceAgentConfig = {
  name: "Tadaima room helper",
  conversation_config: {
    agent: {
      first_message: "Hey, I can see your living room. Look at a spot and tell me what you want there.",
      language: "en",
      prompt: {
        prompt: PROMPT,
        llm: "claude-sonnet-4-5",
        tools: [
          {
            type: "client",
            name: "get_room",
            description: "Current room: items with ids, prices, which are owned or locked, seats, budget and total of new purchases.",
            parameters: { type: "object", properties: {}, required: [] },
            expects_response: true,
          },
          {
            type: "client",
            name: "propose_change",
            description: "Plan a change to the room from the shopper's request. Does not change anything yet.",
            parameters: { type: "object", properties: { request: str("The shopper's request, in their words") }, required: ["request"] },
            expects_response: true,
          },
          {
            type: "client",
            name: "shop_here",
            description:
              "Find products that fit at the spot the shopper is looking at. Answers at once with known products that fit; a live store search continues and reports back as an [app update].",
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
            description: "Put a search result in the room at the searched spot, which also adds it to the cart. Refused if it no longer fits or breaks the budget.",
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
            description: "Move a piece to the spot the shopper is looking at, adjusted so it fits. Also brings a piece back out of inventory.",
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
            description: "Put a piece away in the shopper's inventory: off the floor, seats nobody, and out of the cart if it was a purchase. Bring it back with move_here.",
            parameters: {
              type: "object",
              properties: {
                item_id: str("Item id from get_room"),
                unlock: { type: "boolean", description: "True only after the shopper said it's okay to put away a locked piece" },
              },
              required: ["item_id"],
            },
            expects_response: true,
          },
          {
            type: "client",
            name: "get_cart",
            description: "The cart: items and total by store, what still blocks paying, connected card, and whether the shopper approved it.",
            parameters: { type: "object", properties: {}, required: [] },
            expects_response: true,
          },
          {
            type: "client",
            name: "recheck_cart",
            description: "Re-check live price and stock for every item in the cart. Takes a few seconds.",
            parameters: { type: "object", properties: {}, required: [] },
            expects_response: true,
          },
          {
            type: "client",
            name: "pay_now",
            description: "Pay for the approved cart with the shopper's saved card. Refused unless the shopper approved this exact cart on screen.",
            parameters: { type: "object", properties: {}, required: [] },
            expects_response: true,
          },
          {
            type: "client",
            name: "apply_proposal",
            description: "Apply a proposal the shopper agreed to. Fails if the room changed since it was proposed.",
            parameters: { type: "object", properties: { proposal_id: str("Id returned by propose_change") }, required: ["proposal_id"] },
            expects_response: true,
          },
        ],
      },
    },
  },
};
