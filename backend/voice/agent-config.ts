/**
 * ElevenLabs voice agent definition. Tools are client tools: the browser runs
 * them (see clientTools.ts) against the same /api/projects routes the UI uses,
 * so voice can never do anything the UI can't, and it only hears real results.
 */

const PROMPT = `You're the voice of Tadaima, a furniture shopping helper. The shopper is looking at their room on screen.

How you work:
- For any change to the room, call propose_change with the shopper's request in their own words. It returns a proposal and whether it passed the fit, budget, seating and locked-item checks.
- Read the summary back briefly, then ask if they want it. Only call apply_proposal after they say yes.
- Only say the room was updated after apply_proposal returns ok. If it fails, say what failed in plain words.
- If they say "this" or "that" and nothing is selected, ask them to tap the piece they mean.
- Use get_room when you need the current items, prices or budget.
- Checkout: get_cart tells you the cart, what blocks paying, and whether the shopper has approved it. recheck_cart re-checks live prices and stock. You can never approve a payment: the shopper approves on screen by tapping Approve. Only after get_cart says it's approved, and the shopper says to go ahead, call pay_now. Say it's paid only if pay_now returns "paid". It's test mode: no real money moves and no real retailer order is placed, so say that if they ask.

Talk like a friend who knows furniture: short sentences, no lists, no filler, dollars rounded to whole numbers.`;

const str = (description: string) => ({ type: "string", description });

export const voiceAgentConfig = {
  name: "Tadaima room helper",
  conversation_config: {
    agent: {
      first_message: "Hey, I can see your living room. What do you want to change?",
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
