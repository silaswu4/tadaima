"""
Tadaima room planner: the ASI:One / Agentverse face of the backend.

A thin Agent Chat Protocol adapter. Every turn becomes a call to the same
/api/projects routes the web app and voice agent use, so ASI:One edits the
real canonical plan, never a copy. Planning, validation and pricing all stay
in backend/plan; this file only talks and renders cards.

A paired ASI:One sender uses the website's canonical scanned room with a scoped
credential. Demo/account room creation is retained as an optional legacy flow.

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

import brain
from pairing import CURRENT_PAIRING, CONNECT, PAIRED_TOOLS, expired, paired_headers, valid_binding
import checkout
from payments import PaymentsUnavailable, StripeError, handle_chat_confirmation, on_paid, payment_protocol, request_fee
from viz import images_enabled, plan_image_url, proposal_image_url
from protocols import FitRequest, FitVerdict, ResearchRequest, fit_protocol
import scout_client
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
    FormCardPayload,
    FormField,
    FormFieldOption,
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
# the tadaima-fitcheck agent, asked about doorways and delivery
FITCHECK = os.getenv("FITCHECK_ADDRESS", "agent1qw8a0tffhe420xzu7ultv2naf8k80dkwndq79pnn2ha84v0aam906uprl6v")
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
    binding = CURRENT_PAIRING.get()
    try:
        scoped_headers = paired_headers(method, path, binding)
    except (PermissionError, ValueError) as e:
        raise Rejected(str(e)) from e
    headers = {"content-type": "application/json", **scoped_headers}
    if AGENT_API_KEY and binding is None:
        headers["x-agent-key"] = AGENT_API_KEY
    if BYPASS:
        headers["x-vercel-protection-bypass"] = BYPASS
    # one retry on network errors and 5xx; a 4xx is a real answer and is not retried
    attempts = 1 if (binding and method != "GET") or path == "/api/agent/pairings/redeem" else 2
    for attempt in range(attempts):
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
        if attempt + 1 < attempts:
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


def placed(plan: dict) -> list[dict]:
    """Items in the room. Stored pieces stay in the plan but take no space, seat nobody, and aren't bought."""
    return [i for i in plan["items"] if not i.get("stored")]


def seats(plan: dict) -> int:
    return sum(i.get("seats") or 0 for i in placed(plan))


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
    owned = [i for i in placed(plan) if i["origin"] == "existing_owned"]
    buying = [i for i in placed(plan) if i["origin"] == "proposed_purchase"]
    stored = [i for i in plan["items"] if i.get("stored")]
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
    if stored:
        lines.append("Put away: " + ", ".join(i["label"] for i in stored))
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
    if k == "store":
        return f"Put **{name}** away"
    if k == "take_out":
        return f"Bring **{name}** back out"
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
    for i in placed(plan):
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


def room_image(project: str, rev: int) -> str | None:
    return f"![your room, revision {rev}]({plan_image_url(project, rev)})" if images_enabled() and not project.startswith("proj_room_") else None


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
CHECKOUT = re.compile(r"\b(check ?out|checkout|pay|buy (it|them|everything)|place (the )?order)\b", re.I)
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
    tail = ("\n\nResearch and previews use this scanned room. Confirm changes and purchases on the website." if CURRENT_PAIRING.get() else (
        "\n\nTell me what you want, for example: *keep the sofa and desk, make the room $300 cheaper, "
        "and keep seating for four*. Say **cart** when you're happy, or **reset** to start over."
    ))
    await ctx.send(sender, msg(room_image(project, plan["revision"]), head + room_summary(plan, cost) + tail, products_carousel(plan, "What you'd be buying")))


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

    if CURRENT_PAIRING.get():
        lines += ["", "This is a proposal for your scanned room. Review it in Tadaima and apply it on the website; nothing has changed yet."]
        await ctx.send(sender, msg("\n".join(lines)))
        return p

    can_apply = bool(p["changes"]) and not any(v["status"] == "fail" for v in p["validations"])
    if not can_apply:
        lines += ["", "I can't apply this as is. Try loosening a constraint, or tell me which item can change."]
        await ctx.send(sender, msg("\n".join(lines)))
        return p

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
    diff = f"![proposed change]({proposal_image_url(project, p['id'])})" if images_enabled() else None
    await ctx.send(sender, msg(diff, "\n".join(lines), create_card_content(card, card_id=uuid4())))
    return p


