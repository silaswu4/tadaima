"""
Drives the Fit Check chat and FitRequest handlers with a fake ctx and prints every reply.
Uses real Claude parsing (ANTHROPIC_API_KEY from .env). Doesn't touch the network otherwise.

  python backend/fetch/fitcheck/harness.py
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
for line in open(os.path.join(HERE, ".env")) if os.path.exists(os.path.join(HERE, ".env")) else []:
    if "=" in line and not line.startswith("#"):
        k, v = line.strip().split("=", 1)
        os.environ.setdefault(k, v.strip("'\""))
os.environ.pop("SCOUT_ADDRESS", None)  # exercise the no-Scout path
os.environ.setdefault("FITCHECK_SEED", "harness-only-seed-" + uuid.uuid4().hex)
os.environ["FITCHECK_PORT"] = "8093"

spec = importlib.util.spec_from_file_location("fitcheck_agent", os.path.join(HERE, "agent.py"))
fc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fc)

from protocols import FitRequest, FitVerdict  # noqa: E402
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, MetadataContent, TextContent  # noqa: E402
from uagents_core.contrib.protocols.chat.cards import card_kind_for_payload, create_card_response_content, extract_card  # noqa: E402


class Storage:
    def __init__(self):
        self.d: dict = {}

    def get(self, k):
        return self.d.get(k)

    def set(self, k, v):
        self.d[k] = json.loads(json.dumps(v))


class Log:
    def info(self, m): print(f"    [log] {m}")
    error = warning = exception = info


class Ctx:
    def __init__(self):
        self.storage = Storage()
        self.logger = Log()
        self.sent: list = []

    async def send(self, to, m):
        self.sent.append(m)
        show(m)


def show(m):
    if isinstance(m, ChatAcknowledgement):
        return
    if isinstance(m, FitVerdict):
        print(f"  <- FitVerdict {m.request_id}: {m.fits} {m.reasons}")
        return
    for b in m.content:
        if isinstance(b, TextContent):
            print("  <- " + b.text.replace("\n", "\n     "))
        elif isinstance(b, MetadataContent):
            card = extract_card(b)
            if card:
                p = card.payload
                if card_kind_for_payload(card.payload) == "form":
                    print(f"  <- [form card] {p.title}: " + ", ".join(f.name for f in p.fields))
                elif card_kind_for_payload(card.payload) == "review":
                    print(f"  <- [review card] {p.title}")
                    for r in p.summary_rows:
                        print(f"       {r.label}: {r.value}")
                else:
                    print(f"  <- [{card_kind_for_payload(card.payload)} card]")


def text(t: str) -> ChatMessage:
    return ChatMessage(content=[TextContent(text=t)])


def last_kind(ctx: Ctx) -> list[str]:
    kinds = []
    for m in ctx.sent:
        if isinstance(m, ChatMessage):
            for b in m.content:
                if isinstance(b, MetadataContent) and (c := extract_card(b)):
                    kinds.append(card_kind_for_payload(c.payload))
    return kinds


async def turn(ctx: Ctx, sender: str, m: ChatMessage, label: str):
    print(f"\n-> [{label}] {m.text()[:160] or '(card response)'}")
    ctx.sent.clear()
    await fc.on_chat(ctx, sender, m)
    return ctx.sent


def verdict_of(ctx: Ctx) -> str | None:
    for m in ctx.sent:
        if isinstance(m, ChatMessage):
            t = m.text()
            for v, head in fc.HEADLINE.items():
                if head[:8] in t:
                    return v
    return None


async def main():
    ctx = Ctx()
    results = []

    def expect(name, ok):
        results.append((name, ok))
        print(f"  {'PASS' if ok else 'FAIL'} {name}")

    await turn(ctx, "alice", text("hi"), "greeting")
    expect("greeting gets help", "Fit Check" in ctx.sent[-1].text())

    await turn(ctx, "alice", text("will a 2.1 x 0.9 m sofa fit on a 2.4 m wall, door is 80 x 200 cm?"), "metric, no height")
    expect("metric: wall fits, door needs height -> unknown", verdict_of(ctx) == "unknown")

    await turn(ctx, "alice", text("oh it's 85 cm tall"), "follow-up height")
    expect("metric follow-up: 85 cm tall through 80 cm door, legs maybe", verdict_of(ctx) in ("no", "unknown"))

    await turn(ctx, "bob", text('Will an 84" wide, 38" deep, 34" tall sofa fit along an 8 ft wall? Front door is 36 x 80 inches.'), "imperial")
    expect("imperial: fits", verdict_of(ctx) == "yes")

    await turn(ctx, "cara", text("will this couch fit in my living room?"), "missing info")
    expect("missing info -> one form", last_kind(ctx) == ["form"])

    await turn(ctx, "cara", text("idk the numbers"), "still missing")
    expect("no second form", last_kind(ctx) == [])

    sel = {"piece_width": "230", "piece_depth": "100", "piece_height": "80", "space_width": "220", "space_depth": "400", "unit": "cm"}
    await turn(ctx, "cara", text("@tadaima-fitcheck " + json.dumps(sel)), "form submit as @handle json, no action")
    expect("form submit: too wide but turned fits in 4 m deep room", verdict_of(ctx) == "yes")

    sel = {"action": "fit", "piece_width": "230", "space_width": "220", "space_depth": "200"}
    await turn(ctx, "cara", ChatMessage(content=[create_card_response_content(card_id=uuid.uuid4(), selection=sel)]), "form submit as card response")
    expect("card form submit: 2.3 m in 2.2 x 2.0 -> no", verdict_of(ctx) == "no")

    await turn(ctx, "dev", text("https://www.ikea.com/us/en/p/kivik-sofa-tibbleby-beige-gray-s29440588/ will it fit on my 2.5 m wall?"), "link, no scout")
    t = " ".join(m.text() for m in ctx.sent if isinstance(m, ChatMessage))
    expect("link without scout asks for size", "can't open product links" in t and verdict_of(ctx) is None and last_kind(ctx) == ["form"])

    await turn(ctx, "dev", text("it says 228 x 95 x 83 cm"), "size after link")
    expect("link follow-up: 2.28 on 2.5 m wall fits", verdict_of(ctx) == "yes")

    await turn(ctx, "erin", text("bookcase is 80 cm wide, 30 deep, 250 tall. ceilings are 8 feet"), "too tall")
    expect("too tall for 8 ft ceiling", verdict_of(ctx) == "no")

    await turn(ctx, "erin", text("what's the weather like"), "off topic")
    expect("off topic -> help", "Fit Check" in ctx.sent[-1].text())

    print("\n-> [FitRequest] agent to agent")
    ctx.sent.clear()
    await fc.on_fit(ctx, "agent1qtadaima", FitRequest(request_id="r1", dimensions_wdh_m=[2.1, 0.85, 0.9], space_width_m=2.4, door_width_m=0.9, door_height_m=2.0))
    v = ctx.sent[-1]
    expect("FitRequest -> FitVerdict same id", isinstance(v, FitVerdict) and v.request_id == "r1" and v.fits == "yes")
    ctx.sent.clear()
    await fc.on_fit(ctx, "agent1qtadaima", FitRequest(request_id="r2", product_url="https://example.com/sofa", space_width_m=2.4))
    v = ctx.sent[-1]
    expect("FitRequest link without scout -> unknown", v.request_id == "r2" and v.fits == "unknown")

    bad = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed" + (f", failed: {bad}" if bad else ""))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    asyncio.run(main())
