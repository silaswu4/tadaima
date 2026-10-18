"""
Hire Scout (scout/agent.py) from another agent: send a ResearchRequest, pay its
testnet FET fee from this agent's own wallet, get the products back.

Wiring, once, where the agent is built:

    import scout_client

    scout_client.attach(agent)   # includes scout_client.protocol and buyer_payment_protocol,
                                 # remembers agent.wallet, tops the wallet up from the testnet faucet

    # equivalent by hand:
    #   scout_client.use_wallet(agent)
    #   agent.include(scout_client.protocol)
    #   agent.include(scout_client.buyer_payment_protocol)

Then, from any handler or task:

    from protocols import ResearchRequest

    result = await scout_client.hire_scout(
        ctx,
        ResearchRequest(request_id=f"rr_{uuid4().hex[:12]}", category="sofa", query="green velvet sofa",
                        max_price_usd=900, max_width_m=2.2, merchants=["IKEA", "Target"], limit=4),
        on_progress=lambda stage: ctx.logger.info(stage),   # sync or async, gets each stage string
    )
    if result.ok:
        for p in result.products: ...

hire_scout awaits replies that arrive as separate messages, so the agent must
keep handling messages while it waits: create the agent with
handle_messages_concurrently=True (Tadaima does), or call hire_scout from an
asyncio task instead of awaiting it inside a handler. It never raises for a
Scout-side problem; on timeout or refusal it returns ResearchResult(ok=False).

Env: SCOUT_ADDRESS (Scout's agent1... address), SCOUT_MAX_FET (refuse to pay
more than this per run, default 0.1), SCOUT_TIMEOUT_S (default 360).
"""

from __future__ import annotations

import asyncio
import inspect
import os
import time
from typing import Awaitable, Callable

from cosmpy.aerial.client import LedgerClient
from cosmpy.aerial.wallet import LocalWallet
from cosmpy.crypto.address import Address
from uagents import Agent, Context, Protocol
from uagents.network import get_ledger
from uagents.setup import fund_agent_if_low
from uagents_core.contrib.protocols.payment import (
    CancelPayment,
    CommitPayment,
    CompletePayment,
    Funds,
    RejectPayment,
    RequestPayment,
    payment_protocol_spec,
)

from protocols import ResearchProgress, ResearchRequest, ResearchResult, research_protocol

SCOUT_ADDRESS = os.getenv("SCOUT_ADDRESS", "")
MAX_FET = float(os.getenv("SCOUT_MAX_FET", "0.1"))
TIMEOUT_S = float(os.getenv("SCOUT_TIMEOUT_S", "360"))
DENOM = "atestfet"
# keep enough for a few runs plus gas; the faucet hands out 10 testnet FET
MIN_BALANCE = 10**18

protocol = research_protocol
buyer_payment_protocol = Protocol(spec=payment_protocol_spec, role="buyer")

OnProgress = Callable[[str], Awaitable[None] | None]

_wallet: LocalWallet | None = None
_ledger: LedgerClient = get_ledger("testnet")
# request_id -> {"future", "on_progress", "scout"}; replies are matched to callers by request_id
_pending: dict[str, dict] = {}


def use_wallet(agent: Agent) -> None:
    global _wallet
    _wallet = agent.wallet


def attach(agent: Agent) -> None:
    use_wallet(agent)
    agent.include(protocol)
    agent.include(buyer_payment_protocol)

    @agent.on_event("startup")
    async def _fund(ctx: Context):
        try:
            await asyncio.to_thread(fund_agent_if_low, str(agent.wallet.address()), MIN_BALANCE)
            bal = await asyncio.to_thread(_ledger.query_bank_balance, agent.wallet.address(), DENOM)
            ctx.logger.info(f"scout_client wallet {agent.wallet.address()} has {bal / 1e18:g} testnet FET")
        except Exception as e:
            ctx.logger.warning(f"scout_client could not check or fund the wallet: {e}")


async def _progress(entry: dict, stage: str) -> None:
    cb = entry.get("on_progress")
    if not cb:
        return
    try:
        out = cb(stage)
        if inspect.isawaitable(out):
            await out
    except Exception:
        pass


def _finish(request_id: str, result: ResearchResult) -> None:
    entry = _pending.get(request_id)
    if entry and not entry["future"].done():
        entry["future"].set_result(result)


