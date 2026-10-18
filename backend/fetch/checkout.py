"""
Chat checkout for the Tadaima agent, over the backend's /checkout routes.

  start_checkout  cart per merchant -> live recheck -> Stripe test card if none
                  -> review card "Approve: max $X, merchants, 30 min"
  approve click   POST approve (mandate for this exact cart digest) -> POST execute
                  -> order card (amount, card, simulated retailer orders, test mode)

Money is Stripe test mode and retailer orders are simulated (the backend says so
in every order). This module never decides to pay: execute only runs right after
the shopper clicks approve on a card showing the exact max amount and stores.

Integration (agent.py, this module never imports it):

    import checkout

    # "cart" / "checkout" text or the {"action": "cart"} card: either straight in,
    #   await checkout.start_checkout(ctx, sender, project, api)
    # or behind the fee (see payments.py) with on_paid calling start_checkout.

    # in handle_turn, with the other `if sel:` routing:
    if sel and await checkout.handle_selection(ctx, sender, project, sel, api):
        return

`api` is agent.py's api(method, path, body=None, timeout=30) -> dict. A 4xx must
raise an exception whose class is named "Rejected" (agent.py's); those become
plain chat messages here. Anything else propagates to agent.py's error handler.

Selections this module owns (CHECKOUT_ACTIONS): approve_mandate {projectId,
cartDigest, paymentMethodId}, checkout, checkout_decline, checkout_pay, checkout_revoke.
"""

from __future__ import annotations

from typing import Awaitable, Callable
from uuid import uuid4

from uagents import Context
from uagents_core.contrib.protocols.chat import ChatMessage, MetadataContent, TextContent
from uagents_core.contrib.protocols.chat.cards import (
    CtaAction,
    ReviewCardPayload,
    ReviewSummaryRow,
    create_card_content,
)

Api = Callable[..., Awaitable[dict]]
CHECKOUT_ACTIONS = {"approve_mandate", "checkout", "checkout_decline", "checkout_pay", "checkout_revoke"}
RECHECK_TIMEOUT = 120
SETUP_BLOCKERS = {"test payments are not configured", "no card connected", "a payment for this exact cart is already processing or awaiting reconciliation"}

# backend blocker strings, said the way a person would
BLOCKER_TEXT = {
    "the cart is empty": "your plan has nothing to buy",
    "this exact cart was already paid for": "this exact cart was already paid for",
    "some items have no known price": "some items have no price yet",
    "prices and stock need a recheck": "prices and stock need a fresh check",
    "the recheck found problems": "the live check found items that are unavailable or couldn't be read",
    "no card connected": "no card is connected",
    "test payments are not configured": "test payments aren't set up on the server (Stripe test key missing)",
    "demo-only products must be replaced with verified retailer products": "some items are demo listings, not real retailer products",
    "some cart items are unavailable or have unverified stock": "some items are out of stock or their stock couldn't be confirmed",
    "the cart exceeds the room's budget": "the cart is over your budget",
}


def usd(money: dict | None) -> str:
    if not money:
        return "price unknown"
    return f"${money['amountMinor'] / 100:,.2f}"


def msg(*blocks) -> ChatMessage:
    return ChatMessage(content=[TextContent(text=b) if isinstance(b, str) else b for b in blocks if b is not None])


def refusal(e: Exception) -> str | None:
    """The backend's 4xx message, or None if this is an outage or a bug."""
    return str(e) if type(e).__name__ == "Rejected" else None


def blockers_text(blockers: list[str]) -> str:
    return "\n".join(f"- {BLOCKER_TEXT.get(b, b)}" for b in blockers)


def cart_text(view: dict) -> str:
    cart = view["cart"]
    out = ["**Checkout**", ""]
    for g in cart["merchants"]:
        out.append(f"**{g['merchant']}** ({usd(g['subtotal'])})")
        for line in g["lines"]:
            qty = f"{line['quantity']} x " if line["quantity"] != 1 else ""
            out.append(f"- {qty}{line['label']}: {usd(line.get('observedPrice'))}")
        out.append("")
    out.append(f"Total: **{usd(cart['subtotal'])}**")
    if cart.get("unpricedProductIds"):
        out.append(f"{len(cart['unpricedProductIds'])} item(s) have no price yet and block checkout.")
    if cart.get("unknownCosts"):
        out.append(f"Not included: {', '.join(cart['unknownCosts'])} (unknown until a retailer cart is built).")
    return "\n".join(out)


