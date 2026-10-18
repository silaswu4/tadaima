"""
A throwaway agent that hires Scout through scout_client, paying testnet FET.

  set -a; . backend/fetch/scout/.env; set +a
  SCOUT_ADDRESS=agent1... BUYER_SEED=some-secret python backend/fetch/tests/scout_buyer.py

Prints every progress stage and the final result, then exits.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from uuid import uuid4

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import scout_client  # noqa: E402
from protocols import ResearchRequest  # noqa: E402
from uagents import Agent, Context  # noqa: E402

PORT = int(os.getenv("BUYER_PORT", "8003"))
buyer = Agent(
    name="scout-test-buyer",
    seed=os.environ["BUYER_SEED"],
    port=PORT,
    endpoint=[f"http://127.0.0.1:{PORT}/submit"],
    handle_messages_concurrently=True,
)
scout_client.attach(buyer)


async def hire(ctx: Context):
    await asyncio.sleep(float(os.getenv("BUYER_WAIT_S", "15")))  # let registration land
    started = time.time()
    req = ResearchRequest(
        request_id=os.getenv("BUYER_REQUEST_ID") or f"rr_{uuid4().hex[:10]}",
        category=os.getenv("BUYER_CATEGORY", "storage"),
        query=os.getenv("BUYER_QUERY", "white bookcase"),
        max_price_usd=float(os.getenv("BUYER_MAX_PRICE", "150")),
        merchants=["IKEA"],
        limit=2,
    )
    ctx.logger.info(f"hiring Scout for {req.request_id}")
    res = await scout_client.hire_scout(ctx, req, on_progress=lambda s: print(f"[{time.time() - started:5.0f}s] progress: {s}", flush=True))
    print(f"[{time.time() - started:5.0f}s] RESULT ok={res.ok} error={res.error} cost={res.cost_usd} products={len(res.products)}", flush=True)
    for p in res.products:
        print(f"    {p.merchant} | {p.label} | ${p.price_usd} | {p.dimensions_wdh_m} | {p.source_url}", flush=True)
    if os.getenv("BUYER_REPEAT"):
        again = await scout_client.hire_scout(ctx, req, timeout_s=60)
        print(f"REPEAT same request_id: ok={again.ok} products={len(again.products)} error={again.error}", flush=True)
    os._exit(0)


@buyer.on_event("startup")
async def go(ctx: Context):
    ctx.logger.info(f"buyer {buyer.address} wallet {buyer.wallet.address()}")
    asyncio.create_task(hire(ctx))


if __name__ == "__main__":
    buyer.run()
