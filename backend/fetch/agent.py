"""
Tadaima room planner: the ASI:One / Agentverse face of the backend.

A thin Agent Chat Protocol adapter. Every turn becomes a call to the same
/api/projects routes the web app and voice agent use, so ASI:One edits the
real canonical plan, never a copy. Planning, validation and pricing all stay
in backend/plan; this file only talks and renders cards.

Each ASI:One sender gets a private copy of the demo room (proj_demo_<hash>).

Run: see backend/fetch/README.md. Needs uagents 0.26.x / uagents-core 0.4.x.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from uuid import uuid4

import aiohttp
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    MetadataContent,
    ResourceContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)
from uagents_core.contrib.protocols.chat.cards import (
    CarouselBadge,
    CarouselCardPayload,
    CarouselItem,
    CtaAction,
    ReviewCardPayload,
    ReviewSummaryRow,
    create_card_content,
    extract_card_response,
)

BACKEND = os.getenv("BACKEND_URL", "http://localhost:3000").rstrip("/")
# Vercel deployment protection bypass for server-to-server calls. Never commit it.
BYPASS = os.getenv("VERCEL_PROTECTION_BYPASS")
HERE = os.path.dirname(os.path.abspath(__file__))

agent = Agent(
    name=os.getenv("AGENT_NAME", "tadaima"),
    seed=os.environ["AGENT_SEED"],
    port=int(os.getenv("AGENT_PORT", "8001")),
    mailbox=True,
    publish_agent_details=True,
    readme_path=os.path.join(HERE, "README.md"),
    handle_messages_concurrently=True,
)
chat = Protocol(spec=chat_protocol_spec)


# ---------- backend calls ----------


class BackendError(Exception):
    pass


class Rejected(Exception):
    """The backend answered with a 4xx: a real refusal, not an outage."""


async def api(method: str, path: str, body: dict | None = None, timeout: float = 30) -> dict:
    headers = {"content-type": "application/json"}
    if BYPASS:
        headers["x-vercel-protection-bypass"] = BYPASS
    # one retry on network errors and 5xx; a 4xx is a real answer and is not retried
    for attempt in range(2):
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as http:
                async with http.request(method, f"{BACKEND}{path}", json=body, headers=headers) as res:
                    data = await res.json(content_type=None)
                    if res.status < 400:
                        return data
                    err = (data or {}).get("error", f"backend {res.status}")
                    if res.status < 500:
                        raise Rejected(err)
                    retry = BackendError(err)
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            retry = BackendError(type(e).__name__)
        if attempt == 0:
            await asyncio.sleep(1.5)
    raise retry


def project_for(sender: str) -> str:
    return "proj_demo_" + hashlib.sha256(sender.encode()).hexdigest()[:16]


# ---------- formatting ----------


def usd(money: dict | None) -> str:
    if not money:
        return "price unknown"
    return f"${money['amountMinor'] / 100:,.0f}"


def by_id(rows: list[dict]) -> dict[str, dict]:
    return {r["id"]: r for r in rows}


def seats(plan: dict) -> int:
    return sum(i.get("seats") or 0 for i in plan["items"])


def room_size(plan: dict) -> str:
    rooms = plan["geometry"]["rooms"]
    if not rooms or not rooms[0]["floorPolygon"]:
        return ""
    xs = [p[0] for p in rooms[0]["floorPolygon"]]
    zs = [p[1] for p in rooms[0]["floorPolygon"]]
    return f", {max(xs) - min(xs):.1f} x {max(zs) - min(zs):.1f} m"


def cost_line(cost: dict, plan: dict) -> str:
    budget = plan["constraints"].get("budget")
    line = f"**{usd(cost['knownSubtotal'])}** in new purchases"
    if budget:
        line += f" against a {usd(budget)} cap"
    if cost.get("unknownPriceItemIds"):
        line += f", plus {len(cost['unknownPriceItemIds'])} item(s) with no price yet"
    return line + ". Shipping, tax and assembly stay unknown until a real cart is checked."


def room_summary(plan: dict, cost: dict) -> str:
    owned = [i for i in plan["items"] if i["origin"] == "existing_owned"]
    buying = [i for i in plan["items"] if i["origin"] == "proposed_purchase"]
    products = by_id(plan["products"])
    lines = [f"**Your room** (revision {plan['revision']}, demo living room{room_size(plan)})", ""]
    if owned:
        lines.append("Keeping what you own: " + ", ".join(f"{i['label']}{' (locked)' if i['locked'] else ''}" for i in owned))
    lines.append("")
    lines.append("Planned purchases:")
    for i in buying:
        p = products.get(i.get("productId") or "")
        price = usd(p["price"]) if p else "price unknown"
        lines.append(f"- {i['label']}: {price}{' (locked)' if i['locked'] else ''}")
    lines.append("")
    want = plan["constraints"].get("minimumSeats")
    lines.append(f"Seats {seats(plan)}" + (f" (needs at least {want})" if want else "") + ". " + cost_line(cost, plan))
    return "\n".join(lines)


def describe_change(c: dict, before: dict, after: dict) -> str:
    items = by_id(before["items"])
    products = by_id(after["products"])
    item = items.get(c.get("itemId", ""), {})
    name = item.get("label", c.get("itemId", "item"))
    k = c["kind"]
    if k == "replace":
        old = products.get(item.get("productId") or "")
        new = products.get(c["productId"], {})
        return f"Swap **{name}** ({usd(old['price']) if old else 'owned'}) for **{new.get('label', c['productId'])}** ({usd(new.get('price'))}, {new.get('merchant', '?')})"
    if k == "remove":
        return f"Remove **{name}**"
    if k == "move":
        x, _, z = c["position"]
        return f"Move **{name}** to x {x:.2f} m, z {z:.2f} m"
    if k == "lock":
        return f"{'Lock' if c['locked'] else 'Unlock'} **{name}**"
    if k == "add":
        return f"Add **{c['item']['label']}**"
    if k == "set_constraints":
        bits = []
        cons = c["constraints"]
        if "budget" in cons:
            bits.append(f"budget cap {usd(cons['budget']) if cons['budget'] else 'removed'}")
        if "minimumSeats" in cons:
            bits.append(f"minimum seats {cons['minimumSeats']}")
        if "clearance" in cons:
            bits.append(f"clearance {cons['clearance']} m")
        return "Set " + ", ".join(bits)
    return k


def problems(validations: list[dict]) -> list[str]:
    out = []
    for v in validations:
        if v["status"] == "fail":
            out.append(f"Fails {v['rule']}: {v['message']}")
        elif v["status"] == "unknown":
            out.append(f"Unverified {v['rule']}: {v['message']}")
    return out


def products_carousel(plan: dict, title: str) -> MetadataContent | None:
    products = by_id(plan["products"])
    cards = []
    for i in plan["items"]:
        if i["origin"] != "proposed_purchase" or not i.get("productId"):
            continue
        p = products.get(i["productId"])
        if not p:
            continue
        badges = [CarouselBadge(label=p["merchant"], variant="info")]
        if p.get("fixture"):
            badges.append(CarouselBadge(label="demo data", variant="warning"))
        elif p["availability"] == "available":
            badges.append(CarouselBadge(label="in stock when checked", variant="success"))
        dims = p.get("dimensions")
        cards.append(
            CarouselItem(
                id=p["id"][:64],
                image=p.get("imageUrl") or None,
                title=p["label"][:80],
                subtitle=usd(p.get("price")),
                secondary_text=(f"{dims[0]:.2f} x {dims[2]:.2f} m footprint" if dims else "size not established"),
                badges=badges,
                primary_cta=CtaAction(
                    label="Find a cheaper one",
                    selection={"action": "intent", "intent": f"Replace the {i['label']} with something cheaper that still fits", "itemId": i["id"]},
                ),
            )
        )
    if not cards:
        return None
    return create_card_content(CarouselCardPayload(title=title, items=cards[:10]), card_id=uuid4())


def msg(*blocks) -> ChatMessage:
    content = []
    for b in blocks:
        if b is None:
            continue
        content.append(TextContent(text=b) if isinstance(b, str) else b)
    return ChatMessage(content=content)


# ---------- turn handling ----------

GREETING = re.compile(r"^\s*(hi|hey|yo|hello|sup|start|help|what can you do)\b[\s!?.]*$", re.I)
SHOW = re.compile(r"\b(show|see|what'?s in|current)\b.*\b(room|plan)\b|^\s*(room|plan)\s*$", re.I)
CART = re.compile(r"\b(cart|checkout|check out|basket|buy it|purchase)\b", re.I)
RESET = re.compile(r"\b(reset|start over|restart)\b", re.I)
APPROVE = re.compile(r"^\s*(apply|approve|yes|yep|do it|looks good|lgtm|ship it|apply (it|that|changes))\b", re.I)
REJECT = re.compile(r"^\s*(no|nah|discard|reject|cancel|try (again|something else))\b", re.I)


def parse_selection(m: ChatMessage) -> dict | None:
    """Card clicks arrive as card MetadataContent, or as a JSON string (sometimes after @handle)."""
    for block in m.content:
        if isinstance(block, MetadataContent):
            r = extract_card_response(block)
            if r and r.selection:
                return dict(r.selection)
    raw = m.text().strip()
    if raw.startswith("@"):
        raw = raw.split(None, 1)[1] if " " in raw else ""
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
            return data if isinstance(data, dict) and "action" in data else None
        except json.JSONDecodeError:
            return None
    return None


def clean_text(m: ChatMessage) -> str:
    t = m.text().strip()
    return re.sub(r"^@\S+\s*", "", t)


async def show_room(ctx: Context, sender: str, project: str, intro: bool = False):
    data = await api("GET", f"/api/projects/{project}")
    plan, cost = data["plan"], data["cost"]
    head = ""
    if intro:
        head = (
            "Hey, I'm Tadaima. I plan furniture for a real room and only suggest things that physically fit, "
            "stay in budget and keep what you told me to keep.\n\n"
        )
    tail = (
        "\n\nTell me what you want, for example: *keep the sofa and desk, make the room $300 cheaper, "
        "and keep seating for four*. Say **cart** when you're happy, or **reset** to start over."
    )
    await ctx.send(sender, msg(head + room_summary(plan, cost) + tail, products_carousel(plan, "What you'd be buying")))


async def propose(ctx: Context, sender: str, project: str, intent: str, item_id: str | None = None):
    await ctx.send(sender, msg("On it. Checking the catalog against your room's size, budget and locked items..."))
    before = (await api("GET", f"/api/projects/{project}"))["plan"]
    p = await api("POST", f"/api/projects/{project}/proposals", {"intent": intent[:500], "selectedItemId": item_id}, timeout=90)
    ctx.storage.set(f"pending:{sender}", {"proposalId": p["id"], "rev": p["baseRevision"]})

    issues = problems(p["validations"])
    lines = [p["summary"], ""]
    if p["changes"]:
        lines += [f"{n}. {describe_change(c, before, p['result'])}" for n, c in enumerate(p["changes"], 1)]
    else:
        lines.append("No changes proposed.")
    lines += ["", f"New purchases: {usd(p['costBefore']['knownSubtotal'])} → **{usd(p['costAfter']['knownSubtotal'])}**", f"Seats: {seats(before)} → {seats(p['result'])}"]
    if issues:
        lines += ["", "Heads up:"] + [f"- {i}" for i in issues]

    can_apply = bool(p["changes"]) and not any(v["status"] == "fail" for v in p["validations"])
    if not can_apply:
        lines += ["", "I can't apply this as is. Try loosening a constraint, or tell me which item can change."]
        await ctx.send(sender, msg("\n".join(lines)))
        return

    rows = [
        ReviewSummaryRow(label="Changes", value=str(len(p["changes"]))),
        ReviewSummaryRow(label="New purchases", value=f"{usd(p['costBefore']['knownSubtotal'])} → {usd(p['costAfter']['knownSubtotal'])}"),
        ReviewSummaryRow(label="Seats", value=f"{seats(before)} → {seats(p['result'])}"),
        ReviewSummaryRow(label="Locked items", value="all kept"),
    ]
    card = ReviewCardPayload(
        title="Apply this change to your room?",
        summary_rows=rows,
        approve_cta=CtaAction(label="Apply", primary=True, selection={"action": "apply", "proposalId": p["id"], "rev": p["baseRevision"]}),
        reject_cta=CtaAction(label="Try something else", selection={"action": "discard", "proposalId": p["id"]}),
    )
    await ctx.send(sender, msg("\n".join(lines), create_card_content(card, card_id=uuid4())))


async def apply(ctx: Context, sender: str, project: str, proposal_id: str | None, rev: int | None):
    pending = ctx.storage.get(f"pending:{sender}") or {}
    proposal_id = proposal_id or pending.get("proposalId")
    rev = rev if rev is not None else pending.get("rev")
    if not proposal_id or rev is None:
        await ctx.send(sender, msg("There's nothing waiting to apply. Tell me what you'd like to change."))
        return
    r = await api("POST", f"/api/projects/{project}/proposals/{proposal_id}/apply", {"expectedRevision": int(rev)})
    ctx.storage.set(f"pending:{sender}", None)
    if r["ok"]:
        plan = r["plan"]
        cost = (await api("GET", f"/api/projects/{project}"))["cost"]
        card = ReviewCardPayload(
            title=f"Room updated to revision {plan['revision']}",
            summary_rows=[
                ReviewSummaryRow(label="New purchases", value=usd(cost["knownSubtotal"])),
                ReviewSummaryRow(label="Seats", value=str(seats(plan))),
            ],
            approve_cta=CtaAction(label="Review cart", primary=True, selection={"action": "cart"}),
            reject_cta=CtaAction(label="Keep editing", selection={"action": "room"}),
        )
        await ctx.send(sender, msg("Done, it's saved. " + cost_line(cost, plan), create_card_content(card, card_id=uuid4())))
    elif r["reason"] == "stale_revision":
        await ctx.send(sender, msg(f"The room changed since I proposed that (now revision {r['currentRevision']}), so I didn't apply it. Ask again and I'll plan against the latest version."))
    else:
        await ctx.send(sender, msg("That no longer passes the room's rules, so nothing changed:\n" + "\n".join(f"- {i}" for i in problems(r["validations"]))))


async def cart(ctx: Context, sender: str, project: str):
    data = await api("GET", f"/api/projects/{project}")
    plan, cost = data["plan"], data["cost"]
    products = by_id(plan["products"])
    lines_by_merchant: dict[str, list[str]] = {}
    for i in plan["items"]:
        if i["origin"] != "proposed_purchase" or not i.get("productId"):
            continue
        p = products.get(i["productId"])
        if not p:
            continue
        link = f"[{p['label']}]({p['sourceUrl']})"
        lines_by_merchant.setdefault(p["merchant"], []).append(f"- {link}: {usd(p.get('price'))}" + (" *(demo listing)*" if p.get("fixture") else ""))
    if not lines_by_merchant:
        await ctx.send(sender, msg("Your plan has no new purchases, so there's no cart to review."))
        return
    out = [f"**Cart review** for revision {plan['revision']}", ""]
    for merchant, lines in lines_by_merchant.items():
        out += [f"**{merchant}**"] + lines + [""]
    out.append(cost_line(cost, plan))
    out.append("\nI don't buy anything on my own. Prices and stock get rechecked before checkout, and you finish payment with the merchant.")
    await ctx.send(sender, msg("\n".join(out)))


async def handle_turn(ctx: Context, sender: str, m: ChatMessage):
    project = project_for(sender)
    started = any(isinstance(c, StartSessionContent) for c in m.content)
    if started:
        # lets ASI:One users attach room photos
        await ctx.send(sender, ChatMessage(content=[MetadataContent(metadata={"attachments": "true"})]))

    sel = parse_selection(m)
    text = clean_text(m) if sel is None else ""
    photos = [c for c in m.content if isinstance(c, ResourceContent)]

    if sel:
        action = sel.get("action")
        if action == "apply":
            return await apply(ctx, sender, project, sel.get("proposalId"), sel.get("rev"))
        if action == "discard":
            ctx.storage.set(f"pending:{sender}", None)
            return await ctx.send(sender, msg("Dropped it. What would you like instead?"))
        if action == "cart":
            return await cart(ctx, sender, project)
        if action == "room":
            return await show_room(ctx, sender, project)
        if action == "intent":
            return await propose(ctx, sender, project, str(sel.get("intent", "")), sel.get("itemId"))

    if photos:
        await ctx.send(sender, msg(
            f"Got {len(photos)} photo(s). Turning photos into a measured room runs in our reconstruction pipeline and needs you to confirm dimensions, "
            "so for this chat I'm planning on the demo living room."
        ))
        if not text:
            return await show_room(ctx, sender, project)

    if not text or GREETING.match(text):
        return await show_room(ctx, sender, project, intro=True)
    if RESET.search(text):
        await api("POST", f"/api/projects/{project}/reset")
        ctx.storage.set(f"pending:{sender}", None)
        return await show_room(ctx, sender, project)
    if APPROVE.match(text) and len(text) < 30:
        return await apply(ctx, sender, project, None, None)
    if REJECT.match(text) and len(text) < 30:
        ctx.storage.set(f"pending:{sender}", None)
        return await ctx.send(sender, msg("No problem, nothing changed. What would you like instead?"))
    if CART.search(text):
        return await cart(ctx, sender, project)
    if SHOW.search(text):
        return await show_room(ctx, sender, project)
    return await propose(ctx, sender, project, text)


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, m: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=m.msg_id))
    ctx.logger.info(f"turn from {sender[:16]}: {m.text()[:120]!r}")
    try:
        await handle_turn(ctx, sender, m)
    except Rejected as e:
        await ctx.send(sender, msg(f"That didn't go through: {e}. Nothing in your room changed."))
    except BackendError as e:
        ctx.logger.error(f"backend error: {e}")
        await ctx.send(sender, msg(f"I couldn't reach the room planner just now ({e}). Nothing in your room changed. Try that again in a moment."))
    except Exception as e:  # never leave ASI:One hanging without a reply
        ctx.logger.exception("turn failed")
        await ctx.send(sender, msg(f"Something broke on my side ({type(e).__name__}). Nothing in your room changed. Try again?"))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, m: ChatAcknowledgement):
    pass


agent.include(chat, publish_manifest=True)

if __name__ == "__main__":
    agent.run()
