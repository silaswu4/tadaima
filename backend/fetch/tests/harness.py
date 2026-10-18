"""
Drives payments.py and checkout.py with a fake ctx and prints every outgoing message.

  BACKEND_URL=http://localhost:3007 python backend/fetch/tests/harness.py

1. live:   checkout against the running backend on a fresh proj_demo_<random>
2. fee:    the Payment Protocol flow with Stripe stubbed (or real, if test keys are set)
3. happy:  approve, execute and order card against an in-memory fake backend
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid

import aiohttp

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import checkout  # noqa: E402
import payments  # noqa: E402
from uagents_core.contrib.protocols.chat import ChatMessage, MetadataContent, TextContent  # noqa: E402
from uagents_core.contrib.protocols.payment import CommitPayment, Funds, RejectPayment  # noqa: E402

BACKEND = os.getenv("BACKEND_URL", "http://localhost:3007").rstrip("/")


class Rejected(Exception):
    pass


class BackendError(Exception):
    pass


async def api(method: str, path: str, body: dict | None = None, timeout: float = 30) -> dict:
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as http:
        async with http.request(method, f"{BACKEND}{path}", json=body, headers={"content-type": "application/json"}) as res:
            data = await res.json(content_type=None)
            if res.status < 400:
                return data
            err = (data or {}).get("error", f"backend {res.status}")
            raise (Rejected if res.status < 500 else BackendError)(err)


class Storage:
    def __init__(self):
        self.d: dict = {}

    def get(self, k):
        return self.d.get(k)

    def set(self, k, v):
        self.d[k] = json.loads(json.dumps(v))

    def remove(self, k):
        self.d.pop(k, None)


class Log:
    def info(self, m): print(f"    [log] {m}")
    error = warning = exception = info


class Ctx:
    def __init__(self):
        self.storage = Storage()
        self.logger = Log()
        self.agent = type("A", (), {"address": "agent1qtadaimatest"})()
        self.sent: list = []

    async def send(self, to, m):
        self.sent.append(m)
        show(to, m)


def show(to, m):
    name = type(m).__name__
    if isinstance(m, ChatMessage):
        for c in m.content:
            if isinstance(c, TextContent):
                print(f"  -> {to[:14]} text:\n" + "\n".join("     " + l for l in c.text.splitlines()))
            elif isinstance(c, MetadataContent):
                md = c.metadata
                p = json.loads(md["card_payload"]) if "card_payload" in md else md
                print(f"  -> {to[:14]} card[{md.get('card_kind')}] {json.dumps(p)[:600]}")
    else:
        d = m.model_dump() if hasattr(m, "model_dump") else m.dict()
        if d.get("metadata", {}) and "stripe" in (d.get("metadata") or {}):
            d["metadata"]["stripe"] = {k: (v[:12] + "..." if k == "client_secret" else v) for k, v in d["metadata"]["stripe"].items()}
        print(f"  -> {to[:14]} {name} {json.dumps(d)}")


def kinds(ctx: Ctx) -> list[str]:
    return [type(m).__name__ for m in ctx.sent]


# ---------- 1. live backend ----------


async def live():
    print(f"\n=== 1. live checkout on {BACKEND}")
    project = "proj_demo_" + uuid.uuid4().hex[:16]
    ctx = Ctx()
    await checkout.start_checkout(ctx, "user_live", project, api)
    view = await checkout.get_view(api, project)
    print(f"  backend blockers: {view['blockers']}, testPaymentsAvailable={view.get('testPaymentsAvailable')}, cards={len(view['paymentMethods'])}")
    print("  stale/forged approve click:")
    ctx.sent.clear()
    await checkout.handle_selection(ctx, "user_live", project, {"action": "approve_mandate", "projectId": project, "cartDigest": "deadbeef", "paymentMethodId": "pm_x"}, api)
    print("  approve with current digest while blocked:")
    await checkout.handle_selection(ctx, "user_live", project, {"action": "approve_mandate", "projectId": project, "cartDigest": view["cart"]["digest"], "paymentMethodId": "pm_x"}, api)
    print("  execute with no approval:")
    await checkout.handle_selection(ctx, "user_live", project, {"action": "checkout_pay"}, api)


# ---------- 2. fee over the Payment Protocol ----------


async def fee():
    print("\n=== 2. service fee")
    real = bool(os.getenv("STRIPE_SECRET_KEY"))
    ctx = Ctx()
    paid_calls = []

    @payments.on_paid
    async def _paid(c, sender, project):
        paid_calls.append((sender, project))
        await c.send(sender, ChatMessage(content=[TextContent(text=f"(on_paid ran for {project})")]))

    if not real:
        os.environ.pop("STRIPE_PUBLISHABLE_KEY", None)
        try:
            await payments.request_fee(ctx, "user_a", "proj_x")
            print("  FAIL: expected PaymentsUnavailable")
        except payments.PaymentsUnavailable as e:
            print(f"  no keys -> PaymentsUnavailable: {e}")
        os.environ["STRIPE_SECRET_KEY"], os.environ["STRIPE_PUBLISHABLE_KEY"] = "sk_live_nope", "pk_live_nope"
        try:
            await payments.request_fee(ctx, "user_a", "proj_x")
        except payments.PaymentsUnavailable as e:
            print(f"  live keys -> PaymentsUnavailable: {e}")
        print("  (Stripe stubbed from here: no test keys in env)")
        os.environ["STRIPE_SECRET_KEY"], os.environ["STRIPE_PUBLISHABLE_KEY"] = "sk_test_stub", "pk_test_stub"
        sessions: dict[str, bool] = {}

        async def create_session(sender, project):
            sid = "cs_test_" + uuid.uuid4().hex[:10]
            sessions[sid] = False
            return {"id": sid, "client_secret": sid + "_secret_x"}

        async def session_paid(sid):
            return sessions.get(sid, False)

        payments.create_session, payments.session_paid = create_session, session_paid
    else:
        sessions = None

    r1 = await payments.request_fee(ctx, "user_a", "proj_x")
    r2 = await payments.request_fee(ctx, "user_a", "proj_x")
    sid = payments.fee_state(ctx, "user_a", "proj_x")["sessionId"]
    print(f"  request -> {r1}, repeat -> {r2}, same session: {r2 == 'pending'}")
    commit = CommitPayment(funds=Funds(amount="1.99", currency="USD", payment_method="stripe"), recipient="agent1qtadaimatest", transaction_id=sid)
    if sessions is None:
        print("  real Stripe: open the client_secret in Stripe embedded checkout to pay; skipping commit")
        return
    print("  commit before paying:")
    await payments.on_commit(ctx, "user_a", commit)
    sessions[sid] = True
    print("  commit after paying:")
    await payments.on_commit(ctx, "user_a", commit)
    print("  duplicate commit:")
    await payments.on_commit(ctx, "user_a", commit)
    print("  request again once paid:")
    r3 = await payments.request_fee(ctx, "user_a", "proj_x")
    print(f"  -> {r3}; on_paid calls: {len(paid_calls)} (expect 2: settle + repeat request)")
    print("  unknown session commit:")
    await payments.on_commit(ctx, "user_a", CommitPayment(funds=commit.funds, recipient=commit.recipient, transaction_id="cs_test_unknown"))
    print("  reject on another project:")
    await payments.request_fee(ctx, "user_a", "proj_y")
    await payments.on_reject(ctx, "user_a", RejectPayment(reason="not now"))
    print(f"  proj_y status: {payments.fee_state(ctx, 'user_a', 'proj_y')['status']}")
    print("  chat-text confirmation for proj_z:")
    await payments.request_fee(ctx, "user_a", "proj_z")
    sid_z = payments.fee_state(ctx, "user_a", "proj_z")["sessionId"]
    sessions[sid_z] = True
    handled = await payments.handle_chat_confirmation(ctx, "user_a", {"stripe_checkout_session_id": sid_z})
    print(f"  handled={handled}, proj_z paid={payments.is_paid(ctx, 'user_a', 'proj_z')}")
    for k in ("STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"):
        os.environ.pop(k, None)


# ---------- 3. happy path, fake backend ----------


def fake_backend():
    money = lambda c: {"amountMinor": c, "currency": "USD"}
    state = {"digest": "d1", "cards": [], "mandate": None, "orders": [], "recheck": None}
    lines = [{"productId": "p1", "variantId": None, "label": "TONSTAD coffee table", "quantity": 1, "observedPrice": money(34999)},
             {"productId": "p2", "variantId": None, "label": "LOHALS rug", "quantity": 1, "observedPrice": money(9999)}]
    tgt = [{"productId": "p3", "variantId": None, "label": "Threshold lamp", "quantity": 1, "observedPrice": money(4500)}]

    def view():
        cart = {"projectId": "proj_demo_fake", "planRevision": 2, "digest": state["digest"], "unpricedProductIds": [], "unknownCosts": ["shipping", "tax"],
                "merchants": [{"merchant": "IKEA", "lines": lines, "subtotal": money(sum(l["observedPrice"]["amountMinor"] for l in lines))}, {"merchant": "Target", "lines": tgt, "subtotal": money(4500)}],
                "subtotal": money(sum(l["observedPrice"]["amountMinor"] for l in lines + tgt))}
        blockers = [] if state["recheck"] and state["cards"] else (["prices and stock need a recheck"] if not state["recheck"] else ["no card connected"])
        if any(o["cartDigest"] == state["digest"] for o in state["orders"]):
            blockers.append("this exact cart was already paid for")
        m = state["mandate"] if state["mandate"] and state["mandate"]["status"] == "active" else None
        return {"cart": cart, "recheck": state["recheck"], "paymentMethods": state["cards"], "mandate": m if m and m["cartDigest"] == state["digest"] else None,
                "staleMandate": m if m and m["cartDigest"] != state["digest"] else None, "orders": state["orders"], "blockers": blockers, "stripePublishableKey": "pk_test_x", "testPaymentsAvailable": True}

    async def fapi(method, path, body=None, timeout=30):
        tail = path.split("/checkout", 1)[1]
        if tail == "":
            return view()
        if tail == "/recheck":
            lines[1]["observedPrice"] = money(8999)
            state["digest"] = "d2"
            state["recheck"] = {"cartDigest": "d2", "allOk": True, "checkedAt": "now", "lines": [
                {"productId": "p1", "label": "TONSTAD coffee table", "status": "ok", "catalogPrice": money(34999), "observedPrice": money(34999), "note": None},
                {"productId": "p2", "label": "LOHALS rug", "status": "price_changed", "catalogPrice": money(9999), "observedPrice": money(8999), "note": None},
                {"productId": "p3", "label": "Threshold lamp", "status": "ok", "catalogPrice": money(4500), "observedPrice": money(4500), "note": None}]}
            return view()
        if tail == "/card/test":
            card = {"id": "pm_1", "provider": "stripe_test", "brand": "visa", "last4": "4242", "expMonth": 12, "expYear": 2034}
            state["cards"] = [card]
            return card
        if tail == "/approve":
            if body["cartDigest"] != state["digest"]:
                raise Rejected("the cart changed since you looked at it; review it again")
            state["mandate"] = {"id": "mdt_1", "cartDigest": body["cartDigest"], "maxAmount": view()["cart"]["subtotal"], "merchants": ["IKEA", "Target"], "paymentMethodId": body["paymentMethodId"], "expiresAt": "soon", "status": "active"}
            return state["mandate"]
        if tail == "/execute":
            m = state["mandate"]
            if not m or m["status"] != "active":
                raise Rejected("there's no active approval; the shopper has to approve the cart first")
            m["status"] = "used"
            order = {"id": "ord_1", "mandateId": m["id"], "cartDigest": state["digest"], "amount": m["maxAmount"],
                     "payment": {"provider": "stripe_test", "paymentIntentId": "pi_1", "status": "succeeded", "card": "visa ending 4242"},
                     "merchantOrders": [{"merchant": g, "status": "simulated", "note": f"Not placed with {g}: retailer ordering is simulated in this build. Shipping and tax were not charged."} for g in ("IKEA", "Target")], "testMode": True}
            state["orders"].insert(0, order)
            return order
        if tail == "/revoke":
            if state["mandate"]:
                state["mandate"]["status"] = "revoked"
            return view()
        raise Rejected(f"no route {path}")

    return fapi, state


async def happy():
    print("\n=== 3. happy path (fake backend)")
    fapi, state = fake_backend()
    ctx = Ctx()
    project = "proj_demo_fake"
    await checkout.start_checkout(ctx, "user_b", project, fapi)
    card = json.loads(ctx.sent[-1].content[-1].metadata["card_payload"])
    sel = card["approve_cta"]["selection"]
    print("  stale card (cart changed after review):")
    state["digest"], keep = "d3", state["digest"]
    await checkout.handle_selection(ctx, "user_b", project, sel, fapi)
    state["digest"] = keep
    print("  approve click:")
    await checkout.handle_selection(ctx, "user_b", project, sel, fapi)
    print("  double click:")
    await checkout.handle_selection(ctx, "user_b", project, sel, fapi)
    print("  wrong room:")
    await checkout.handle_selection(ctx, "user_b", project, {**sel, "projectId": "proj_other"}, fapi)
    print(f"  orders: {len(state['orders'])} (expect 1)")


async def main():
    try:
        await live()
    except (aiohttp.ClientError, BackendError) as e:
        print(f"  live backend unreachable: {e}")
    await fee()
    await happy()


if __name__ == "__main__":
    asyncio.run(main())
