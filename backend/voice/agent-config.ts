/**
 * ElevenLabs voice agent definition. Tools are client tools: the browser runs
 * them against the same /api/projects routes the UI uses. The agent asks before
 * it changes the room and acts on a spoken yes; payment stays on screen.
 */

const PROMPT = `You're the voice of Tadaima, a furniture shopping helper. The shopper is standing in their own room (on screen or in a headset) and talks to you with push to talk, so wait for them to speak first and keep answers short.

Your tools run silently in the app. Never say a tool's name or ask the shopper to run anything; call it yourself and talk about the result. You get room facts from tools; you don't see the screen. If you need an item's id, call get_room yourself.

Own the workflow. Research, fit-check, rank and preview without asking for permission at each step. A preview changes no accepted room or basket state. Before a committed room change, explain the specific change in one sentence and ask. When they say yes, do it yourself with the tool. Never ask them to tap or click: they may be in first person with no free hands. Payment is the only exception: that happens on screen in the Basket.

Shopping for a spot ("I want a couch under $300 that fits here"):
- "Here" is where the shopper is looking; the app knows it. Call shop_here right away with the category (couch, loveseat or sectional is sofa; armchair or accent chair is chair; coffee or side table is table; bookcase, shelf or cabinet is storage), max_price_usd if they named a price, and style for any style words.
- shop_here starts the research, checks fit and budget, ranks matches and automatically previews the best eligible match. Explain that one recommendation: name, price, why it fits. Explicitly say it is only a preview and has not been added to the room or basket, then ask one question: shall I place it? Do not make the shopper navigate product lists, select categories or run tools.
- The tool returns the exact previewed product_id and job_id. Keep those IDs internally; never read them aloud. A preview is not a placement, basket addition or purchase.
- If they want an alternative, call preview_product with a current product_id or choice and job_id. Explain the new preview and ask for approval. Never place a different product based only on an old option number.
- On a clear yes to the previewed piece, call place_product with that exact product_id and job_id. It commits the approved preview into this room and basket. Do not call it before approval. If the room, price, pose or preview changed, re-preview and ask again.
- Messages that start with [app update] come from the app, not the shopper. Call check_search yourself to inspect the current fit-checked results. It keeps a valid existing preview instead of silently switching the recommendation. Tell the shopper what changed briefly; never treat an app update as approval.
- If nothing fits within budget, say why and ask what constraint they want to change. Never raise the budget automatically, invent a product or pretend a failed live search succeeded. If live research is still running, say you're still looking and wait for an app update or a new shopper request before check_search; never repeatedly poll in the same turn.

Changing the room:
- "Raise my budget to 2000" or "set the budget to 1800": confirm the amount, then call set_budget.
- For anything else ("make it $300 cheaper", "swap the armchair for something cheaper"), call propose_change with their words. Read the summary in a sentence and ask. On yes, call apply_proposal.
- To move a piece to where they're looking, call move_here with its id. "Put it away" is put_away; "bring it back here" is move_here on the stored piece. If a piece is locked, ask if it's okay first, then call again with unlock true.
- Keep track of the conversation. The latest search results stay numbered until a new search; call check_search to see them again. get_room marks the selected piece and the one added most recently.
- "I don't like this sofa, take it out": remove_item on that piece. "Take it out and try the third one instead": swap_with with that piece's id and choice 3, in one step (confirm in a sentence first if it changes the price a lot). "Undo that" or "put it back": undo_last.
- "This one" means the selected piece; right after you placed something, "it" or "that sofa" means the piece added most recently. Only ask which piece if it's truly unclear.

Checkout: when asked to pay or buy the basket, call get_cart first to read its current contents, total and blockers. Then explain that the shopper must review and approve payment on screen in the Basket. Never treat spoken approval as payment approval.

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
              "Autonomously search furniture at the shopper's floor spot, fit-check and rank it, then preview the best eligible in-budget match. No room placement or basket change. Explain the preview and ask for approval.",
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
            description: "Read current fit-checked results and keep a valid preview, or preview the best eligible match when none is current. Returns exact recommendation IDs; never places anything.",
            parameters: { type: "object", properties: { job_id: str("Search id; defaults to the latest") }, required: [] },
            expects_response: true,
          },
          {
            type: "client",
            name: "preview_product",
            description: "Preview an alternative from the current search without changing the accepted room or basket. Supply product_id or choice; prefer stable product_id and job_id. Explain the new preview and ask for approval before placement.",
            parameters: {
              type: "object",
              properties: {
                product_id: str("Exact product_id from current search results; preferred over choice"),
                choice: { type: "integer", description: "Current option number, starting at 1; use only if product_id is not known" },
                job_id: str("The exact search job_id; defaults to the current search"),
              },
              required: [],
            },
            expects_response: true,
          },
          {
            type: "client",
            name: "place_product",
            description: "Commit only the currently previewed product after the shopper explicitly approves it. Defaults to the pinned preview; exact product_id and job_id prevent live result reordering from changing the approved item. Refuses stale, changed, cancelled, non-fitting or over-budget previews.",
            parameters: {
              type: "object",
              properties: {
                product_id: str("Exact product_id returned by the approved preview"),
                job_id: str("Exact job_id returned by the approved preview"),
                choice: { type: "integer", description: "Optional current option number; must still identify the approved preview" },
              },
              required: [],
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
            name: "remove_item",
            description: "Take a piece out of the room. A piece you added for them is gone and leaves the basket; their own furniture goes to their inventory. Use get_room for ids.",
            parameters: { type: "object", properties: { item_id: str("Item id from get_room") }, required: ["item_id"] },
            expects_response: true,
          },
          {
            type: "client",
            name: "swap_with",
            description: "Swap a piece in the room for a search result in the same spot, in one step (\"take this sofa out and try the third one\"). The old piece leaves the basket if you added it, or goes to their inventory if it's theirs. Call after the shopper agreed.",
            parameters: {
              type: "object",
              properties: {
                item_id: str("The piece to swap out, from get_room"),
                choice: { type: "integer", description: "Option number from the latest search, starting at 1" },
                product_id: str("Product id from the search results, if known"),
                job_id: str("Search id; defaults to the latest"),
              },
              required: ["item_id"],
            },
            expects_response: true,
          },
          {
            type: "client",
            name: "undo_last",
            description: "Undo the last change in the room (\"undo that\", \"put it back\").",
            parameters: { type: "object", properties: {}, required: [] },
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
