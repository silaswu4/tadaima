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
# Shared secret for /api/agent/* (acts on behalf of a sender). Matches AGENT_API_KEY on the backend.
AGENT_API_KEY = os.getenv("AGENT_API_KEY")
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
    if AGENT_API_KEY:
        headers["x-agent-key"] = AGENT_API_KEY
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


def demo_project_for(sender: str) -> str:
    return "proj_demo_" + hashlib.sha256(sender.encode()).hexdigest()[:16]


# ---------- conversation state ----------
# step: new → profile → address → confirm → ready. projectId is the active room.


def conv(ctx: Context, sender: str) -> dict:
    return ctx.storage.get(f"conv:{sender}") or {"step": "new", "projectId": None}


def set_conv(ctx: Context, sender: str, **fields) -> dict:
    state = {**conv(ctx, sender), **fields}
    ctx.storage.set(f"conv:{sender}", state)
    return state


def project_for(ctx: Context, sender: str) -> str:
    return conv(ctx, sender).get("projectId") or demo_project_for(sender)


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
    lines = [f"**Your room** (revision {plan['revision']}{room_size(plan)})", ""]
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
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def clean_text(m: ChatMessage) -> str:
    t = m.text().strip()
    return re.sub(r"^@\S+\s*", "", t)


async def show_room(ctx: Context, sender: str, project: str, intro: bool = False):
    """intro is for the shared demo room (onboarding skipped)."""
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


# ---------- onboarding ----------

STYLES = ["No preference", "Warm minimal", "Scandinavian", "Japandi", "Mid-century", "Industrial", "Cozy maximal"]
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
MY_ROOMS = re.compile(r"\b(my rooms|my room|rooms|switch room)\b", re.I)
NEW_ROOM = re.compile(r"\b(new room|add (a )?room|another room)\b", re.I)
DEMO = re.compile(r"^\s*(skip|demo|use (the )?demo)\b", re.I)


def form_card(title: str, fields: list[dict], submit_label: str, action: str) -> MetadataContent:
    """Form cards are hand-built so fields can carry defaults (the live client supports them)."""
    payload = {"title": title, "fields": fields, "submit_cta": {"label": submit_label, "primary": True, "selection": {"action": action}}}
    return MetadataContent(metadata={
        "card_protocol_version": "1",
        "requires_card_interaction": "true",
        "card_kind": "form",
        "card_payload": json.dumps(payload),
        "card_id": str(uuid4()),
    })


async def account(sender: str) -> dict:
    return await api("GET", f"/api/agent/users?sender={sender}")


async def onboard_start(ctx: Context, sender: str):
    acct = await account(sender)
    user, rooms = acct["user"], acct["rooms"]
    if user and rooms:
        latest = rooms[-1]
        set_conv(ctx, sender, step="ready", projectId=latest["projectId"])
        await ctx.send(sender, msg(f"Welcome back, {user['name']}."))
        return await rooms_carousel(ctx, sender, rooms)
    if user:
        set_conv(ctx, sender, step="address")
        return await ask_address(ctx, sender, f"Welcome back, {user['name']}. Let's add your first room.")
    set_conv(ctx, sender, step="profile")
    await ctx.send(sender, msg(
        "Hey, I'm Tadaima. I furnish your actual room with real products that fit it, stay in your budget, "
        "and keep the stuff you already own.\n\nFirst, let's set up your Tadaima account.",
        form_card("Create your Tadaima account", [
            {"name": "name", "kind": "text", "label": "Your name", "required": True, "placeholder": "Alex"},
            {"name": "email", "kind": "email", "label": "Email", "required": True, "placeholder": "you@example.com"},
        ], "Create account", "profile"),
    ))


async def ask_address(ctx: Context, sender: str, lead: str):
    await ctx.send(sender, msg(
        lead + " Where's the place? I'll pull up its floor plan.",
        form_card("Your place", [
            {"name": "address", "kind": "text", "label": "Street address", "required": True, "placeholder": "1234 Westwood Blvd, Los Angeles, CA"},
            {"name": "unit", "kind": "text", "label": "Unit (optional)", "placeholder": "4B"},
        ], "Find my room", "address"),
    ))


