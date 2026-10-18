"""
Tadaima service fee over the Fetch.ai Agent Payment Protocol (seller side).

A one-time $1.99 "finalize plan and cart" fee per (sender, project), paid with
Stripe embedded Checkout in TEST mode. Same shape as fetchai/innovation-lab-examples
stripe-payment-agents/twitch-growth-agent: RequestPayment carries
metadata["stripe"], the buyer's client opens Stripe, ASI:One answers with
CommitPayment(transaction_id=<checkout session id>), we verify with Stripe and
reply CompletePayment or CancelPayment (never RejectPayment after a commit).

Integration (agent.py, this module never imports it):

    from payments import payment_protocol, request_fee, on_paid, is_paid, handle_chat_confirmation, PaymentsUnavailable

    @on_paid
    async def _fee_paid(ctx, sender, project_id):
        await checkout.start_checkout(ctx, sender, project_id, api)

    agent.include(payment_protocol, publish_manifest=True)   # next to agent.include(chat, ...)

    # where the user asks to finalize / check out, BEFORE any LLM call:
    try:
        await request_fee(ctx, sender, project)   # already paid: calls on_paid right away
    except PaymentsUnavailable as e:
        await ctx.send(sender, msg(str(e)))

    # in handle_turn, before other selection routing: the ASI:One client can also
    # post {"stripe_checkout_session_id": "cs_..."} as chat text after paying.
    if sel and await handle_chat_confirmation(ctx, sender, sel):
        return

Env: STRIPE_SECRET_KEY (sk_test_/rk_test_ only), STRIPE_PUBLISHABLE_KEY (or
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, pk_test_ only), optional STRIPE_RETURN_URL,
TADAIMA_FEE_CENTS. Same names as backend/payments/stripe.ts.

Storage keys: fee:{sender}:{project} -> {status, sessionId, expiresAt},
fee_session:{sessionId} -> {sender, projectId}, fee_open:{sender} -> projectId
(the latest request, since RejectPayment has no transaction id).
"""

from __future__ import annotations

import os
import time
from typing import Awaitable, Callable

import aiohttp
from uagents import Context, Protocol
from uagents_core.contrib.protocols.chat import ChatMessage, TextContent
from uagents_core.contrib.protocols.payment import (
    CancelPayment,
    CommitPayment,
    CompletePayment,
    Funds,
    RejectPayment,
    RequestPayment,
    payment_protocol_spec,
)

FEE_CENTS = int(os.getenv("TADAIMA_FEE_CENTS", "199"))
CURRENCY = "usd"
PRODUCT = "Tadaima: finalize plan and cart"
DEADLINE_S = 30 * 60
STRIPE_API = "https://api.stripe.com/v1"
# Stripe's API wants "embedded_page" on newer versions; the ASI:One renderer keys off "embedded"
API_UI_MODES = ("embedded_page", "embedded")
CHAT_UI_MODE = "embedded"

OnPaid = Callable[[Context, str, str], Awaitable[None]]
_on_paid: OnPaid | None = None


class PaymentsUnavailable(Exception):
    """Stripe test keys are missing or not test keys. The message is safe to show the user."""


class StripeError(Exception):
    pass


def on_paid(fn: OnPaid) -> OnPaid:
    """Register what runs once a fee is verified: fn(ctx, sender, project_id)."""
    global _on_paid
    _on_paid = fn
    return fn


def fee_label() -> str:
    return f"${FEE_CENTS / 100:.2f}"


def _keys() -> tuple[str, str]:
    sk = os.getenv("STRIPE_SECRET_KEY") or ""
    pk = os.getenv("STRIPE_PUBLISHABLE_KEY") or os.getenv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY") or ""
    if not sk or not pk:
        raise PaymentsUnavailable("Payments aren't set up on this agent yet (Stripe test keys missing), so I can't take the service fee right now.")
    if not sk.startswith(("sk_test_", "rk_test_")) or not pk.startswith("pk_test_"):
        raise PaymentsUnavailable("This agent only takes Stripe test-mode payments, and its keys aren't test keys. Nothing was charged.")
    return sk, pk