def recheck_text(view: dict) -> str:
    rc = view.get("recheck")
    if not rc:
        return "I couldn't finish the live price and stock check."
    changed = [l for l in rc["lines"] if l["status"] == "price_changed"]
    bad = [l for l in rc["lines"] if l["status"] in ("unavailable", "unverified")]
    if not changed and not bad:
        return f"Live check done: all {len(rc['lines'])} item(s) in stock at the listed price."
    out = ["Live check done."]
    for l in changed:
        out.append(f"- Price changed: {l['label']} {usd(l.get('catalogPrice'))} -> {usd(l.get('observedPrice'))}" + (f" ({l['note']})" if l.get("note") else ""))
    for l in bad:
        what = "unavailable" if l["status"] == "unavailable" else "couldn't confirm stock or price"
        out.append(f"- {l['label']}: {what}" + (f" ({l['note']})" if l.get("note") else ""))
    if changed:
        out.append(f"Your plan now uses the live prices; new total {usd(view['cart']['subtotal'])}.")
    return "\n".join(out)


def card_of(view: dict, payment_method_id: str | None = None) -> dict | None:
    methods = view.get("paymentMethods") or []
    if payment_method_id:
        return next((m for m in methods if m["id"] == payment_method_id), None)
    return next((m for m in methods if m.get("last4") == "4242"), None) or (methods[-1] if methods else None)


def card_label(card: dict) -> str:
    return f"{card['brand'].title()} ending {card['last4']} (test)"


def review_card(project_id: str, view: dict, card: dict) -> MetadataContent:
    cart = view["cart"]
    merchants = [g["merchant"] for g in cart["merchants"]]
    payload = ReviewCardPayload(
        title=f"Approve: max {usd(cart['subtotal'])}, {', '.join(merchants)}, 30 min",
        summary_rows=[
            ReviewSummaryRow(label="Max amount", value=usd(cart["subtotal"])),
            ReviewSummaryRow(label="Stores", value=", ".join(merchants)),
            ReviewSummaryRow(label="Card", value=card_label(card)),
            ReviewSummaryRow(label="Approval expires", value="30 minutes, this exact cart only"),
            ReviewSummaryRow(label="Not included", value=", ".join(cart.get("unknownCosts") or []) or "nothing"),
        ],
        approve_cta=CtaAction(label="Approve and pay", primary=True, selection={"action": "approve_mandate", "projectId": project_id, "cartDigest": cart["digest"], "paymentMethodId": card["id"]}),
        reject_cta=CtaAction(label="Not yet", selection={"action": "checkout_decline"}),
    )
    return create_card_content(payload, card_id=uuid4())


def order_card(order: dict) -> MetadataContent:
    rows = [
        ReviewSummaryRow(label="Charged", value=f"{usd(order['amount'])} (Stripe test mode)"),
        ReviewSummaryRow(label="Card", value=order["payment"]["card"]),
    ]
    rows += [ReviewSummaryRow(label=mo["merchant"], value="order simulated, not placed") for mo in order["merchantOrders"]]
    rows += [ReviewSummaryRow(label="Order", value=order["id"]), ReviewSummaryRow(label="Shipping and tax", value="not charged")]
    payload = ReviewCardPayload(
        title="Order confirmed (test mode)",
        summary_rows=rows,
        approve_cta=CtaAction(label="Back to my room", primary=True, selection={"action": "room"}),
    )
    return create_card_content(payload, card_id=uuid4())


def order_text(order: dict) -> str:
    notes = "\n".join(f"- {mo['note']}" for mo in order["merchantOrders"])
    return f"Paid **{usd(order['amount'])}** with {order['payment']['card']} in Stripe test mode. No real money moved.\n{notes}"


async def get_view(api: Api, project_id: str) -> dict:
    return await api("GET", f"/api/projects/{project_id}/checkout")


async def start_checkout(ctx: Context, sender: str, project_id: str, api: Api):
    """Cart, live recheck, test card, then the approval card (or what's blocking it)."""
    view = await get_view(api, project_id)
    if not view["cart"]["merchants"]:
        return await ctx.send(sender, msg("Your plan has no new purchases, so there's nothing to check out."))
    paid = next((o for o in view["orders"] if o["cartDigest"] == view["cart"]["digest"]), None)
    if paid:
        return await ctx.send(sender, msg("This exact cart is already paid for.", order_card(paid)))
    await ctx.send(sender, msg(cart_text(view) + "\n\nChecking live prices and stock with each store now..."))

    try:
        view = await api("POST", f"/api/projects/{project_id}/checkout/recheck", None, timeout=RECHECK_TIMEOUT)
    except Exception as e:
        why = refusal(e)
        if why is None:
            raise
        return await ctx.send(sender, msg(f"The live check didn't go through: {why}. Nothing was charged."))
    text = [recheck_text(view)]

    if not view["paymentMethods"] and view.get("testPaymentsAvailable"):
        try:
            card = await api("POST", f"/api/projects/{project_id}/checkout/card/test")
            text.append(f"Connected Stripe's test card, {card_label(card)}.")
            view = await get_view(api, project_id)
        except Exception as e:
            why = refusal(e)
            if why is None:
                raise
            text.append(f"I couldn't connect the test card: {why}.")
    await finish_review(ctx, sender, project_id, view, "\n\n".join(text))