async def apply(ctx: Context, sender: str, project: str, proposal_id: str | None, rev: int | None):
    pending = ctx.storage.get(f"pending:{sender}") or {}
    proposal_id = proposal_id or pending.get("proposalId")
    rev = rev if rev is not None else pending.get("rev")
    if not proposal_id or rev is None:
        await ctx.send(sender, msg("There's nothing waiting to apply. Tell me what you'd like to change."))
        return {"ok": False, "reason": "nothing_pending"}
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
            approve_cta=CtaAction(label="Check out", primary=True, selection={"action": "checkout_start"}),
            reject_cta=CtaAction(label="Keep editing", selection={"action": "room"}),
        )
        await ctx.send(sender, msg(room_image(project, plan["revision"]), "Done, it's saved. " + cost_line(cost, plan), create_card_content(card, card_id=uuid4())))
    elif r["reason"] == "stale_revision":
        await ctx.send(sender, msg(f"The room changed since I proposed that (now revision {r['currentRevision']}), so I didn't apply it. Ask again and I'll plan against the latest version."))
    else:
        await ctx.send(sender, msg("That no longer passes the room's rules, so nothing changed:\n" + "\n".join(f"- {i}" for i in problems(r["validations"]))))
    return r


async def cart(ctx: Context, sender: str, project: str):
    if CURRENT_PAIRING.get():
        data = await api("GET", "/api/agent/pairings/cart")
        await ctx.send(sender, msg(checkout.cart_text({"cart": data.get("cart", data)}), "Review and confirm purchases in Tadaima on the website. No payment is authorized in this chat."))
        return
    data = await api("GET", f"/api/projects/{project}")
    plan, cost = data["plan"], data["cost"]
    products = by_id(plan["products"])
    lines_by_merchant: dict[str, list[str]] = {}
    for i in placed(plan):
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
    out.append("\nSay **check out** when you're ready. I recheck prices and stock first, and nothing is charged until you approve the exact amount.")
    await ctx.send(sender, msg("\n".join(out)))



# ---------- tools the brain can call ----------


def compact_room(data: dict) -> str:
    plan, cost = data["plan"], data["cost"]
    products = by_id(plan["products"])
    g = plan["geometry"]
    room = g["rooms"][0] if g["rooms"] else {}
    items = []
    for i in plan["items"]:
        p = products.get(i.get("productId") or "")
        items.append({
            "id": i["id"], "label": i["label"], "category": i["category"],
            "owned": i["origin"] == "existing_owned", "price": usd(p["price"]) if p else None,
            "merchant": p["merchant"] if p else None, "size_wdh_m": i.get("dimensions"),
            "position_xz": [round(i["position"][0], 2), round(i["position"][2], 2)],
            "locked": i["locked"], "stored": bool(i.get("stored")), "seats": i.get("seats"),
        })
    return json.dumps({
        "revision": plan["revision"],
        "floor_polygon": room.get("floorPolygon"), "ceiling_m": room.get("height"),
        "walls": [{"id": w["id"], "start": w["start"], "end": w["end"]} for w in g["walls"]],
        "openings": [{"kind": o["kind"], "wall": o["wallId"], "offset_m": o["offset"], "width_m": o["width"]} for o in g.get("openings", [])],
        "items": items,
        "budget": usd(plan["constraints"].get("budget")), "minimum_seats": plan["constraints"].get("minimumSeats"),
        "seats_now": seats(plan), "new_purchases": usd(cost["knownSubtotal"]),
        "failing_rules": problems(data.get("validations", [])),
    })


async def spot_of(project: str, args: dict) -> dict:
    if args.get("near_item_id"):
        plan = (await api("GET", f"/api/projects/{project}"))["plan"]
        item = by_id(plan["items"]).get(args["near_item_id"])
        if not item:
            raise Rejected(f"no item {args['near_item_id']}")
        x, _, z = item["position"]
        return {"position": [x, 0, z]}
    if args.get("x") is None or args.get("z") is None:
        raise Rejected("say where: an item to stand in for, or x and z")
    return {"position": [float(args["x"]), 0, float(args["z"])]}


