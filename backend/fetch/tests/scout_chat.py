"""
Drives Scout's chat handler with a fake ctx against a running backend, real
Claude parse and a real Browser Use run, and prints every outgoing message.

  set -a; . backend/fetch/scout/.env; set +a
  SCOUT_SEED=scout-harness-$RANDOM SCOUT_CHAT_LIMIT=2 python backend/fetch/tests/scout_chat.py "white bookcase under 150 dollars, IKEA only"
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(HERE, "..", "scout"))

import agent as scout  # noqa: E402
from uagents_core.contrib.protocols.chat import ChatMessage, MetadataContent, TextContent  # noqa: E402


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
        t = time.strftime("%H:%M:%S")
        if isinstance(m, ChatMessage):
            for b in m.content:
                if isinstance(b, TextContent):
                    print(f"[{t}] -> text: {b.text}")
                elif isinstance(b, MetadataContent):
                    payload = json.loads(b.metadata.get("card_payload", "{}"))
                    print(f"[{t}] -> card {b.metadata.get('card_kind')}: {len(payload.get('items', []))} items")
                    for it in payload.get("items", []):
                        print(f"           {it['title']} | {it.get('subtitle')} | {it.get('secondary_text')} | {[x['label'] for x in it.get('badges') or []]} | img={'yes' if it.get('image') else 'no'}")
        else:
            print(f"[{t}] -> {type(m).__name__}")


async def main(text: str):
    ctx = Ctx()
    sender = "agent1qharnesshuman"
    await scout.handle_turn(ctx, sender, ChatMessage(content=[TextContent(text=text)]))
    tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    await asyncio.gather(*tasks)
    # tap the first card's button, like ASI:One would
    card = next((b for m in ctx.sent if isinstance(m, ChatMessage) for b in m.content if isinstance(b, MetadataContent)), None)
    if card:
        item = json.loads(card.metadata["card_payload"])["items"][0]
        click = json.dumps(item["primary_cta"]["selection"])
        print(f"\n(tap) {click}")
        await scout.handle_turn(ctx, sender, ChatMessage(content=[TextContent(text=click)]))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "white bookcase under $150, IKEA only"))
