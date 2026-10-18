"""
Scout: live furniture research for people and for other agents.

Two faces on one agent:
- Chat (Agent Chat Protocol): a person in ASI:One types what they want or
  pastes a product link. Claude turns it into a research request, Scout runs
  it live on the stores and posts progress, then a carousel of results. Free,
  capped per sender per day.
- Agents (TadaimaResearch in ../protocols.py): another agent sends a
  ResearchRequest, pays a small testnet FET fee through the Payment Protocol,
  and gets ResearchProgress messages and one ResearchResult back. Buyer side:
  ../scout_client.py.

The browsing itself is the backend's /api/agent/research job (Browser Use,
one run per merchant in parallel). This file only talks, charges and polls.

Run: see README.md in this folder.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from uuid import uuid4

import aiohttp
from anthropic import AsyncAnthropic

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from protocols import Product, ResearchProgress, ResearchRequest, ResearchResult, research_protocol  # noqa: E402
from uagents import Agent, Context, Protocol  # noqa: E402
from uagents_core.contrib.protocols.chat import (  # noqa: E402
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    MetadataContent,
    TextContent,
    chat_protocol_spec,
)
from uagents_core.contrib.protocols.chat.cards import (  # noqa: E402
    CarouselBadge,
    CarouselCardPayload,
    CarouselItem,
    CtaAction,
    create_card_content,
    extract_card_response,
)
from uagents_core.contrib.protocols.payment import (  # noqa: E402
    CancelPayment,
    CommitPayment,
    CompletePayment,
    Funds,
    RejectPayment,
    RequestPayment,
    payment_protocol_spec,
)

BACKEND = os.getenv("BACKEND_URL", "http://localhost:3000").rstrip("/")
BYPASS = os.getenv("VERCEL_PROTECTION_BYPASS")
AGENT_API_KEY = os.getenv("AGENT_API_KEY")
PRICE_FET = float(os.getenv("SCOUT_PRICE_FET", "0.05"))
DENOM = "atestfet"
FREE_AGENTS = {a.strip() for a in os.getenv("SCOUT_FREE_AGENTS", "").split(",") if a.strip()}
HUMAN_RUNS_PER_DAY = int(os.getenv("SCOUT_HUMAN_RUNS_PER_DAY", "5"))
# results per store in chat; unset picks 3 or 4 by how many stores
CHAT_LIMIT = int(os.getenv("SCOUT_CHAT_LIMIT", "0"))
LEDGER_REST = os.getenv("SCOUT_LEDGER_REST", "https://rest-dorado.fetch.ai")
PAY_DEADLINE_S = 5 * 60
POLL_S = 8
JOB_WAIT_S = 8 * 60

agent = Agent(
    name="tadaima-scout",
    seed=os.environ["SCOUT_SEED"],
    port=int(os.getenv("SCOUT_PORT", "8002")),
    mailbox=True,
    publish_agent_details=True,
    readme_path=os.path.join(HERE, "README.md"),
    handle_messages_concurrently=True,
)
WALLET = str(agent.wallet.address())

chat = Protocol(spec=chat_protocol_spec)
seller = Protocol(spec=payment_protocol_spec, role="seller")
claude = AsyncAnthropic()


# ---------- backend ----------


class BackendError(Exception):
    pass


async def api(method: str, path: str, body: dict | None = None, timeout: float = 30) -> dict:
    headers = {"content-type": "application/json"}
    if AGENT_API_KEY:
        headers["x-agent-key"] = AGENT_API_KEY
    if BYPASS:
        headers["x-vercel-protection-bypass"] = BYPASS
    err: Exception = BackendError("no attempt")
    for attempt in range(2):
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as http:
                async with http.request(method, f"{BACKEND}{path}", json=body, headers=headers) as res:
                    data = await res.json(content_type=None)
                    if res.status < 400:
                        return data
                    msg_ = (data or {}).get("error", f"backend {res.status}")
                    if res.status < 500:
                        raise ValueError(msg_)
                    err = BackendError(msg_)
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            err = BackendError(type(e).__name__)
        if attempt == 0:
            await asyncio.sleep(1.5)
    raise err


def request_body(r: ResearchRequest) -> dict:
    return {
        "category": r.category,
        "query": r.query,
        "maxPriceUsd": r.max_price_usd,
        "maxWidthM": r.max_width_m,
        "maxDepthM": r.max_depth_m,
        "merchants": r.merchants or ["IKEA", "Target"],
        "limit": max(1, min(8, r.limit or 5)),
        "productUrl": r.product_url,
    }


async def run_job(r: ResearchRequest, on_stage) -> dict:
    """Start the backend job and follow it to the end. Returns the finished job."""
    job = await api("POST", "/api/agent/research", request_body(r))
    last = None
    deadline = time.time() + JOB_WAIT_S
    while True:
        if job.get("stage") and job["stage"] != last:
            last = job["stage"]
            await on_stage(last)
        if job["state"] in ("succeeded", "failed", "cancelled") or time.time() > deadline:
            return job
        await asyncio.sleep(POLL_S)
        try:
            job = await api("GET", f"/api/agent/research/{job['id']}")
        except BackendError:
            continue


def to_product(p: dict) -> Product:
    price = p.get("price")
    return Product(
        id=p["id"],
        merchant=p["merchant"],
        label=p["label"],
        source_url=p["sourceUrl"],
        image_url=p.get("imageUrl"),
        category=p.get("category"),
        price_usd=price["amountMinor"] / 100 if price else None,
        dimensions_wdh_m=p.get("dimensions"),
        seats=p.get("seats"),
        availability=p.get("availability", "unknown"),
        observed_at=p.get("observedAt"),
    )


# ---------- formatting ----------


def usd(v: float | None) -> str:
    return f"${v:,.0f}" if v is not None else "price not listed"


def size(d: list[float] | None) -> str:
    return f"{d[0]:.2f} W x {d[2]:.2f} D x {d[1]:.2f} H m" if d else "size not listed"


def msg(*blocks) -> ChatMessage:
    return ChatMessage(content=[TextContent(text=b) if isinstance(b, str) else b for b in blocks if b is not None])


def merchant_list(ms: list[str]) -> str:
    return ms[0] if len(ms) == 1 else ", ".join(ms[:-1]) + " and " + ms[-1]


def results_card(products: list[Product], title: str) -> MetadataContent | None:
    items = []
    for p in products[:10]:
        badges = [CarouselBadge(label=p.merchant, variant="info")]
        if p.availability == "available":
            badges.append(CarouselBadge(label="in stock when checked", variant="success"))
        elif p.availability == "unavailable":
            badges.append(CarouselBadge(label="out of stock", variant="warning"))
        items.append(CarouselItem(
            id=p.id[:64],
            image=p.image_url or None,
            title=p.label[:80],
            subtitle=usd(p.price_usd),
            secondary_text=size(p.dimensions_wdh_m),
            badges=badges,
            # cards can't link out, so a tap answers with the product link
            primary_cta=CtaAction(label="Open product", selection={"action": "open", "url": p.source_url, "title": p.label[:80]}, primary=True),
        ))
    if not items:
        return None
    return create_card_content(CarouselCardPayload(title=title, items=items), card_id=uuid4())


def results_text(products: list[Product]) -> str:
    lines = [f"- [{p.label}]({p.source_url}): {usd(p.price_usd)}, {size(p.dimensions_wdh_m)} ({p.merchant})" for p in products[:10]]
    return "\n".join(lines)


# ---------- chat: understanding the ask ----------

URL = re.compile(r"https?://[^\s)>\]]+")
GREETING = re.compile(r"^\s*(hi|hey|yo|hello|sup|start|help|what can you do)\b[\s!?.]*$", re.I)
CATEGORIES = ["sofa", "chair", "table", "desk", "storage", "bed", "rug", "lamp", "decor", "other"]
MERCHANTS = ["IKEA", "Target", "Walmart", "Article", "West Elm"]

INTRO = (
    "Hi, I'm Scout. I look up furniture live on IKEA, Target, Walmart, Article and West Elm, "
    "and come back with real prices and measured sizes.\n\n"
    "Try something like **green velvet sofa under $900, max 2.2 m wide, IKEA or Target**, "
    "or paste a product link and I'll read its size and price."
)

PARSE_SYSTEM = """You turn a shopper's furniture request into a search for a live store browser. Return JSON only.
- category: one of sofa, chair, table, desk, storage, bed, rug, lamp, decor, other; null if you can't tell what kind of furniture they want.
- query: short store search text with the item type plus style, color or material words ("green velvet sofa"). No prices or sizes.
- max_price_usd: their price cap in USD, or null.
- max_width_m / max_depth_m: size caps converted to meters (1 in = 0.0254 m, 1 ft = 0.3048 m, 1 cm = 0.01 m), or null. "wide" is width, "deep" is depth; a single "max 2 m" for a sofa or table is width.
- merchants: stores they named, from IKEA, Target, Walmart, Article, West Elm. Empty if they didn't name any.
- question: null normally. If category is null, one short, plain question asking what piece they want. No em dashes, no exclamation marks."""

PARSE_SCHEMA = {
    "type": "object",
    "properties": {
        "category": {"anyOf": [{"type": "string", "enum": CATEGORIES}, {"type": "null"}]},
        "query": {"type": "string"},
        "max_price_usd": {"type": ["number", "null"]},
        "max_width_m": {"type": ["number", "null"]},
        "max_depth_m": {"type": ["number", "null"]},
        "merchants": {"type": "array", "items": {"type": "string", "enum": MERCHANTS}},
        "question": {"type": ["string", "null"]},
    },
    "required": ["category", "query", "max_price_usd", "max_width_m", "max_depth_m", "merchants", "question"],
    "additionalProperties": False,
}


async def parse_ask(text: str) -> dict:
    res = await claude.beta.messages.create(
        model="claude-opus-5-5",
        max_tokens=600,
        system=PARSE_SYSTEM,
        messages=[{"role": "user", "content": text}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": PARSE_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    raw = "".join(b.text for b in res.content if b.type == "text")
    return json.loads(raw)


def merchant_of(url: str) -> str | None:
    host = re.sub(r"^https?://(www\.)?", "", url).split("/")[0].lower()
    for m, domain in {"IKEA": "ikea.com", "Target": "target.com", "Walmart": "walmart.com", "Article": "article.com", "West Elm": "westelm.com"}.items():
        if host == domain or host.endswith("." + domain):
            return m
    return None


# ---------- chat: turns ----------


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def runs_today(ctx: Context, sender: str) -> int:
    return int(ctx.storage.get(f"runs:{sender}:{today()}") or 0)


def parse_selection(m: ChatMessage) -> dict | None:
    for block in m.content:
        if isinstance(block, MetadataContent):
            r = extract_card_response(block)
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


async def follow_chat_job(ctx: Context, sender: str, r: ResearchRequest):
    """Runs after the handler returns: posts stage changes, then the results card."""
    started = time.time()

    async def on_stage(stage: str):
        # the first stage only repeats the "searching" reply
        if time.time() - started > 5:
            await ctx.send(sender, msg(stage))

    try:
        job = await run_job(r, on_stage)
        out = job.get("output") or {}
        products = [to_product(p) for p in out.get("products", [])]
        if not products:
            notes = "; ".join(f"{m['merchant']}: {m['note']}" for m in out.get("merchants", []) if m.get("note"))
            await ctx.send(sender, msg("I couldn't find anything that matches on those stores this time" + (f" ({notes})" if notes else "") + ". Want me to try looser limits or another store?"))
            return
        if r.product_url:
            p = products[0]
            head = f"Here's what the page says: **{p.label}**, {usd(p.price_usd)}, {size(p.dimensions_wdh_m)}."
        else:
            missing = sum(1 for p in products if p.dimensions_wdh_m is None or p.price_usd is None)
            head = f"Found {len(products)} on {merchant_list(sorted({p.merchant for p in products}))}, cheapest first." + (
                f" {missing} didn't list a full size or price, so those are at the end." if missing else ""
            )
        await ctx.send(sender, msg(head, results_card(products, r.query[:60]), results_text(products)))
    except ValueError as e:
        await ctx.send(sender, msg(f"I couldn't start that search: {e}."))
    except Exception as e:
        ctx.logger.exception("chat job failed")
        await ctx.send(sender, msg(f"The store search broke on my side ({type(e).__name__}). Try again in a minute?"))
    finally:
        ctx.storage.set(f"active:{sender}", None)


async def handle_turn(ctx: Context, sender: str, m: ChatMessage):
    sel = parse_selection(m)
    if sel and sel.get("action") == "open" and sel.get("url"):
        return await ctx.send(sender, msg(f"[{sel.get('title') or 'Open the product page'}]({sel['url']})"))

    text = re.sub(r"^@\S+\s*", "", m.text().strip())
    if not text or GREETING.match(text):
        return await ctx.send(sender, msg(INTRO))
    active = ctx.storage.get(f"active:{sender}")
    if active and time.time() - active < JOB_WAIT_S:
        return await ctx.send(sender, msg("Still browsing for your last ask. I'll post the results here as soon as they're in."))
    if runs_today(ctx, sender) >= HUMAN_RUNS_PER_DAY:
        return await ctx.send(sender, msg(f"That's {HUMAN_RUNS_PER_DAY} live searches today, which is my daily limit per person. Come back tomorrow and I'll keep looking."))

    # a clarifying answer ("a sofa") joins the ask it answers
    pending = ctx.storage.get(f"pending:{sender}")
    ask = f"{pending}\n{text}" if pending else text
    found = URL.search(ask)
    url = found.group(0).rstrip(".,") if found else None
    if url and not merchant_of(url):
        ctx.storage.set(f"pending:{sender}", None)
        return await ctx.send(sender, msg("I can only read product pages on IKEA, Target, Walmart, Article and West Elm right now. Got a link from one of those?"))

    parsed = await parse_ask(ask)
    if not parsed.get("category") and not url:
        ctx.storage.set(f"pending:{sender}", ask[:500])
        question = re.sub(r"\s*[\u2014\u2013]\s*", ", ", parsed.get("question") or "") or "What piece are you after: a sofa, chair, table, rug, lamp, something else?"
        return await ctx.send(sender, msg(question))
    ctx.storage.set(f"pending:{sender}", None)

    merchants = [merchant_of(url)] if url else (parsed.get("merchants") or ["IKEA", "Target"])
    r = ResearchRequest(
        request_id=f"chat_{uuid4().hex[:12]}",
        category=parsed.get("category") or "other",
        query=(parsed.get("query") or parsed.get("category") or "furniture")[:160],
        max_price_usd=parsed.get("max_price_usd"),
        max_width_m=parsed.get("max_width_m"),
        max_depth_m=parsed.get("max_depth_m"),
        merchants=merchants,
        limit=CHAT_LIMIT or (3 if len(merchants) > 2 else 4),
        product_url=url,
    )
    ctx.storage.set(f"runs:{sender}:{today()}", runs_today(ctx, sender) + 1)
    ctx.storage.set(f"active:{sender}", time.time())
    caps = []
    if r.max_price_usd:
        caps.append(f"under {usd(r.max_price_usd)}")
    if r.max_width_m:
        caps.append(f"max {r.max_width_m:.2f} m wide")
    if r.max_depth_m:
        caps.append(f"max {r.max_depth_m:.2f} m deep")
    if url:
        await ctx.send(sender, msg(f"Opening that {merchants[0]} page live to read its size and price, about 1 to 2 minutes."))
    else:
        await ctx.send(sender, msg(f"Searching {merchant_list(merchants)} live for **{r.query}**{' ' + ', '.join(caps) if caps else ''}, about 2 to 4 minutes."))
    asyncio.create_task(follow_chat_job(ctx, sender, r))


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, m: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=m.msg_id))
    if any(isinstance(c, EndSessionContent) for c in m.content):
        return
    ctx.logger.info(f"chat from {sender[:16]}: {m.text()[:120]!r}")
    try:
        await handle_turn(ctx, sender, m)
    except Exception as e:  # never leave ASI:One hanging
        ctx.logger.exception("turn failed")
        await ctx.send(sender, msg(f"Something broke on my side ({type(e).__name__}). Try that again?"))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, m: ChatAcknowledgement):
    pass


# ---------- agents: paid research over TadaimaResearch ----------
# areq:{sender}:{request_id} -> {status: awaiting_payment|running|done|failed|cancelled, request, result?, tx?}


def areq_key(sender: str, request_id: str) -> str:
    return f"areq:{sender}:{request_id}"


def fee_minor() -> int:
    return int(round(PRICE_FET * 10**18))


async def run_for_agent(ctx: Context, sender: str, r: ResearchRequest):
    key = areq_key(sender, r.request_id)
    state = ctx.storage.get(key) or {}
    ctx.storage.set(key, {**state, "status": "running"})

    async def on_stage(stage: str):
        await ctx.send(sender, ResearchProgress(request_id=r.request_id, stage=stage))

    try:
        job = await run_job(r, on_stage)
        out = job.get("output") or {}
        products = [to_product(p) for p in out.get("products", [])]
        ok = bool(products) or job["state"] == "succeeded"
        result = ResearchResult(request_id=r.request_id, ok=ok, products=products, error=None if ok else (job.get("error") or job.get("stage")), cost_usd=out.get("costUsd"))
    except ValueError as e:
        result = ResearchResult(request_id=r.request_id, ok=False, error=f"bad request: {e}")
    except Exception as e:
        ctx.logger.exception("agent job failed")
        result = ResearchResult(request_id=r.request_id, ok=False, error=f"research failed ({type(e).__name__})")
    ctx.storage.set(key, {**(ctx.storage.get(key) or {}), "status": "done" if result.ok else "failed", "result": result.model_dump()})
    await ctx.send(sender, result)


@research_protocol.on_message(ResearchRequest, replies={ResearchProgress, ResearchResult})
async def on_research(ctx: Context, sender: str, r: ResearchRequest):
    key = areq_key(sender, r.request_id)
    state = ctx.storage.get(key)
    ctx.logger.info(f"ResearchRequest {r.request_id} from {sender[:16]} ({(state or {}).get('status', 'new')})")
    # idempotent per request_id: a repeat gets the same answer, never a second run or charge
    if state:
        if state["status"] in ("done", "failed", "cancelled") and state.get("result"):
            return await ctx.send(sender, ResearchResult(**state["result"]))
        if state["status"] == "awaiting_payment":
            await ctx.send(sender, ResearchProgress(request_id=r.request_id, stage=f"Waiting for {PRICE_FET:g} FET"))
            return await request_payment(ctx, sender, r.request_id)
        return await ctx.send(sender, ResearchProgress(request_id=r.request_id, stage="Already researching this one"))

    if sender in FREE_AGENTS or PRICE_FET <= 0:
        ctx.storage.set(key, {"status": "running", "request": r.model_dump()})
        await ctx.send(sender, ResearchProgress(request_id=r.request_id, stage="Starting research"))
        asyncio.create_task(run_for_agent(ctx, sender, r))
        return
    ctx.storage.set(key, {"status": "awaiting_payment", "request": r.model_dump(), "requestedAt": time.time()})
    ctx.storage.set(f"open:{sender}", [*(ctx.storage.get(f"open:{sender}") or [])[-9:], r.request_id])
    await ctx.send(sender, ResearchProgress(request_id=r.request_id, stage=f"Waiting for {PRICE_FET:g} FET"))
    await request_payment(ctx, sender, r.request_id)


async def request_payment(ctx: Context, sender: str, request_id: str):
    await ctx.send(sender, RequestPayment(
        accepted_funds=[Funds(amount=f"{PRICE_FET:g}", currency="FET", payment_method="fet_direct")],
        recipient=WALLET,
        deadline_seconds=PAY_DEADLINE_S,
        reference=request_id,
        description=f"Scout live furniture research run ({PRICE_FET:g} testnet FET)",
        metadata={"provider_agent_wallet": WALLET, "fet_network": "stable-testnet", "amount_atestfet": str(fee_minor()), "denom": DENOM},
    ))


async def verify_fet(tx_hash: str, buyer_wallet: str | None) -> str | None:
    """Checks the tx on the Dorado ledger. Returns None if it pays us enough, else why not."""
    tx = None
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as http:
        # a just-broadcast tx can take a block or two to be queryable
        for _ in range(10):
            try:
                async with http.get(f"{LEDGER_REST}/cosmos/tx/v1beta1/txs/{tx_hash}") as res:
                    if res.status == 200:
                        tx = await res.json()
                        break
            except (aiohttp.ClientError, asyncio.TimeoutError):
                pass
            await asyncio.sleep(3)
    if not tx:
        return "transaction not found on the testnet ledger"
    if int(tx.get("tx_response", {}).get("code", 1)) != 0:
        return "transaction failed on chain"
    paid = 0
    for m in tx.get("tx", {}).get("body", {}).get("messages", []):
        if m.get("@type") != "/cosmos.bank.v1beta1.MsgSend" or m.get("to_address") != WALLET:
            continue
        if buyer_wallet and m.get("from_address") != buyer_wallet:
            continue
        paid += sum(int(c["amount"]) for c in m.get("amount", []) if c.get("denom") == DENOM)
    if paid < fee_minor():
        return f"transaction pays {paid / 1e18:g} FET to this agent, {PRICE_FET:g} needed"
    return None


@seller.on_message(CommitPayment)
async def on_commit(ctx: Context, sender: str, m: CommitPayment):
    request_id = m.reference or ""
    key = areq_key(sender, request_id)
    state = ctx.storage.get(key)
    ctx.logger.info(f"CommitPayment {m.transaction_id[:16]} for {request_id} from {sender[:16]}")
    if not state:
        return await ctx.send(sender, CancelPayment(transaction_id=m.transaction_id, reason="no research request with that reference"))
    if state["status"] != "awaiting_payment":
        # a repeat commit for a request already paid; confirm again, don't run twice
        if state.get("tx") == m.transaction_id:
            return await ctx.send(sender, CompletePayment(transaction_id=m.transaction_id))
        return await ctx.send(sender, CancelPayment(transaction_id=m.transaction_id, reason="this request is already paid"))
    used = ctx.storage.get(f"tx:{m.transaction_id}")
    buyer_wallet = (m.metadata or {}).get("buyer_fet_wallet") if isinstance((m.metadata or {}).get("buyer_fet_wallet"), str) else None
    problem = "transaction already used for another request" if used else await verify_fet(m.transaction_id, buyer_wallet)
    r = ResearchRequest(**state["request"])
    if problem:
        ctx.logger.info(f"payment for {request_id} refused: {problem}")
        await ctx.send(sender, CancelPayment(transaction_id=m.transaction_id, reason=problem))
        result = ResearchResult(request_id=request_id, ok=False, error=f"payment not verified: {problem}")
        ctx.storage.set(key, {**state, "status": "cancelled", "result": result.model_dump()})
        return await ctx.send(sender, result)
    ctx.storage.set(f"tx:{m.transaction_id}", request_id)
    ctx.storage.set(key, {**state, "status": "running", "tx": m.transaction_id})
    await ctx.send(sender, CompletePayment(transaction_id=m.transaction_id))
    await ctx.send(sender, ResearchProgress(request_id=request_id, stage="Payment confirmed, starting research"))
    asyncio.create_task(run_for_agent(ctx, sender, r))


@seller.on_message(RejectPayment)
async def on_reject(ctx: Context, sender: str, m: RejectPayment):
    # RejectPayment has no reference; it answers this sender's open request(s)
    ctx.logger.info(f"RejectPayment from {sender[:16]}: {m.reason}")
    for request_id in ctx.storage.get(f"open:{sender}") or []:
        key = areq_key(sender, request_id)
        state = ctx.storage.get(key)
        if state and state.get("status") == "awaiting_payment":
            result = ResearchResult(request_id=request_id, ok=False, error=f"payment declined{': ' + m.reason if m.reason else ''}")
            ctx.storage.set(key, {**state, "status": "cancelled", "result": result.model_dump()})
            await ctx.send(sender, result)
    ctx.storage.set(f"open:{sender}", [])


agent.include(chat, publish_manifest=True)
agent.include(research_protocol, publish_manifest=True)
agent.include(seller, publish_manifest=True)


@agent.on_event("startup")
async def hello(ctx: Context):
    ctx.logger.info(f"Scout {agent.address} wallet {WALLET} backend {BACKEND} fee {PRICE_FET:g} FET, free agents {len(FREE_AGENTS)}")


if __name__ == "__main__":
    agent.run()