def result_card(results: list[dict], job_id: str, spot: dict, replace_item_id: str | None, title: str) -> MetadataContent | None:
    cards = []
    for r in results:
        if not r["fits"]:
            continue
        p = r["product"]
        badges = [CarouselBadge(label=p["merchant"], variant="info")]
        badges.append(CarouselBadge(label="found live" if r["source"] == "live" else "in catalog", variant="success" if r["source"] == "live" else "info"))
        if r.get("withinBudget") is False:
            badges.append(CarouselBadge(label=f"${r['overBudgetUsd']:,.0f} over budget" if r.get("overBudgetUsd") else "over budget", variant="warning"))
        d = p.get("dimensions")
        x, _, z = spot["position"]
        cards.append(CarouselItem(
            id=p["id"][:64], image=p.get("imageUrl") or None, title=p["label"][:80], subtitle=usd(p.get("price")),
            secondary_text=f"{d[0]:.2f} x {d[2]:.2f} m, fits there" if d else "fits there",
            badges=badges,
            primary_cta=CtaAction(label="Preview in room" if CURRENT_PAIRING.get() else "Swap it in" if replace_item_id else "Add to room", selection={
                "action": "place", "productId": p["id"], "jobId": job_id, "x": x, "z": z, "replaceItemId": replace_item_id,
                "projectId": (CURRENT_PAIRING.get() or {}).get("projectId"),
            }),
        ))
    if not cards:
        return None
    return create_card_content(CarouselCardPayload(title=title, items=cards[:10]), card_id=uuid4())


async def follow_live_search(ctx: Context, sender: str, project: str, job_id: str, seen: set[str], spot: dict, replace_item_id: str | None):
    """Live store search takes minutes; post what it finds into the same chat when it's done."""
    for _ in range(36):
        await asyncio.sleep(10)
        binding = CURRENT_PAIRING.get()
        if binding and (expired(binding) or conv(ctx, sender).get("pairing") != binding):
            return
        try:
            job = await api("GET", f"/api/projects/{project}/shop/{job_id}")
        except (BackendError, Rejected):
            continue
        if binding and conv(ctx, sender).get("pairing") != binding:
            return
        out = job.get("output") or {}
        if out.get("live") == "running":
            continue
        fresh = [r for r in out.get("results", []) if r["source"] == "live" and r["product"]["id"] not in seen]
        if out.get("live") == "failed" or not fresh:
            await ctx.send(sender, msg("The live store search finished without anything new that fits. The picks above are still good."))
            return
        await ctx.send(sender, msg(f"Live search came back: {sum(1 for r in fresh if r['fits'])} new pieces that fit.", result_card(fresh, job_id, spot, replace_item_id, "Just found in stores")))
        return


