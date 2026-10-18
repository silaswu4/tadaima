"""
Measure a product link through the Scout agent, if there is one.

Degrades to None (so the caller asks the person for the size) when
SCOUT_ADDRESS isn't set, backend/fetch/scout_client.py isn't on this branch,
or Scout fails or times out.
"""

from __future__ import annotations

import os

from uagents import Context

from protocols import Product

SCOUT_ADDRESS = os.getenv("SCOUT_ADDRESS")

try:
    import scout_client  # backend/fetch/scout_client.py, owned by the Scout agent
except ImportError:
    scout_client = None


def available() -> bool:
    return bool(SCOUT_ADDRESS and scout_client)


async def measure(ctx: Context, url: str) -> Product | None:
    if not available():
        return None
    try:
        product = await scout_client.measure(ctx, url, scout=SCOUT_ADDRESS)
    except Exception as e:
        ctx.logger.warning(f"scout measure failed: {e}")
        return None
    return product if product and product.dimensions_wdh_m else None