async def finish_review(ctx: Context, sender: str, project_id: str, view: dict, lead: str = ""):
    """The approval card if nothing blocks it, else the blockers in plain words."""
    lead = lead + "\n\n" if lead else ""
    blockers = view["blockers"]
    if not view.get("testPaymentsAvailable"):
        # no card can be attached without Stripe, so that one is noise
        blockers = [b for b in blockers if b != "no card connected"]
    if blockers:
        setup_only = all(b in SETUP_BLOCKERS for b in blockers)
        tail = ("That's a setup issue on my side, not your room. Your plan is saved." if setup_only
                else "Change the room (for example, swap the flagged items), then say **checkout** again.")
        return await ctx.send(sender, msg(lead + "I can't ask you to approve this yet:\n" + blockers_text(blockers) + f"\n\nNothing was charged. {tail}"))
    if view.get("mandate"):
        m = view["mandate"]
        pay = ReviewCardPayload(
            title=f"You already approved up to {usd(m['maxAmount'])}",
            summary_rows=[ReviewSummaryRow(label="Stores", value=", ".join(m["merchants"])), ReviewSummaryRow(label="Expires", value=m["expiresAt"])],
            approve_cta=CtaAction(label="Pay now", primary=True, selection={"action": "checkout_pay"}),
            reject_cta=CtaAction(label="Cancel approval", selection={"action": "checkout_revoke"}),
        )
        return await ctx.send(sender, msg(lead + "This cart has an active approval.", create_card_content(pay, card_id=uuid4())))
    stale = "Your earlier approval was for a different cart, so it no longer counts.\n\n" if view.get("staleMandate") else ""
    card = card_of(view)
    await ctx.send(sender, msg(
        lead + stale + f"Ready. Approve and I'll pay exactly this cart, at most **{usd(view['cart']['subtotal'])}**, "
        "only at these stores, within 30 minutes. Test mode: no real money moves and retailer orders are simulated.",
        review_card(project_id, view, card),
    ))


async def pay(ctx: Context, sender: str, project_id: str, api: Api):
    """Charge under the active mandate. The backend refuses anything outside it."""
    try:
        order = await api("POST", f"/api/projects/{project_id}/checkout/execute", None, timeout=60)
    except Exception as e:
        why = refusal(e)
        if why is None:
            raise
        view = await get_view(api, project_id)
        return await finish_review(ctx, sender, project_id, view, f"I didn't pay: {why}. Nothing was charged.")
    await ctx.send(sender, msg(order_text(order), order_card(order)))


async def approve_and_pay(ctx: Context, sender: str, project_id: str, sel: dict, api: Api):
    if sel.get("projectId") and sel["projectId"] != project_id:
        return await ctx.send(sender, msg("That approval was for a different room. Say **checkout** to review this one."))
    digest, pm = sel.get("cartDigest"), sel.get("paymentMethodId")
    if not digest or not pm:
        return await ctx.send(sender, msg("That approval card is missing details. Say **checkout** for a fresh one."))
    view = await get_view(api, project_id)
    done = next((o for o in view["orders"] if o["cartDigest"] == digest), None)
    if done:
        # a repeat click on a card that already paid
        return await ctx.send(sender, msg("Already paid for this cart.", order_card(done)))
    if view["cart"]["digest"] != digest:
        return await finish_review(ctx, sender, project_id, view, "Your cart changed since that card was shown, so I didn't approve it. Here's the current one.")
    try:
        await api("POST", f"/api/projects/{project_id}/checkout/approve", {"cartDigest": digest, "paymentMethodId": pm})
    except Exception as e:
        why = refusal(e)
        if why is None:
            raise
        view = await get_view(api, project_id)
        return await finish_review(ctx, sender, project_id, view, f"Approval didn't go through: {why}. Nothing was charged.")
    await pay(ctx, sender, project_id, api)


async def handle_selection(ctx: Context, sender: str, project_id: str, sel: dict, api: Api) -> bool:
    """Handle a checkout card click. False if the action isn't one of CHECKOUT_ACTIONS."""
    action = (sel or {}).get("action")
    if action not in CHECKOUT_ACTIONS:
        return False
    if action == "approve_mandate":
        await approve_and_pay(ctx, sender, project_id, sel, api)
    elif action == "checkout":
        await start_checkout(ctx, sender, project_id, api)
    elif action == "checkout_pay":
        await pay(ctx, sender, project_id, api)
    elif action == "checkout_revoke":
        await api("POST", f"/api/projects/{project_id}/checkout/revoke")
        await ctx.send(sender, msg("Approval cancelled. Nothing was charged."))
    else:
        await ctx.send(sender, msg("No problem, nothing was approved or charged. Say **checkout** when you're ready."))
    return True