def tools_for(ctx: Context, sender: str, project: str) -> dict:
    async def get_room(_a):
        return compact_room(await api("GET", f"/api/projects/{project}"))

    async def show(_a):
        await show_room(ctx, sender, project)
        return "shown to the shopper"

    async def propose_change(a):
        p = await propose(ctx, sender, project, a["intent"], a.get("item_id"))
        return json.dumps({"summary": p["summary"], "changes": len(p["changes"]), "passes": not any(v["status"] == "fail" for v in p["validations"]),
                           "cost_before": usd(p["costBefore"]["knownSubtotal"]), "cost_after": usd(p["costAfter"]["knownSubtotal"]), "shown_with_apply_button": not bool(CURRENT_PAIRING.get()), "review_on_website": bool(CURRENT_PAIRING.get())})

    async def apply_proposal(_a):
        r = await apply(ctx, sender, project, None, None)
        return json.dumps({"ok": r.get("ok"), "reason": r.get("reason")})

    async def search_products(a):
        spot = await spot_of(project, a)
        body = {"category": a["category"], "spot": spot, "maxPriceUsd": a.get("max_price_usd"), "request": a.get("style"), "live": False}
        job = await api("POST", f"/api/projects/{project}/shop", body, timeout=60)
        out = job.get("output") or {}
        results = out.get("results", [])
        replace = a.get("near_item_id")
        card = result_card(results, job["id"], spot, replace, f"{a['category'].title()}s that fit")
        live = out.get("live") == "running"
        note = f"{sum(1 for r in results if r['fits'])} fit from our catalog." + (" I'm also checking stores live and will post what I find in a few minutes." if live else "")
        await ctx.send(sender, msg(note, card))
        if live:
            asyncio.create_task(follow_live_search(ctx, sender, project, job["id"], {r["product"]["id"] for r in results}, spot, replace))
        return json.dumps({"job_id": job["id"], "live_search_running": live, "results": [
            {"product_id": r["product"]["id"], "label": r["product"]["label"], "price": usd(r["product"].get("price")), "fits": r["fits"], "within_budget": r.get("withinBudget"), "problems": r["problems"][:2]}
            for r in results[:8]]})

    async def place_product(a):
        spot = await spot_of(project, {**a, "near_item_id": a.get("replace_item_id") or a.get("near_item_id")})
        return json.dumps(await place(ctx, sender, project, a["product_id"], a.get("job_id"), spot, a.get("replace_item_id")))

    async def move_item(a):
        spot = await spot_of(project, a)
        r = await api("POST", f"/api/projects/{project}/items/{a['item_id']}/move-to", {"spot": spot, "unlock": bool(a.get("unlock"))})
        await ctx.send(sender, msg(placed_text(r, "Moved it.")))
        return json.dumps({"ok": r["ok"], "reason": r.get("reason"), "message": r.get("message")})

    async def put_away(a):
        r = await api("POST", f"/api/projects/{project}/items/{a['item_id']}/store", {"unlock": bool(a.get("unlock"))})
        await ctx.send(sender, msg(placed_text(r, "Put away. It stays in your inventory, out of the room and the cart.")))
        return json.dumps({"ok": r["ok"], "reason": r.get("reason")})

    async def set_constraints(a):
        cons = {}
        if a.get("budget_usd") is not None:
            cons["budget"] = {"amountMinor": round(a["budget_usd"] * 100), "currency": "USD"}
        if a.get("minimum_seats") is not None:
            cons["minimumSeats"] = int(a["minimum_seats"])
        return json.dumps(await change(ctx, sender, project, [{"kind": "set_constraints", "constraints": cons}], "Updated."))

    async def lock_item(a):
        return json.dumps(await change(ctx, sender, project, [{"kind": "lock", "itemId": a["item_id"], "locked": bool(a["locked"])}], "Locked." if a["locked"] else "Unlocked."))

    async def hire_scout(a):
        spot = await spot_of(project, a)
        plan = (await api("GET", f"/api/projects/{project}"))["plan"]
        near = by_id(plan["items"]).get(a.get("near_item_id") or "")
        dims = (near or {}).get("dimensions")
        req = ResearchRequest(
            request_id=f"rr_{uuid4().hex[:12]}", category=a["category"], query=a.get("style") or a["category"],
            max_price_usd=a.get("max_price_usd"), max_width_m=round(dims[0] + 0.3, 2) if dims else None,
            merchants=a.get("merchants") or ["IKEA", "Target"], limit=4,
        )
        await ctx.send(sender, msg(f"Hiring the **Scout** agent to check {' and '.join(req.merchants)} live (paid per search in testnet FET). Takes about 2 to 4 minutes; I'll post what fits."))
        asyncio.create_task(scout_and_show(ctx, sender, project, req, spot, a.get("near_item_id")))
        return json.dumps({"hired": True, "request_id": req.request_id, "note": "results post to the chat when Scout finishes"})

    async def check_delivery(a):
        plan = (await api("GET", f"/api/projects/{project}"))["plan"]
        products = by_id(plan["products"])
        item = by_id(plan["items"]).get(a.get("item_id") or "")
        product = products.get(a.get("product_id") or "") or (products.get(item.get("productId") or "") if item else None)
        dims = (product or {}).get("dimensions") or (item or {}).get("dimensions")
        label = (product or item or {}).get("label", "that piece")
        if not dims:
            return json.dumps({"error": f"no size known for {label}"})
        rid = f"fit_{uuid4().hex[:12]}"
        await ctx.send(sender, msg(f"Asking the **Fit Check** agent whether {label} gets through your door..."))
        reply, _status = await ctx.send_and_receive(FITCHECK, FitRequest(
            request_id=rid, dimensions_wdh_m=list(dims), door_width_m=a.get("door_width_m"), door_height_m=a.get("door_height_m"),
            ceiling_m=(plan["geometry"]["rooms"] or [{}])[0].get("height"),
        ), response_type=FitVerdict, timeout=30)
        if not isinstance(reply, FitVerdict) or reply.request_id != rid:
            await ctx.send(sender, msg("Fit Check didn't answer in time, so I can't say for sure. Measure the narrowest doorway and I'll ask again."))
            return json.dumps({"error": "fit check timed out"})
        head = {"yes": "Yes, it should get in.", "no": "No, it won't get through as is.", "unknown": "Too close to call."}[reply.fits]
        await ctx.send(sender, msg(f"**Fit Check:** {head}\n" + "\n".join(f"- {r}" for r in reply.reasons)))
        return json.dumps({"fits": reply.fits, "reasons": reply.reasons})

    async def show_cart(_a):
        await cart(ctx, sender, project)
        return "shown to the shopper"

    tools = {
        "get_room": get_room, "show_room": show, "propose_change": propose_change, "apply_proposal": apply_proposal,
        "search_products": search_products, "place_product": place_product, "move_item": move_item, "put_away": put_away,
        "set_constraints": set_constraints, "lock_item": lock_item, "show_cart": show_cart, "check_delivery": check_delivery,
        "hire_scout": hire_scout,
    }
    return {name: fn for name, fn in tools.items() if not CURRENT_PAIRING.get() or name in PAIRED_TOOLS}