async def onboard_profile(ctx: Context, sender: str, sel: dict | None, text: str):
    name, email = (sel or {}).get("name"), (sel or {}).get("email")
    if not email and text:
        found = EMAIL.search(text)
        if found:
            email = found.group(0)
            name = name or re.sub(r"\b(my name is|i'?m|name|email|is|,|and)\b", " ", text.replace(email, ""), flags=re.I).strip() or None
    if not (name and email):
        return await ctx.send(sender, msg("I need your name and an email to make the account. Fill in the form, or just type them, like *Alex, alex@example.com*."))
    user = await api("POST", "/api/agent/users", {"sender": sender, "name": str(name).strip(), "email": str(email).strip()})
    set_conv(ctx, sender, step="address")
    await ask_address(ctx, sender, f"You're set up, {user['name']}. Your account is tied to this ASI:One chat identity.")


def owned_fields(plan: dict) -> list[dict]:
    fields = []
    for i in plan["items"]:
        if i["origin"] != "existing_owned":
            continue
        d = i.get("dimensions")
        size = f" ({d[0]:.2f} x {d[2]:.2f} m)" if d else ""
        fields.append({"name": f"own_{i['id']}", "kind": "checkbox", "label": f"I already own a {i['category']}{size}", "default": True})
    return fields


async def onboard_address(ctx: Context, sender: str, sel: dict | None, text: str):
    address = ((sel or {}).get("address") or text or "").strip()
    unit = ((sel or {}).get("unit") or "").strip() or None
    if len(address) < 3:
        return await ctx.send(sender, msg("What's the street address? A unit number helps too."))
    created = await api("POST", "/api/agent/rooms", {"sender": sender, "address": address, "unit": unit})
    room, plan = created["room"], created["plan"]
    set_conv(ctx, sender, step="confirm", projectId=room["projectId"])
    budget = plan["constraints"].get("budget")
    where = address + (f", unit {unit}" if unit else "")
    openings = plan["geometry"].get("openings", [])
    doors = sum(1 for o in openings if o["kind"] == "door")
    windows = sum(1 for o in openings if o["kind"] == "window")
    await ctx.send(sender, msg(
        f"Here's the {room['label'].lower()} at **{where}**{room_size(plan)}, {plan['geometry']['rooms'][0]['height']:.1f} m ceilings, "
        f"{doors} door(s) and {windows} window(s).\n\nTell me what you already own and what you're working with.",
        form_card("Set up this room", owned_fields(plan) + [
            {"name": "budget", "kind": "number", "label": "Budget for new furniture (USD)", "default": round(budget["amountMinor"] / 100) if budget else 1500, "minimum": 50},
            {"name": "seats", "kind": "number", "label": "People it should seat", "default": plan["constraints"].get("minimumSeats") or 4, "minimum": 0, "maximum": 12},
            {"name": "style", "kind": "select", "label": "Style", "options": [{"value": s, "label": s} for s in STYLES], "default": STYLES[0]},
        ], "Save my room", "confirm"),
    ))


async def onboard_confirm(ctx: Context, sender: str, sel: dict | None, text: str):
    project = conv(ctx, sender)["projectId"]
    plan = (await api("GET", f"/api/projects/{project}"))["plan"]
    sel = sel or {}
    if not sel and not APPROVE.match(text or ""):
        return await ctx.send(sender, msg("Fill in the room form, or say **looks good** to keep the defaults."))
    owned = [i["id"] for i in plan["items"] if i["origin"] == "existing_owned" and sel.get(f"own_{i['id']}", True) not in (False, "false", "off", 0)]

    def num(key):
        try:
            return float(sel[key]) if sel.get(key) not in (None, "") else None
        except (TypeError, ValueError):
            return None

    style = sel.get("style") if sel.get("style") and sel.get("style") != STYLES[0] else None
    seats_wanted = num("seats")
    saved = await api("POST", f"/api/agent/rooms/{project}/confirm", {
        "sender": sender,
        "ownedItemIds": owned,
        "budgetUsd": num("budget"),
        "minimumSeats": int(seats_wanted) if seats_wanted is not None else None,
        "style": style,
    })
    set_conv(ctx, sender, step="ready")
    await ctx.send(sender, msg("Saved to your account.\n\n" + room_summary(saved["plan"], saved["cost"]), products_carousel(saved["plan"], "Starting picks for your room")))
    issues = problems(saved["validations"])
    if style or issues:
        goal = f"Restyle the room as {style}. " if style else ""
        await propose(ctx, sender, project, goal + "Make the plan pass every rule: stay within the budget, seat enough people, keep what I own.")
    else:
        await ctx.send(sender, msg("Tell me what you'd change, like *make it $300 cheaper* or *find a bigger rug*. Say **cart** when you're happy."))