def _form(data: dict, prefix: str = "") -> list[tuple[str, str]]:
    """Stripe's bracketed form encoding for nested dicts and lists."""
    out: list[tuple[str, str]] = []
    for k, v in data.items():
        key = f"{prefix}[{k}]" if prefix else str(k)
        if isinstance(v, dict):
            out += _form(v, key)
        elif isinstance(v, list):
            for i, item in enumerate(v):
                out += _form(item, f"{key}[{i}]") if isinstance(item, dict) else [(f"{key}[{i}]", str(item))]
        elif isinstance(v, bool):
            out.append((key, "true" if v else "false"))
        elif v is not None:
            out.append((key, str(v)))
    return out


async def _stripe(method: str, path: str, data: dict | None = None, idempotency_key: str | None = None) -> dict:
    sk, _ = _keys()
    headers = {"Idempotency-Key": idempotency_key} if idempotency_key else {}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as http:
        async with http.request(method, f"{STRIPE_API}{path}", data=_form(data) if data else None, headers=headers, auth=aiohttp.BasicAuth(sk, "")) as res:
            body = await res.json(content_type=None)
            if res.status >= 400:
                raise StripeError(((body or {}).get("error") or {}).get("message") or f"stripe {res.status}")
            return body


async def create_session(sender: str, project_id: str) -> dict:
    """Embedded Checkout session for the fee. Overridable in tests."""
    base = {
        "redirect_on_completion": "if_required",
        "mode": "payment",
        "payment_method_types": ["card"],
        "return_url": os.getenv("STRIPE_RETURN_URL", "https://asi1.ai/") + "?session_id={CHECKOUT_SESSION_ID}",
        "line_items": [{"price_data": {"currency": CURRENCY, "product_data": {"name": PRODUCT}, "unit_amount": FEE_CENTS}, "quantity": 1}],
        # Stripe wants 30 min to 24 h; a minute past our deadline
        "expires_at": int(time.time()) + DEADLINE_S + 60,
        "metadata": {"user_address": sender, "project_id": project_id, "kind": "tadaima_fee"},
    }
    err: StripeError | None = None
    for mode in API_UI_MODES:
        try:
            return await _stripe("POST", "/checkout/sessions", {**base, "ui_mode": mode})
        except StripeError as e:
            if "ui_mode" not in str(e):
                raise
            err = e
    raise err  # type: ignore[misc]


async def session_paid(session_id: str) -> bool:
    """Overridable in tests."""
    s = await _stripe("GET", f"/checkout/sessions/{session_id}")
    return s.get("payment_status") == "paid"


def _fee_key(sender: str, project_id: str) -> str:
    return f"fee:{sender}:{project_id}"


def fee_state(ctx: Context, sender: str, project_id: str) -> dict | None:
    return ctx.storage.get(_fee_key(sender, project_id))


def is_paid(ctx: Context, sender: str, project_id: str) -> bool:
    return (fee_state(ctx, sender, project_id) or {}).get("status") == "paid"


def _text(t: str) -> ChatMessage:
    return ChatMessage(content=[TextContent(text=t)])


async def request_fee(ctx: Context, sender: str, project_id: str) -> str:
    """
    Ask for the fee. Returns "paid" (on_paid already ran), "requested" (new
    RequestPayment sent) or "pending" (the open request was re-sent, no new session).
    Raises PaymentsUnavailable when Stripe isn't configured.
    """
    state = fee_state(ctx, sender, project_id) or {}
    if state.get("status") == "paid":
        if _on_paid:
            await _on_paid(ctx, sender, project_id)
        return "paid"
    _, pk = _keys()
    reuse = state.get("status") == "requested" and state.get("expiresAt", 0) > time.time() + 60 and state.get("stripe")
    if reuse:
        stripe_meta = state["stripe"]
    else:
        s = await create_session(sender, project_id)
        stripe_meta = {
            "client_secret": s["client_secret"],
            "checkout_session_id": s["id"],
            "publishable_key": pk,
            "currency": CURRENCY,
            "amount_cents": str(FEE_CENTS),
            "ui_mode": CHAT_UI_MODE,
        }
        state = {"status": "requested", "sessionId": s["id"], "expiresAt": time.time() + DEADLINE_S, "stripe": stripe_meta}
        ctx.storage.set(_fee_key(sender, project_id), state)
        ctx.storage.set(f"fee_session:{s['id']}", {"sender": sender, "projectId": project_id})
    ctx.storage.set(f"fee_open:{sender}", project_id)
    await ctx.send(sender, _text(
        f"Finalizing your plan and checkout costs a one-time **{fee_label()}** service fee (Stripe test mode, "
        "use card 4242 4242 4242 4242, any future date and CVC). Nothing in your room is bought by this fee."
    ))
    await ctx.send(sender, RequestPayment(
        accepted_funds=[Funds(currency=CURRENCY.upper(), amount=f"{FEE_CENTS / 100:.2f}", payment_method="stripe")],
        recipient=str(ctx.agent.address),
        deadline_seconds=max(60, int(state["expiresAt"] - time.time())),
        reference=f"tadaima_fee:{project_id}"[:120],
        description=f"{PRODUCT} ({fee_label()}, test mode)",
        metadata={"stripe": stripe_meta},
    ))
    return "pending" if reuse else "requested"