async def scout_and_show(ctx: Context, sender: str, project: str, req: ResearchRequest, spot: dict, replace_item_id: str | None):
    """Scout researches live; its finds join the room's catalog and are fit-checked at the spot before they're offered."""
    async def progress(stage: str):
        await ctx.send(sender, msg(f"Scout: {stage}"))

    try:
        result = await scout_client.hire_scout(ctx, req, on_progress=progress)
        if not result.ok or not result.products:
            return await ctx.send(sender, msg(f"Scout came back empty ({result.error or 'nothing matched'}). The catalog picks still stand."))
        await api("POST", f"/api/agent/rooms/{project}/products", {"source": "Scout agent", "products": [{
            "id": p.id, "category": p.category or req.category, "merchant": p.merchant, "label": p.label, "sourceUrl": p.source_url,
            "imageUrl": p.image_url, "priceUsd": p.price_usd, "dimensions": p.dimensions_wdh_m, "seats": p.seats,
            "availability": p.availability if p.availability in ("available", "unavailable", "unknown") else "unknown",
            "observedAt": p.observed_at or "",
        } for p in result.products]})
        job = await api("POST", f"/api/projects/{project}/shop", {"category": req.category, "spot": spot, "maxPriceUsd": req.max_price_usd, "request": req.query, "live": False})
        ids = {p.id for p in result.products}
        mine = [r for r in (job.get("output") or {}).get("results", []) if r["product"]["id"] in ids]
        fits = [r for r in mine if r["fits"]]
        links = "\n".join(f"- [{p.label}]({p.source_url}): {'$%.0f' % p.price_usd if p.price_usd else 'price unknown'}" for p in result.products)
        head = f"Scout found {len(result.products)} live; {len(fits)} fit your room there." + ("" if fits else " None fit at that spot, here they are anyway:")
        await ctx.send(sender, msg(head + "\n" + links, result_card(mine, job["id"], spot, replace_item_id, "Found live by Scout")))
    except Exception as e:  # a background task: say what happened instead of going quiet
        ctx.logger.exception("scout task failed")
        await ctx.send(sender, msg(f"Scout ran into a problem ({type(e).__name__}). The catalog picks still stand."))


def placed_text(r: dict, ok_text: str) -> str:
    if r.get("ok"):
        return ok_text
    if r.get("reason") == "stale_revision":
        return "The room changed a moment ago, so nothing moved. Try again."
    if r.get("reason") == "validation_failed":
        return "That breaks the room's rules, so nothing changed:\n" + "\n".join(f"- {i}" for i in problems(r["validations"]))
    return r.get("message") or "That didn't work, so nothing changed."


async def place(ctx: Context, sender: str, project: str, product_id: str, job_id: str | None, spot: dict, replace_item_id: str | None) -> dict:
    if CURRENT_PAIRING.get():
        if replace_item_id:
            await ctx.send(sender, msg("I can preview this new piece. Store or replace existing furniture explicitly on the website."))
        preview = await api("POST", "/api/agent/pairings/preview", {"productId": product_id, "jobId": job_id, "spot": spot})
        await ctx.send(sender, msg("Preview prepared in Tadaima. Open the website to review the fit and confirm it; the room and basket are unchanged."))
        return preview
    r = await api("POST", f"/api/projects/{project}/place", {"productId": product_id, "jobId": job_id, "spot": spot, "replaceItemId": replace_item_id})
    if r["ok"]:
        cost = (await api("GET", f"/api/projects/{project}"))["cost"]
        item = by_id(r["plan"]["items"]).get(r["itemId"], {})
        await ctx.send(sender, msg(f"Added **{item.get('label', 'it')}** to your room. " + cost_line(cost, r["plan"])))
    else:
        await ctx.send(sender, msg(placed_text(r, "")))
    return {"ok": r["ok"], "reason": r.get("reason"), "message": r.get("message")}


async def change(ctx: Context, sender: str, project: str, changes: list[dict], ok_text: str) -> dict:
    rev = (await api("GET", f"/api/projects/{project}"))["plan"]["revision"]
    r = await api("POST", f"/api/projects/{project}/changes", {"expectedRevision": rev, "changes": changes})
    await ctx.send(sender, msg(placed_text(r, ok_text)))
    return {"ok": r["ok"], "reason": r.get("reason")}