async def rooms_carousel(ctx: Context, sender: str, rooms: list[dict] | None = None):
    rooms = rooms if rooms is not None else (await account(sender))["rooms"]
    if not rooms:
        set_conv(ctx, sender, step="address")
        return await ask_address(ctx, sender, "You don't have any rooms yet.")
    active = conv(ctx, sender).get("projectId")
    items = [
        CarouselItem(
            id=r["projectId"],
            title=r["label"],
            subtitle=r["address"] + (f", unit {r['unit']}" if r.get("unit") else ""),
            secondary_text=f"revision {r['revision']}, {usd(r['cost']['knownSubtotal'])} planned" + (", setup unfinished" if r["status"] == "draft" else ""),
            badges=[CarouselBadge(label="open now", variant="success")] if r["projectId"] == active else None,
            primary_cta=CtaAction(label="Open", selection={"action": "open_room", "projectId": r["projectId"]}),
        )
        for r in rooms[-10:]
    ]
    await ctx.send(sender, msg("Your rooms. Open one, or say **new room**.", create_card_content(CarouselCardPayload(title="Your rooms", items=items), card_id=uuid4())))


async def open_room(ctx: Context, sender: str, project_id: str):
    rooms = (await account(sender))["rooms"]
    room = next((r for r in rooms if r["projectId"] == project_id), None)
    if not room:
        return await ctx.send(sender, msg("That room isn't on your account."))
    set_conv(ctx, sender, step="confirm" if room["status"] == "draft" else "ready", projectId=project_id)
    ctx.storage.set(f"pending:{sender}", None)
    if room["status"] == "draft":
        return await onboard_address(ctx, sender, {"address": room["address"], "unit": room.get("unit")}, "")
    await show_room(ctx, sender, project_id)


async def handle_turn(ctx: Context, sender: str, m: ChatMessage):
    started = any(isinstance(c, StartSessionContent) for c in m.content)
    if started:
        # lets ASI:One users attach room photos
        await ctx.send(sender, ChatMessage(content=[MetadataContent(metadata={"attachments": "true"})]))

    sel = parse_selection(m)
    text = clean_text(m) if sel is None else ""
    photos = [c for c in m.content if isinstance(c, ResourceContent)]
    action = (sel or {}).get("action")
    step = conv(ctx, sender)["step"]

    # anywhere in the conversation
    if action == "open_room":
        return await open_room(ctx, sender, str(sel.get("projectId")))
    if MY_ROOMS.search(text) and step == "ready":
        return await rooms_carousel(ctx, sender)
    if NEW_ROOM.search(text) and step == "ready":
        set_conv(ctx, sender, step="address")
        return await ask_address(ctx, sender, "New room.")
    if DEMO.match(text) and step != "ready":
        set_conv(ctx, sender, step="ready", projectId=None)
        return await show_room(ctx, sender, project_for(ctx, sender), intro=True)

    # onboarding steps; form values are routed by step even when the card's action is missing
    if step == "new":
        return await onboard_start(ctx, sender)
    if step == "profile":
        return await onboard_profile(ctx, sender, sel, text)
    if step == "address":
        if photos:
            return await ctx.send(sender, msg("Got your photos. Type the address too, and I'll match them to the floor plan."))
        return await onboard_address(ctx, sender, sel, text)
    if step == "confirm":
        return await onboard_confirm(ctx, sender, sel, text)

    project = project_for(ctx, sender)
    if sel:
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

    if photos and not text:
        return await ctx.send(sender, msg("Got the photo(s). Tell me what you'd like to change in the room."))
    if not text or GREETING.match(text):
        return await show_room(ctx, sender, project)
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
