"""
The agent's planner: Claude picks which room tools to run for a free-form message.

agent.py owns every tool implementation (they call the backend and send the
cards themselves); this module only holds the tool schemas, the system prompt
and the tool-use loop. Card clicks and onboarding forms never come through
here; they're routed deterministically in agent.py.
"""

from __future__ import annotations

import json
from typing import Awaitable, Callable

from anthropic import AsyncAnthropic

MODEL = "claude-opus-5-5"
MAX_STEPS = 8
HISTORY_TURNS = 10

client: AsyncAnthropic | None = None

SYSTEM = """You are Tadaima, a furniture planning agent inside an ASI:One chat. You work on the shopper's real room plan through tools; every change is checked by deterministic rules (fits in the room, clearance, locked items kept, budget, seats, sizes known, in stock).

How to act:
- Use tools to do what the shopper asks. Chain them when a request needs several steps (for example search, then place the best fit).
- Tools that show something (show_room, propose_change, search_products, show_cart, place/move/put away results) already sent the shopper a card or message. Don't repeat their contents, prices or totals. Your final reply is at most one short sentence (a next step or a choice to make), or empty.
- Never invent products, prices, sizes or stock. Only use ids returned by tools.
- Whole-room goals ("make it $300 cheaper", "restyle as Japandi", "seat six") go to propose_change; the shopper approves with the Apply button. Don't call apply_proposal unless the shopper clearly says to apply.
- Looking for a specific piece ("find a green sofa under $900", "a bigger rug") goes to search_products near the item it replaces or the spot they describe. Place a result only when the shopper picks one or clearly asked you to add the best one.
- Coordinates are meters on the floor: x right, z toward the room's front, origin at the back-left corner. Items' position is the footprint center.
- Locked items are things the shopper owns or told you to keep; only move or remove them if they explicitly ask.
- Nothing is bought without the shopper's approval. show_cart lists the cart; when the shopper says to check out, they get a payment and approval flow outside your tools.
- Plain, warm, brief. No marketing tone. No em dashes."""

_spot = {
    "near_item_id": {"type": ["string", "null"], "description": "Use this item's spot (e.g. the piece being replaced)."},
    "x": {"type": ["number", "null"], "description": "Floor x in meters, when not using near_item_id."},
    "z": {"type": ["number", "null"], "description": "Floor z in meters, when not using near_item_id."},
}