async def start_checkout(ctx: Context, sender: str, project: str):
    """Recheck live, then one Stripe payment card in chat for the real total: the furniture plus the service fee."""
    view = await checkout.get_view(api, project)
    if not view["cart"]["merchants"]:
        return await ctx.send(sender, msg("Your plan has no new purchases, so there's nothing to check out."))
    paid = next((o for o in view["orders"] if o["cartDigest"] == view["cart"]["digest"]), None)
    if paid:
        return await ctx.send(sender, msg("This exact cart is already paid for.", checkout.order_card(paid)))
    await ctx.send(sender, msg(checkout.cart_text(view) + "\n\nChecking live prices and stock with each store first..."))
    try:
        view = await api("POST", f"/api/projects/{project}/checkout/recheck", None, timeout=checkout.RECHECK_TIMEOUT)
    except Rejected as e:
        return await ctx.send(sender, msg(f"The live check didn't go through: {e}. Nothing was charged."))
    blockers = [b for b in view["blockers"] if b != "no card connected"]
    if blockers:
        return await ctx.send(sender, msg(checkout.recheck_text(view) + "\n\nI can't take payment yet:\n" + checkout.blockers_text(blockers) + "\n\nNothing was charged."))
    await ctx.send(sender, msg(checkout.recheck_text(view)))
    try:
        await request_fee(ctx, sender, project, cart=view["cart"])
    except (PaymentsUnavailable, StripeError) as e:
        ctx.logger.error(f"chat payment unavailable: {e}")
        await checkout.finish_review(ctx, sender, project, view)


@on_paid
async def _paid(ctx: Context, sender: str, project_id: str, paid: dict):
    if not paid.get("cartDigest"):
        return await checkout.start_checkout(ctx, sender, project_id, api)
    try:
        order = await api("POST", f"/api/agent/rooms/{project_id}/orders", {"sessionId": paid["sessionId"]})
    except Rejected as e:
        return await ctx.send(sender, msg(f"Stripe took the test payment but I couldn't record the order: {e}."))
    await ctx.send(sender, msg(checkout.order_text(order), checkout.order_card(order)))


async def think(ctx: Context, sender: str, project: str, text: str):
    if brain.client is None and not os.getenv("ANTHROPIC_API_KEY"):
        return await ctx.send(sender, msg("Your room is connected. Free-form requests need ANTHROPIC_API_KEY configured in the Fetch agent process. You can still say **room** or **cart**."))
    key = f"hist:{sender}:{project}"
    reply, history = await brain.run_turn(ctx.storage.get(key) or [], text, tools_for(ctx, sender, project), ctx.logger.error, paired=bool(CURRENT_PAIRING.get()))
    ctx.storage.set(key, history)
    if reply:
        await ctx.send(sender, msg(reply))


# ---------- onboarding ----------

STYLES = ["No preference", "Warm minimal", "Scandinavian", "Japandi", "Mid-century", "Industrial", "Cozy maximal"]
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
MY_ROOMS = re.compile(r"\b(my rooms|my room|rooms|switch room)\b", re.I)
NEW_ROOM = re.compile(r"\b(new room|add (a )?room|another room)\b", re.I)
DEMO = re.compile(r"^\s*(skip|demo|use (the )?demo)\b", re.I)


def form_card(title: str, fields: list[dict], submit_label: str, action: str) -> MetadataContent:
    """Strict uagents-core form schema only: ASI:One silently drops a card with fields it doesn't accept (defaults, min/max)."""
    payload = FormCardPayload(
        title=title,
        fields=[FormField(**{**f, "options": [FormFieldOption(**o) for o in f["options"]] if f.get("options") else None}) for f in fields],
        submit_cta=CtaAction(label=submit_label, primary=True, selection={"action": action}),
    )
    return create_card_content(payload, card_id=uuid4())


async def account(sender: str) -> dict:
    return await api("GET", f"/api/agent/users?sender={sender}")


async def onboard_start(ctx: Context, sender: str):
    if os.getenv("FETCH_ENABLE_LEGACY_ONBOARDING") != "1":
        return await ctx.send(sender, msg("Open your scanned room in Tadaima, choose Connect Fetch, then send **connect CODE** here. I will use that exact room for product research and previews. Changes and payments stay under your control on the website. You can also say **demo** for a separate synthetic room."))
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


def public_url(path: str) -> str | None:
    base = os.getenv("PUBLIC_URL") or ""
    return base.rstrip("/") + path if base.startswith("https://") else None


async def demo_rooms_card() -> MetadataContent | None:
    try:
        templates = (await api("GET", "/api/agent/rooms"))["templates"]
    except (BackendError, Rejected):
        return None
    items = [
        CarouselItem(
            id=t["slug"], image=public_url(f"/rooms/renders/{t['slug']}.jpg"), title=t["label"],
            subtitle=f"{t['widthM']:.1f} x {t['depthM']:.1f} m", secondary_text=f"{t['itemCount']} pieces already in it",
            primary_cta=CtaAction(label="Use this room", primary=True, selection={"action": "demo_room", "slug": t["slug"]}),
        )
        for t in templates
    ]
    return create_card_content(CarouselCardPayload(title="Or try a demo room", items=items[:10]), card_id=uuid4()) if items else None


