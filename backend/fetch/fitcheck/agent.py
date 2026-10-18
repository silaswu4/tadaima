"""
Fit Check: "will this furniture fit?" over ASI:One chat and the TadaimaFitCheck protocol.

Claude only reads the message into numbers (with units, converted here). The
verdict always comes from fit.py, which is deterministic and tested. If key
numbers are missing the person gets one form card; product links are measured
by the Scout agent when it's configured (scout.py), otherwise we ask for the size.

Run: see README.md next to this file.
"""

from __future__ import annotations

import json
import os
import re
import sys
from uuid import uuid4

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(1, os.path.dirname(HERE))  # protocols.py, scout_client.py

from anthropic import AsyncAnthropic  # noqa: E402
from uagents import Agent, Context, Protocol  # noqa: E402
from uagents_core.contrib.protocols.chat import (  # noqa: E402
    ChatAcknowledgement,
    ChatMessage,
    MetadataContent,
    TextContent,
    chat_protocol_spec,
)
from uagents_core.contrib.protocols.chat.cards import (  # noqa: E402
    CtaAction,
    FormCardPayload,
    FormField,
    FormFieldOption,
    ReviewCardPayload,
    ReviewSummaryRow,
    create_card_content,
    extract_card_response,
)

import fit  # noqa: E402
import scout  # noqa: E402
from protocols import FitRequest, FitVerdict, fit_protocol  # noqa: E402

MODEL = "claude-opus-5-5"

agent = Agent(
    name=os.getenv("FITCHECK_NAME", "tadaima-fitcheck"),
    seed=os.environ["FITCHECK_SEED"],
    port=int(os.getenv("FITCHECK_PORT", "8003")),
    mailbox=True,
    publish_agent_details=True,
    readme_path=os.path.join(HERE, "README.md"),
    handle_messages_concurrently=True,
)
chat = Protocol(spec=chat_protocol_spec)
claude = AsyncAnthropic()

# piece_* are the furniture; the rest describe where it goes and how it gets there
FIELDS = ["piece_width", "piece_depth", "piece_height", "space_width", "space_depth", "ceiling", "door_width", "door_height"]
TO_M = {"m": 1.0, "cm": 0.01, "mm": 0.001, "in": 0.0254, "ft": 0.3048}


# ---------- reading the message (Claude parses, never judges) ----------

_measure = {
    "type": ["object", "null"],
    "properties": {"value": {"type": "number"}, "unit": {"type": "string", "enum": list(TO_M)}},
    "required": ["value", "unit"],
}

PARSE_TOOL = {
    "name": "measurements",
    "description": "Record the furniture fit question's measurements.",
    "input_schema": {
        "type": "object",
        "properties": {
            "about_fit": {"type": "boolean", "description": "The message is about whether some furniture fits (or gives sizes for one)."},
            "new_piece": {"type": "boolean", "description": "They moved on to a different piece of furniture, so the old piece's size no longer applies."},
            "piece_label": {"type": ["string", "null"], "description": "What the piece is, e.g. 'sofa', 'IKEA KIVIK sofa'."},
            "product_url": {"type": ["string", "null"]},
            **{f: {**_measure, "description": d} for f, d in {
                "piece_width": "Piece's longest side seen from the front (W, length of a sofa or bed).",
                "piece_depth": "Piece's front to back (D). For a bed, the other floor side.",
                "piece_height": "Piece's height (H).",
                "space_width": "Width of the wall, alcove or floor space it goes in (along the piece's width).",
                "space_depth": "Room or space depth out from that wall.",
                "ceiling": "Ceiling height.",
                "door_width": "Door or opening width it has to come through.",
                "door_height": "Door or opening height.",
            }.items()},
        },
        "required": ["about_fit", "new_piece"],
    },
}

PARSE_SYSTEM = """You read furniture fit questions and record the numbers with the measurements tool. Never judge whether it fits.

- Keep each number in the unit the person used (cm, mm, m, in, ft). Feet and inches like 6'8" become inches (80 in). "80 x 200 cm" for a door is width 80, height 200.
- A piece written "W x D x H" or "2.1 x 0.9 m" is width then depth (then height). If labeled (W/D/H, wide/deep/tall), follow the labels.
- "Known so far" holds values from earlier in this chat. Return the full current set: keep those unless the person changes them, set new_piece and drop the old piece size if they ask about a different item.
- Only record numbers the person actually gave. Don't guess typical sizes. Use null when unknown.
- Always answer by calling the tool exactly once, even for a message that isn't about furniture (about_fit false)."""


