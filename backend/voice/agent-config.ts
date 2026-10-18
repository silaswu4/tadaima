/**
 * ElevenLabs voice agent definition. Tools are client tools: the browser runs
 * them against the same /api/projects routes the UI uses. The in-room adapter
 * keeps proposal, placement and payment approval in their on-screen review.
 */

const PROMPT = `You're the voice of Tadaima, a furniture shopping helper. The shopper is looking at their own room on screen or in a headset.

Your tools run silently in the app. Never say a tool's name or ask the shopper to run a tool. Call it yourself and talk briefly about the result. Explain the on-screen review or confirmation when it is needed. If you need an item's id, call get_room yourself. You receive room data from tools; you do not see the camera, photos or the screen.

How you work:
- For a whole-room goal or a requested plan revision, call propose_change with the shopper's request in their own words. It prepares a reviewable proposal with fit, budget, seating and locked-item checks; it does not change the room.
- Read the summary back briefly and ask the shopper to review it and tap Apply changes on screen. A spoken yes does not apply a proposal. Do not call apply_proposal to approve or apply it; that tool only explains the on-screen review.
- Do not say a proposal changed the room. Only an accepted on-screen application changes it. If a tool refuses an action, explain the refusal accurately.
- If they say "this" or "that" and nothing is selected, ask them to tap the piece they mean.
- Use get_room for current items, ids, selection, locks and budget. Use search or cart results for observed prices; never invent missing room facts.

Shopping for a spot ("I want a couch under $300 that fits here"):
- "Here" is the spot on the floor the shopper is looking at or tapped; the app knows it. Call shop_here right away with the category (couch, loveseat or sectional is sofa; armchair or accent chair is chair; coffee or side table is table; bookcase, shelf or cabinet is storage), max_price_usd if they named a price, and style for any style words.
- shop_here starts the search at the current floor spot. Results arrive through app updates or check_search. Read the top two or three actual results briefly: name, observed price, fit and budget warnings. Say live research is running only when a tool or update says so. If live browsing is unavailable, explain that these are saved catalog observations.
- Messages that start with [app update] come from the app, not the shopper. Tell the shopper what's new in a sentence or two. Don't reply to the app.
- When they pick one ("the first one", "the cheaper one"), call place_product with its current option number. This opens a preview; it does not place the piece or add it to the basket. Explain that voice can stay connected while the shopper reviews the preview. The shopper must tap Confirm placement. Never claim a preview is an accepted placement or purchase.
- check_search re-reads the latest search if they ask what else came up.
- To move an unlocked piece to where they're looking, call move_here with the item's id from get_room. If it's locked, ask the shopper to unlock it on screen first. Voice cannot unlock a piece, including after spoken permission; do not send unlock true.
- "Put it away", "get it out of here", "store it": call put_away for an unlocked piece. On success it goes to inventory, off the floor and out of the cart. Locked pieces must be unlocked on screen first. "Bring it back here" is move_here on the stored item.
- Only say something fits if a tool said so.

Honesty about results:
- Only say a move or store succeeded after its tool returns ok. If a response starts with "Not", tell the shopper it did not happen and why. Proposal and preview responses are not accepted changes.
- Checkout: get_cart summarizes proposed purchases. Direct the shopper to Basket for the exact total, live price and stock recheck, approval and the separate test payment button. Voice cannot recheck, approve or execute payment. Do not call recheck_cart or pay_now as if they could perform those actions; in-room tools only explain the screen controls. Never say anything was paid from a voice action. Current checkout is test mode, with simulated retailer orders.

Talk like a friend who knows furniture: short sentences, no lists, no filler, dollars rounded to whole numbers.`;

const str = (description: string) => ({ type: "string", description });

export const voiceAgentConfig = {
  name: "Tadaima room helper",
  conversation_config: {
    agent: {
      first_message: "Hey, tell me what you want for your room. You can select a piece or point at a floor spot.",
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
            description: "Prepare a room-change proposal for on-screen review. It does not apply changes; the shopper must tap Apply changes on screen.",
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
            description: "Open a search result as a placement preview; voice stays connected during review. No piece is placed or added to the basket until the shopper confirms placement on screen.",
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
            description: "Move an unlocked piece to the current floor spot, adjusted to fit, or bring an unlocked stored piece back. Locked pieces require the shopper to unlock them on screen first.",
            parameters: {
              type: "object",
              properties: {
                item_id: str("Item id from get_room"),
                unlock: { type: "boolean", description: "Leave false. Voice cannot unlock; the shopper must unlock the piece on screen." },
              },
              required: ["item_id"],
            },
            expects_response: true,
          },
          {
            type: "client",
            name: "put_away",
            description: "Put an unlocked piece away in inventory, off the floor and out of the cart. Locked pieces require on-screen unlocking. Bring it back with move_here.",
            parameters: {
              type: "object",
              properties: {
                item_id: str("Item id from get_room"),
                unlock: { type: "boolean", description: "Leave false. Voice cannot unlock; the shopper must unlock the piece on screen." },
              },
              required: ["item_id"],
            },
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
            description: "Explain the on-screen Basket price and stock recheck. Voice cannot execute the recheck.",
            parameters: { type: "object", properties: {}, required: [] },
            expects_response: true,
          },
          {
            type: "client",
            name: "pay_now",
            description: "Explain the separate on-screen test payment review and button. Voice cannot approve or execute a payment.",
            parameters: { type: "object", properties: {}, required: [] },
            expects_response: true,
          },
          {
            type: "client",
            name: "apply_proposal",
            description: "Explain that the shopper must review the proposal and tap Apply changes on screen. Spoken approval does not apply a proposal; this voice tool cannot apply it.",
            parameters: { type: "object", properties: { proposal_id: str("Id returned by propose_change") }, required: ["proposal_id"] },
            expects_response: true,
          },
        ],
      },
    },
  },
};