async def _settle(ctx: Context, reply_to: str, session_id: str, via_protocol: bool) -> bool:
    """Verify one checkout session. Returns True when the fee is now paid."""
    order = ctx.storage.get(f"fee_session:{session_id}")
    if not order:
        if via_protocol:
            await ctx.send(reply_to, CancelPayment(transaction_id=session_id, reason="unknown payment"))
        return False
    sender, project_id = order["sender"], order["projectId"]
    state = fee_state(ctx, sender, project_id) or {}
    if state.get("status") == "paid":
        # a repeat commit for a fee already settled; confirm again, don't run on_paid twice
        if via_protocol:
            await ctx.send(reply_to, CompletePayment(transaction_id=session_id))
        return True
    try:
        paid = await session_paid(session_id)
    except (StripeError, PaymentsUnavailable, aiohttp.ClientError) as e:
        ctx.logger.error(f"fee verify failed for {session_id}: {e}")
        paid = False
    if not paid:
        if via_protocol:
            await ctx.send(reply_to, CancelPayment(transaction_id=session_id, reason="payment not completed"))
        await ctx.send(sender, _text("Stripe hasn't confirmed that payment, so nothing was charged and your plan isn't finalized yet. Say **checkout** to try again."))
        return False
    ctx.storage.set(_fee_key(sender, project_id), {**state, "status": "paid", "paidAt": time.time()})
    if via_protocol:
        await ctx.send(reply_to, CompletePayment(transaction_id=session_id))
    await ctx.send(sender, _text(f"Got it, {fee_label()} test payment confirmed. Finalizing your cart now."))
    if _on_paid:
        await _on_paid(ctx, sender, project_id)
    return True


async def handle_chat_confirmation(ctx: Context, sender: str, sel: dict) -> bool:
    """Route {"stripe_checkout_session_id": "cs_..."} posted as chat text. True if it was one."""
    sid = sel.get("stripe_checkout_session_id") if isinstance(sel, dict) else None
    if not sid:
        return False
    order = ctx.storage.get(f"fee_session:{sid}") or {}
    if order.get("sender") != sender:
        await ctx.send(sender, _text("I don't have a pending payment for that checkout."))
        return True
    await _settle(ctx, sender, str(sid), via_protocol=False)
    return True


payment_protocol = Protocol(spec=payment_protocol_spec, role="seller")


@payment_protocol.on_message(CommitPayment)
async def on_commit(ctx: Context, sender: str, m: CommitPayment):
    ctx.logger.info(f"CommitPayment {m.transaction_id} from {sender[:16]}")
    await _settle(ctx, sender, m.transaction_id, via_protocol=True)


@payment_protocol.on_message(RejectPayment)
async def on_reject(ctx: Context, sender: str, m: RejectPayment):
    # RejectPayment carries no transaction id; it answers this sender's latest request
    ctx.logger.info(f"RejectPayment from {sender[:16]}: {m.reason}")
    project_id = ctx.storage.get(f"fee_open:{sender}")
    state = fee_state(ctx, sender, project_id) if project_id else None
    if state and state.get("status") == "requested":
        ctx.storage.set(_fee_key(sender, project_id), {**state, "status": "rejected"})
    note = f" ({m.reason})" if m.reason else ""
    await ctx.send(sender, _text(f"No problem, the fee was declined{note} and nothing was charged. Your room is saved; say **checkout** whenever you want to finalize."))