async def hire_scout(ctx: Context, request: ResearchRequest, on_progress: OnProgress | None = None, scout_address: str | None = None, timeout_s: float | None = None) -> ResearchResult:
    scout = scout_address or SCOUT_ADDRESS
    if not scout:
        return ResearchResult(request_id=request.request_id, ok=False, error="SCOUT_ADDRESS is not set")
    if request.request_id in _pending:
        # same id twice: wait on the first call instead of asking Scout again
        return await asyncio.shield(_pending[request.request_id]["future"])
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    _pending[request.request_id] = {"future": fut, "on_progress": on_progress, "scout": scout}
    try:
        await ctx.send(scout, request)
        return await asyncio.wait_for(asyncio.shield(fut), timeout=timeout_s or TIMEOUT_S)
    except asyncio.TimeoutError:
        return ResearchResult(request_id=request.request_id, ok=False, error=f"Scout didn't answer within {int(timeout_s or TIMEOUT_S)} s")
    finally:
        _pending.pop(request.request_id, None)


# ---------- research replies ----------


@protocol.on_message(ResearchProgress)
async def _on_progress(ctx: Context, sender: str, m: ResearchProgress):
    entry = _pending.get(m.request_id)
    if entry and sender == entry["scout"]:
        await _progress(entry, m.stage)


@protocol.on_message(ResearchResult)
async def _on_result(ctx: Context, sender: str, m: ResearchResult):
    entry = _pending.get(m.request_id)
    if entry and sender == entry["scout"]:
        _finish(m.request_id, m)


# ---------- paying (buyer role) ----------


def _send_fet(to: str, amount: int) -> str:
    tx = _ledger.send_tokens(Address(to), amount, DENOM, _wallet, memo="scout research")
    tx.wait_to_complete()
    return tx.tx_hash


@buyer_payment_protocol.on_message(RequestPayment)
async def _on_request_payment(ctx: Context, sender: str, m: RequestPayment):
    request_id = m.reference or ""
    entry = _pending.get(request_id)
    if not entry or sender != entry["scout"]:
        return await ctx.send(sender, RejectPayment(reason="no open request with that reference"))
    funds = next((f for f in m.accepted_funds if f.payment_method == "fet_direct" and f.currency.upper() in ("FET", "TESTFET")), None)
    if not funds:
        await ctx.send(sender, RejectPayment(reason="only fet_direct is supported"))
        return _finish(request_id, ResearchResult(request_id=request_id, ok=False, error="Scout asked for a payment method this agent can't pay"))
    amount_fet = float(funds.amount)
    if amount_fet > MAX_FET:
        await ctx.send(sender, RejectPayment(reason=f"over this agent's {MAX_FET:g} FET limit"))
        return _finish(request_id, ResearchResult(request_id=request_id, ok=False, error=f"Scout asked {amount_fet:g} FET, over the {MAX_FET:g} FET limit"))
    meta = m.metadata or {}
    if meta.get("fet_network", "stable-testnet") != "stable-testnet":
        await ctx.send(sender, RejectPayment(reason="this agent only pays on testnet"))
        return _finish(request_id, ResearchResult(request_id=request_id, ok=False, error="Scout asked for a mainnet payment"))
    if _wallet is None:
        await ctx.send(sender, RejectPayment(reason="buyer wallet not set up"))
        return _finish(request_id, ResearchResult(request_id=request_id, ok=False, error="scout_client has no wallet; call scout_client.attach(agent)"))
    to = meta.get("provider_agent_wallet") if isinstance(meta.get("provider_agent_wallet"), str) else m.recipient
    await _progress(entry, f"Paying Scout {amount_fet:g} testnet FET")
    started = time.time()
    try:
        tx_hash = await asyncio.to_thread(_send_fet, to, int(round(amount_fet * 10**18)))
    except Exception as e:
        ctx.logger.error(f"FET payment failed: {e}")
        await ctx.send(sender, RejectPayment(reason="payment failed on the buyer side"))
        return _finish(request_id, ResearchResult(request_id=request_id, ok=False, error=f"couldn't pay Scout: {type(e).__name__}"))
    ctx.logger.info(f"paid {amount_fet:g} FET to {to} in {time.time() - started:.0f}s, tx {tx_hash}")
    await ctx.send(sender, CommitPayment(
        funds=Funds(amount=funds.amount, currency=funds.currency, payment_method="fet_direct"),
        recipient=to,
        transaction_id=tx_hash,
        reference=request_id,
        description=m.description,
        metadata={"buyer_fet_wallet": str(_wallet.address()), "fet_network": "stable-testnet"},
    ))


@buyer_payment_protocol.on_message(CompletePayment)
async def _on_complete(ctx: Context, sender: str, m: CompletePayment):
    ctx.logger.info(f"Scout confirmed payment {m.transaction_id}")


@buyer_payment_protocol.on_message(CancelPayment)
async def _on_cancel(ctx: Context, sender: str, m: CancelPayment):
    # Scout follows a cancel with ResearchResult(ok=False); this just logs why
    ctx.logger.warning(f"Scout cancelled payment {m.transaction_id}: {m.reason}")