TOOLS = [
    {
        "name": "get_room",
        "description": "Read the current plan: room size, walls and openings, every item (id, label, category, owned or planned purchase, price, size, position, locked, stored), budget, seats and failing rules. Shows nothing to the shopper.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "show_room",
        "description": "Show the shopper their room summary and product cards.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "propose_change",
        "description": "Plan a whole-room change from a plain-language goal. Shows the shopper the diff and an Apply button. Returns the proposal summary, changes, cost before/after and whether it passes.",
        "input_schema": {
            "type": "object",
            "properties": {
                "intent": {"type": "string", "description": "The goal in the shopper's words, with any constraints."},
                "item_id": {"type": ["string", "null"], "description": "Item the request is about, if any."},
            },
            "required": ["intent"],
        },
    },
    {
        "name": "apply_proposal",
        "description": "Apply the pending proposal. Only when the shopper explicitly says to apply it.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "search_products",
        "description": "Search our catalog of real retailer products for ones that fit at a spot in the room. Instant; shows the shopper a carousel of those that fit. For fresh live store results, use hire_scout.",
        "input_schema": {
            "type": "object",
            "properties": {
                "category": {"type": "string", "enum": ["sofa", "chair", "table", "desk", "storage", "bed", "rug", "lamp", "decor", "other"]},
                "style": {"type": ["string", "null"], "description": "Style or color words, e.g. 'green velvet, mid-century'."},
                "max_price_usd": {"type": ["number", "null"]},
                **_spot,
            },
            "required": ["category"],
        },
    },
    {
        "name": "place_product",
        "description": "Prepare a product from search at a spot. For a paired scanned room this only sends an on-screen preview for the shopper to confirm; it never changes the room or cart. For legacy demo rooms, adds the product after the shopper asks.",
        "input_schema": {
            "type": "object",
            "properties": {
                "product_id": {"type": "string"},
                "job_id": {"type": ["string", "null"], "description": "The search it came from (needed for live finds)."},
                "replace_item_id": {"type": ["string", "null"]},
                **_spot,
            },
            "required": ["product_id"],
        },
    },
    {
        "name": "move_item",
        "description": "Move an item to a spot (re-placed so it fits). Also brings a stored item back out.",
        "input_schema": {
            "type": "object",
            "properties": {"item_id": {"type": "string"}, "unlock": {"type": "boolean", "description": "Needed to move a locked item."}, **_spot},
            "required": ["item_id"],
        },
    },
    {
        "name": "put_away",
        "description": "Put an item away in inventory: kept in the plan, out of the room and the cart.",
        "input_schema": {"type": "object", "properties": {"item_id": {"type": "string"}, "unlock": {"type": "boolean"}}, "required": ["item_id"]},
    },
    {
        "name": "set_constraints",
        "description": "Change the budget cap for new purchases and/or the minimum seats.",
        "input_schema": {
            "type": "object",
            "properties": {"budget_usd": {"type": ["number", "null"]}, "minimum_seats": {"type": ["integer", "null"]}},
        },
    },
    {
        "name": "lock_item",
        "description": "Lock (keep no matter what) or unlock an item.",
        "input_schema": {"type": "object", "properties": {"item_id": {"type": "string"}, "locked": {"type": "boolean"}}, "required": ["item_id", "locked"]},
    },
    {
        "name": "hire_scout",
        "description": "Hire the Scout agent to search stores live (IKEA, Target) for a piece that fits at a spot. Costs a small testnet FET fee and takes 2 to 4 minutes; results post to the chat on their own, fit-checked against the room, with Add buttons. Use after search_products when the catalog has nothing good, or when the shopper wants fresh options.",
        "input_schema": {
            "type": "object",
            "properties": {
                "category": {"type": "string", "enum": ["sofa", "chair", "table", "desk", "storage", "bed", "rug", "lamp", "decor", "other"]},
                "style": {"type": ["string", "null"]},
                "max_price_usd": {"type": ["number", "null"]},
                "merchants": {"type": ["array", "null"], "items": {"type": "string", "enum": ["IKEA", "Target"]}},
                **_spot,
            },
            "required": ["category"],
        },
    },
    {
        "name": "check_delivery",
        "description": "Ask the Fit Check agent whether a piece (an item in the room or a product from a search) gets through the shopper's door: tries every orientation, tilting, ceiling. Shows the verdict to the shopper.",
        "input_schema": {
            "type": "object",
            "properties": {
                "item_id": {"type": ["string", "null"]},
                "product_id": {"type": ["string", "null"]},
                "door_width_m": {"type": "number", "description": "Clear door opening width in meters (convert from cm/in)."},
                "door_height_m": {"type": ["number", "null"]},
            },
            "required": ["door_width_m"],
        },
    },
    {
        "name": "show_cart",
        "description": "Show the cart: planned purchases per merchant with links and totals.",
        "input_schema": {"type": "object", "properties": {}},
    },
]

Tool = Callable[[dict], Awaitable[str]]


async def run_turn(history: list[dict], text: str, tools: dict[str, Tool], log=None, *, paired: bool = False) -> tuple[str, list[dict]]:
    """One shopper message. Returns (final reply text, updated history of plain-text turns)."""
    global client
    if client is None:
        client = AsyncAnthropic()
    messages = [*history[-HISTORY_TURNS * 2 :], {"role": "user", "content": text}]
    reply = ""
    for _ in range(MAX_STEPS):
        res = await client.beta.messages.create(
            model=MODEL,
            max_tokens=4000,
            system=[{"type": "text", "text": SYSTEM + ("\nThis is a paired private scanned room. You may read, search, propose, and prepare a product preview. place_product ONLY prepares an on-screen preview; it never adds to the room or basket. The shopper must review and confirm all changes and payments on the website. Do not claim a change was applied. Private photos and models are unavailable. Use the room floor polygon coordinates exactly as returned; do not assume a back-left origin." if paired else ""), "cache_control": {"type": "ephemeral"}}],
            tools=[tool for tool in TOOLS if tool["name"] in tools],
            messages=messages,
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        if res.stop_reason == "refusal":
            reply = "I can't help with that one. Ask me about your room, products or cart."
            break
        reply = "".join(b.text for b in res.content if b.type == "text").strip()
        calls = [b for b in res.content if b.type == "tool_use"]
        if res.stop_reason != "tool_use" or not calls:
            break
        messages.append({"role": "assistant", "content": res.content})
        results = []
        for call in calls:
            fn = tools.get(call.name)
            try:
                out = await fn(dict(call.input)) if fn else json.dumps({"error": f"unknown tool {call.name}"})
                results.append({"type": "tool_result", "tool_use_id": call.id, "content": out})
            except Exception as e:  # a failed tool goes back to Claude, which tells the shopper
                if log:
                    log(f"tool {call.name} failed: {e}")
                results.append({"type": "tool_result", "tool_use_id": call.id, "content": f"failed: {e}", "is_error": True})
        messages.append({"role": "user", "content": results})
    # only plain text is kept between turns, so stored history never replays tool or thinking blocks
    new_history = [*history, {"role": "user", "content": text}, {"role": "assistant", "content": reply or "(done)"}]
    return reply, new_history[-HISTORY_TURNS * 2 :]