def to_m(v) -> float | None:
    if not isinstance(v, dict):
        return None
    try:
        x = float(v["value"]) * TO_M[v.get("unit", "m")]
    except (KeyError, TypeError, ValueError):
        return None
    return round(x, 4) if 0.01 <= x <= 50 else None


def _known_text(state: dict) -> str:
    vals = {f: state[f] for f in FIELDS if state.get(f)}
    if state.get("product_url"):
        vals["product_url"] = state["product_url"]
    return "Known so far (meters): " + (json.dumps(vals) if vals else "nothing")


async def extract(text: str, state: dict) -> dict | None:
    """Merged state from the message, or None if it isn't about fit. Raises on API errors."""
    res = await claude.beta.messages.create(
        model=MODEL,
        max_tokens=1000,
        system=[{"type": "text", "text": PARSE_SYSTEM, "cache_control": {"type": "ephemeral"}}],
        tools=[PARSE_TOOL],
        messages=[{"role": "user", "content": f"{_known_text(state)}\n\nMessage: {text}"}],
        output_config={"effort": "low"},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    call = next((b for b in res.content if b.type == "tool_use"), None)
    if call is None:
        return None
    got = dict(call.input)
    if not got.get("about_fit"):
        return None
    new = {**state} if not got.get("new_piece") else {k: v for k, v in state.items() if not k.startswith("piece_") and k not in ("product_url", "piece_label")}
    for f in FIELDS:
        if got.get(f) is not None:
            new[f] = to_m(got[f])
    for k in ("product_url", "piece_label"):
        if got.get(k):
            new[k] = got[k]
    return new


# ---------- forms ----------


def num_field(name: str, label: str, state: dict, unit: str) -> dict:
    v = state.get(name)
    shown = f"{v / TO_M[unit]:.0f}" if v and unit != "m" else (f"{v:.2f}" if v else None)
    return {"name": name, "kind": "number", "label": label, "placeholder": shown}


def fit_form(state: dict) -> MetadataContent:
    """Strict uagents-core form schema only: ASI:One drops cards with fields it doesn't accept."""
    unit = state.get("unit", "cm")
    fields = [
        {"name": "product_url", "kind": "text", "label": "Product link (or fill in the size below)", "placeholder": state.get("product_url") or "https://www.ikea.com/..."},
        num_field("piece_width", "Piece width", state, unit),
        num_field("piece_depth", "Piece depth", state, unit),
        num_field("piece_height", "Piece height", state, unit),
        num_field("space_width", "Wall or space width", state, unit),
        num_field("space_depth", "Room depth (optional)", state, unit),
        num_field("ceiling", "Ceiling height (optional)", state, unit),
        num_field("door_width", "Door width (optional)", state, unit),
        num_field("door_height", "Door height (optional)", state, unit),
        {"name": "unit", "kind": "select", "label": "Units", "options": [{"value": u, "label": u} for u in ("cm", "in", "m", "ft")]},
    ]
    payload = FormCardPayload(
        title="Will it fit?",
        fields=[FormField(**{**f, "options": [FormFieldOption(**o) for o in f["options"]] if f.get("options") else None}) for f in fields],
        submit_cta=CtaAction(label="Check the fit", primary=True, selection={"action": "fit"}),
    )
    return create_card_content(payload, card_id=uuid4())


def from_form(sel: dict, state: dict) -> dict:
    unit = str(sel.get("unit") or state.get("unit") or "cm").lower()
    unit = unit if unit in TO_M else "cm"
    new = {**state, "unit": unit}
    for f in FIELDS:
        raw = sel.get(f)
        if raw in (None, ""):
            continue
        try:
            new[f] = to_m({"value": float(str(raw).replace(",", ".")), "unit": unit})
        except ValueError:
            pass
    url = str(sel.get("product_url") or "").strip()
    if url.startswith("http"):
        new["product_url"] = url
    return new


def is_form(sel: dict | None) -> bool:
    return bool(sel) and (sel.get("action") == "fit" or any(k in sel for k in [*FIELDS, "product_url", "unit"]))


# ---------- messages ----------


def msg(*blocks) -> ChatMessage:
    return ChatMessage(content=[TextContent(text=b) if isinstance(b, str) else b for b in blocks if b is not None])


def parse_selection(m: ChatMessage) -> dict | None:
    """Card submits arrive as card MetadataContent, or as JSON text (sometimes after @handle)."""
    for block in m.content:
        if isinstance(block, MetadataContent):
            try:
                r = extract_card_response(block)
            except Exception:
                r = None
            if r and r.selection:
                return dict(r.selection)
    raw = re.sub(r"^@\S+\s*", "", m.text().strip())
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def size(v: float | None) -> str:
    return f"{v:.2f} m" if v else "?"


HEADLINE = {
    "yes": "Yes, it fits.",
    "no": "No, it won't fit.",
    "unknown": "I can't say for sure yet.",
}


def verdict_card(state: dict, r: fit.Result) -> MetadataContent:
    s = state
    said = {c.name: {"yes": "fits", "no": "doesn't fit", "unknown": "not sure"}[c.verdict] for c in r.checks}
    rows = [ReviewSummaryRow(label="Piece (W x D x H)", value=f"{size(s.get('piece_width'))} x {size(s.get('piece_depth'))} x {size(s.get('piece_height'))}")]
    given = {
        "space": size(s["space_width"]) + (f" x {size(s['space_depth'])}" if s.get("space_depth") else " wall") if s.get("space_width") else None,
        "ceiling": size(s["ceiling"]) if s.get("ceiling") else None,
        "door": f"{size(s.get('door_width'))} x {size(s.get('door_height'))}" if s.get("door_width") or s.get("door_height") else None,
    }
    for name, value in given.items():
        if value:
            rows.append(ReviewSummaryRow(label=name.capitalize(), value=value + (f", {said[name]}" if name in said else "")))
    if r.orientation:
        rows.append(ReviewSummaryRow(label="Place it", value=r.orientation))
    if r.door_orientation:
        rows.append(ReviewSummaryRow(label="Carry it in", value=r.door_orientation))
    title = {"yes": "Fits" + (", a bit tight" if r.tight else ""), "no": "Doesn't fit", "unknown": "Not sure yet"}[r.fits]
    return create_card_content(ReviewCardPayload(
        title=f"{title}: {s.get('piece_label') or 'your piece'}",
        summary_rows=rows,
        approve_cta=CtaAction(label="Check another piece", primary=True, selection={"action": "new"}),
        reject_cta=CtaAction(label="Change the numbers", selection={"action": "edit"}),
    ), card_id=uuid4())


def run_check(s: dict) -> fit.Result:
    return fit.check(
        [s.get("piece_width"), s.get("piece_height"), s.get("piece_depth")],
        space_w=s.get("space_width"), space_d=s.get("space_depth"), ceiling=s.get("ceiling"),
        door_w=s.get("door_width"), door_h=s.get("door_height"),
    )


def verdict_text(s: dict, r: fit.Result) -> str:
    head = HEADLINE[r.fits] if not (r.fits == "yes" and r.tight) else "Yes, it fits, but it's tight."
    lines = [f"**{head}**", ""] + [f"- {x}" for x in r.reasons]
    if any(c.verdict == "unknown" and "within" in c.reason for c in r.checks):
        lines += ["", "Measure again (inside the door frame, at the floor for walls) and send me the numbers."]
    return "\n".join(lines)


def missing(s: dict) -> list[str]:
    out = []
    if not (s.get("piece_width") and s.get("piece_depth")):
        out.append("the piece's width and depth")
    if not (s.get("space_width") or s.get("ceiling") or (s.get("door_width") and s.get("door_height"))):
        out.append("the space (wall width, ceiling or door)")
    return out


HELP = (
    "Hi, I'm Fit Check. Tell me the piece and the space and I'll tell you if it fits, "
    "including whether it gets through the door.\n\n"
    "Try: *will a 210 x 90 x 85 cm sofa fit on a 2.4 m wall? door is 80 x 200 cm.* "
    "Inches and feet work too, and you can paste a product link."
)
GREETING = re.compile(r"^\s*(hi|hey|yo|hello|sup|start|help|what can you do)\b[\s!?.]*$", re.I)
RESET = re.compile(r"^\s*(reset|start over|new|clear)\b", re.I)


# ---------- turn handling ----------


def get_state(ctx: Context, sender: str) -> dict:
    return ctx.storage.get(f"fit:{sender}") or {}


def save_state(ctx: Context, sender: str, s: dict):
    ctx.storage.set(f"fit:{sender}", s)


async def fill_from_link(ctx: Context, s: dict) -> tuple[dict, bool]:
    """Measure product_url with Scout if we can. Returns (state, tried)."""
    if not s.get("product_url") or (s.get("piece_width") and s.get("piece_depth")) or s.get("measured_url") == s["product_url"]:
        return s, False
    if not scout.available():
        return s, False
    product = await scout.measure(ctx, s["product_url"])
    s = {**s, "measured_url": s["product_url"]}
    if product and product.dimensions_wdh_m and len(product.dimensions_wdh_m) == 3:
        w, h, d = product.dimensions_wdh_m
        s.update(piece_width=w, piece_height=h, piece_depth=d, piece_label=product.label or s.get("piece_label"))
    return s, True


async def answer(ctx: Context, sender: str, s: dict):
    s, tried = await fill_from_link(ctx, s)
    gaps = missing(s)
    if gaps:
        lead = ""
        if s.get("product_url") and not s.get("piece_width"):
            lead = ("I couldn't read the size off that link. " if tried else "I can't open product links right now. ") + \
                "What are its width, depth and height? They're usually under *Dimensions* or *Product details* on the page.\n\n"
            gaps = [g for g in gaps if not g.startswith("the piece")]
        need = f"I still need {' and '.join(gaps)}. " if gaps else ""
        if not s.get("form_sent"):
            s["form_sent"] = True
            save_state(ctx, sender, s)
            return await ctx.send(sender, msg(lead + need + "Fill in what you know:", fit_form(s)))
        save_state(ctx, sender, s)
        return await ctx.send(sender, msg(lead + need + "Just type them, like *wall 240 cm, sofa 210 x 90 x 85 cm*."))
    save_state(ctx, sender, s)
    r = run_check(s)
    ctx.logger.info(f"verdict {r.fits} for {sender[:16]}")
    await ctx.send(sender, msg(verdict_text(s, r), verdict_card(s, r)))


async def handle_turn(ctx: Context, sender: str, m: ChatMessage):
    s = get_state(ctx, sender)
    sel = parse_selection(m)
    if sel and sel.get("action") == "new":
        save_state(ctx, sender, {k: v for k, v in s.items() if not k.startswith("piece_") and k not in ("product_url", "piece_label", "measured_url")})
        return await ctx.send(sender, msg("Sure. What's the next piece? Size or a link, and I'll keep your space numbers."))
    if sel and sel.get("action") == "edit":
        return await ctx.send(sender, msg("Fix whatever's off:", fit_form(s)))
    if is_form(sel):
        return await answer(ctx, sender, from_form(sel, s))
    text = re.sub(r"^@\S+\s*", "", m.text().strip())
    if not text:
        return
    if GREETING.match(text):
        return await ctx.send(sender, msg(HELP))
    if RESET.match(text) and len(text) < 20:
        save_state(ctx, sender, {})
        return await ctx.send(sender, msg("Cleared. Tell me the piece and the space."))
    try:
        new = await extract(text, s)
    except Exception as e:  # no parser: the form still works
        ctx.logger.error(f"parse failed: {e}")
        if s.get("form_sent"):
            return await ctx.send(sender, msg("I couldn't read that one just now. Try the form above, or say **change the numbers** for a fresh one."))
        s["form_sent"] = True
        save_state(ctx, sender, s)
        return await ctx.send(sender, msg("I couldn't read that one just now. Fill in the numbers here:", fit_form(s)))
    if new is None:
        return await ctx.send(sender, msg(HELP))
    await answer(ctx, sender, new)


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, m: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=m.msg_id))
    ctx.logger.info(f"turn from {sender[:16]}: {m.text()[:120]!r}")
    try:
        await handle_turn(ctx, sender, m)
    except Exception as e:  # never leave ASI:One hanging without a reply
        ctx.logger.exception("turn failed")
        await ctx.send(sender, msg(f"Something broke on my side ({type(e).__name__}). Try again?"))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, m: ChatAcknowledgement):
    pass


# ---------- agents ----------


@fit_protocol.on_message(FitRequest, replies={FitVerdict})
async def on_fit(ctx: Context, sender: str, req: FitRequest):
    product = None
    dims = req.dimensions_wdh_m
    if not (dims and len(dims) == 3) and req.product_url:
        product = await scout.measure(ctx, req.product_url)
        dims = product.dimensions_wdh_m if product else None
    r = fit.check(
        dims, space_w=req.space_width_m, space_d=req.space_depth_m, ceiling=req.ceiling_m,
        door_w=req.door_width_m, door_h=req.door_height_m, clearance=req.clearance_m,
    )
    reasons = r.reasons
    if not dims and req.product_url:
        reasons = ["I couldn't measure that link. Send dimensions_wdh_m instead."]
    ctx.logger.info(f"FitRequest {req.request_id} from {sender[:16]}: {r.fits}")
    await ctx.send(sender, FitVerdict(request_id=req.request_id, fits=r.fits, reasons=reasons, product=product))


agent.include(chat, publish_manifest=True)
agent.include(fit_protocol, publish_manifest=True)

if __name__ == "__main__":
    agent.run()