async def ask_address(ctx: Context, sender: str, lead: str):
    await ctx.send(sender, msg(
        lead + " Type your address and I'll pull up its floor plan, or pick one of our demo rooms below to try things out.",
        form_card("Your place", [
            {"name": "address", "kind": "text", "label": "Street address", "required": True, "placeholder": "1234 Westwood Blvd, Los Angeles, CA"},
            {"name": "unit", "kind": "text", "label": "Unit (optional)", "placeholder": "4B"},
        ], "Find my room", "address"),
    ))
    card = await demo_rooms_card()
    if card:
        await ctx.send(sender, msg(card))


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
        fields.append({"name": f"lack_{i['id']}", "kind": "checkbox", "label": f"I don't have a {i['category']}{size}, buy me one"})
    return fields


def setup_form(plan: dict) -> MetadataContent:
    budget = plan["constraints"].get("budget")
    return form_card("Set up this room", owned_fields(plan) + [
            {"name": "budget", "kind": "number", "label": "Budget for new furniture (USD)", "placeholder": str(round(budget["amountMinor"] / 100) if budget else 1500)},
            {"name": "seats", "kind": "number", "label": "People it should seat", "placeholder": str(plan["constraints"].get("minimumSeats") or 4)},
            {"name": "style", "kind": "select", "label": "Style", "options": [{"value": s, "label": s} for s in STYLES]},
        ], "Save my room", "confirm")


async def onboard_address(ctx: Context, sender: str, sel: dict | None, text: str):
    template = (sel or {}).get("slug") if (sel or {}).get("action") == "demo_room" else None
    address = "Demo room" if template else ((sel or {}).get("address") or text or "").strip()
    unit = None if template else ((sel or {}).get("unit") or "").strip() or None
    if len(address) < 3:
        return await ctx.send(sender, msg("What's the street address? A unit number helps too. Or pick a demo room."))
    created = await api("POST", "/api/agent/rooms", {"sender": sender, "address": address, "unit": unit, "template": template})
    room, plan = created["room"], created["plan"]
    set_conv(ctx, sender, step="confirm", projectId=room["projectId"], template=template)
    if template:
        render = public_url(f"/rooms/renders/{template}.jpg")
        walk = public_url(f"/rooms/{template}")
        intro = (f"![{room['label']}]({render})\n\n" if render else "") + f"Here's the **{room['label']}**{room_size(plan)}." + (f" [Walk it in 3D]({walk})." if walk else "")
        return await ctx.send(sender, msg(intro + "\n\nTell me what's yours and what you're working with.", setup_form(plan)))
    budget = plan["constraints"].get("budget")
    where = address + (f", unit {unit}" if unit else "")
    openings = plan["geometry"].get("openings", [])
    doors = sum(1 for o in openings if o["kind"] == "door")
    windows = sum(1 for o in openings if o["kind"] == "window")
    await ctx.send(sender, msg(
        f"Here's the {room['label'].lower()} at **{where}**{room_size(plan)}, {plan['geometry']['rooms'][0]['height']:.1f} m ceilings, "
        f"{doors} door(s) and {windows} window(s).\n\nTell me what you already own and what you're working with.",
        setup_form(plan),
    ))


async def onboard_confirm(ctx: Context, sender: str, sel: dict | None, text: str):
    project = conv(ctx, sender)["projectId"]
    plan = (await api("GET", f"/api/projects/{project}"))["plan"]
    sel = sel or {}
    if not sel and not APPROVE.match(text or ""):
        return await ctx.send(sender, msg("Here's the room form again. Fill it in, or say **looks good** to keep the defaults.", setup_form(plan)))
    owned = [i["id"] for i in plan["items"] if i["origin"] == "existing_owned" and sel.get(f"lack_{i['id']}") not in (True, "true", "on", 1)]

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


async def _handle_turn(ctx: Context, sender: str, m: ChatMessage):
    started = any(isinstance(c, StartSessionContent) for c in m.content)
    if started:
        # lets ASI:One users attach room photos
        await ctx.send(sender, ChatMessage(content=[MetadataContent(metadata={"attachments": "true"})]))

    sel = parse_selection(m)
    text = clean_text(m) if sel is None else ""
    if sel and not CURRENT_PAIRING.get() and await handle_chat_confirmation(ctx, sender, sel):
        return
    photos = [c for c in m.content if isinstance(c, ResourceContent)]
    action = (sel or {}).get("action")
    step = conv(ctx, sender)["step"]

    # Paired rooms never enter legacy account, reset, apply or payment routes.
    if CURRENT_PAIRING.get():
        project = project_for(ctx, sender)
        if action == "place":
            if sel.get("projectId") != project:
                return await ctx.send(sender, msg("That product card belongs to another room connection. Search again in the current room before previewing it."))
            spot = {"position": [float(sel["x"]), 0, float(sel["z"])]}
            return await place(ctx, sender, project, str(sel["productId"]), sel.get("jobId"), spot, sel.get("replaceItemId"))
        if action in {"apply", "checkout_start", *checkout.CHECKOUT_ACTIONS} or RESET.search(text) or CHECKOUT.search(text):
            return await ctx.send(sender, msg("Review and confirm changes and payments in Tadaima on the website. This chat cannot approve or pay for your scanned room."))
        if action == "cart" or CART.search(text):
            return await cart(ctx, sender, project)
        if action == "intent":
            return await propose(ctx, sender, project, str(sel.get("intent", "")), sel.get("itemId"))
        if action == "discard":
            ctx.storage.set(f"pending:{sender}", None)
            return await ctx.send(sender, msg("You can dismiss the proposal on the website. Tell me what to try instead."))
        if photos:
            return await ctx.send(sender, msg("Your scanned room is already connected. Keep photos and scan files in Tadaima; tell me what furniture to find."))
        if action == "room" or not text or GREETING.match(text) or SHOW.search(text) or MY_ROOMS.search(text):
            return await show_room(ctx, sender, project)
        return await think(ctx, sender, project, text)

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
        if action == "checkout_start":
            return await start_checkout(ctx, sender, project)
        if await checkout.handle_selection(ctx, sender, project, sel, api):
            return
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
        if action == "place":
            spot = {"position": [float(sel["x"]), 0, float(sel["z"])]}
            return await place(ctx, sender, project, str(sel["productId"]), sel.get("jobId"), spot, sel.get("replaceItemId"))

    if photos and not text:
        return await ctx.send(sender, msg("Got the photo(s). Tell me what you'd like to change in the room."))
    if not text or GREETING.match(text):
        return await show_room(ctx, sender, project)
    if RESET.search(text):
        await api("POST", f"/api/projects/{project}/reset")
        ctx.storage.set(f"pending:{sender}", None)
        return await show_room(ctx, sender, project)
    if APPROVE.match(text) and len(text) < 30 and (ctx.storage.get(f"pending:{sender}") or {}).get("proposalId"):
        return await apply(ctx, sender, project, None, None)
    if CHECKOUT.search(text):
        return await start_checkout(ctx, sender, project)
    return await think(ctx, sender, project, text)


async def handle_turn(ctx: Context, sender: str, m: ChatMessage):
    text = clean_text(m)
    match = CONNECT.fullmatch(text)
    if match:
        # No browser cookie, agent global secret or raw scan is transferred.
        result = await api("POST", "/api/agent/pairings/redeem", {"code": match.group(1), "sender": sender})
        binding = valid_binding(result)
        set_conv(ctx, sender, step="ready", projectId=binding["projectId"], pairing=binding)
        ctx.storage.set(f"pending:{sender}", None)
        await ctx.send(sender, msg("Connected to your scanned room. I can research furniture, prepare previews and propose changes. Review and confirm them in Tadaima on the website. Say **disconnect** to stop using this room in chat."))
        token = CURRENT_PAIRING.set(binding)
        try:
            return await show_room(ctx, sender, binding["projectId"])
        finally:
            CURRENT_PAIRING.reset(token)
    if text.lower() == "disconnect":
        set_conv(ctx, sender, step="new", projectId=None, pairing=None)
        ctx.storage.set(f"pending:{sender}", None)
        return await ctx.send(sender, msg("Disconnected in this chat. Revoke the connection in Tadaima to invalidate the credential on the server."))
    binding = conv(ctx, sender).get("pairing")
    if binding and expired(binding):
        set_conv(ctx, sender, step="new", projectId=None, pairing=None)
        return await ctx.send(sender, msg("Your room connection expired. Create a new code in Tadaima and send **connect CODE**."))
    token = CURRENT_PAIRING.set(binding)
    try:
        return await _handle_turn(ctx, sender, m)
    finally:
        CURRENT_PAIRING.reset(token)


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, m: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=m.msg_id))
    ctx.logger.info(f"turn from {sender[:16]}")
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
agent.include(payment_protocol, publish_manifest=True)
agent.include(fit_protocol)
scout_client.attach(agent)

if __name__ == "__main__":
    agent.run()
