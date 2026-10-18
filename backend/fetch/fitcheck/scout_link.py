"""
Measure a product link by hiring the Scout agent (backend/fetch/scout_client.py).

Degrades to None, so the caller asks the person for the size, when
SCOUT_ADDRESS isn't set, scout_client.py isn't on this branch yet, or Scout
fails, refuses or times out. Scout charges a small testnet FET fee per run,
paid from this agent's wallet by scout_client (capped by SCOUT_MAX_FET).
"""

from __future__ import annotations

import os
import re
from uuid import uuid4

from uagents import Agent, Context

from protocols import Product, ResearchRequest

SCOUT_ADDRESS = os.getenv("SCOUT_ADDRESS")
TIMEOUT_S = float(os.getenv("FITCHECK_SCOUT_TIMEOUT_S", "150"))
CATEGORIES = ["sofa", "chair", "table", "desk", "storage", "bed", "rug", "lamp", "decor"]
ALIASES = {"couch": "sofa", "sectional": "sofa", "loveseat": "sofa", "bookcase": "storage", "shelf": "storage", "dresser": "storage", "wardrobe": "storage", "cabinet": "storage"}

try:
    import scout_client  # owned by the Scout agent's engineer
except ImportError:
    scout_client = None


def available() -> bool:
    return bool(SCOUT_ADDRESS and scout_client)


def attach(agent: Agent) -> None:
    """Include Scout's research and buyer payment protocols, when Scout is configured."""
    if available():
        scout_client.attach(agent)


def category_for(label: str | None, url: str) -> str:
    words = re.findall(r"[a-z]+", f"{label or ''} {url}".lower())
    for w in words:
        if w in CATEGORIES:
            return w
        if w in ALIASES:
            return ALIASES[w]
    return "other"


async def measure(ctx: Context, url: str, label: str | None = None) -> Product | None:
    if not available():
        return None
    req = ResearchRequest(
        request_id=f"fit_{uuid4().hex[:12]}",
        category=category_for(label, url),
        query=(label or "the product at this link")[:160],
        product_url=url,
        limit=1,
    )
    try:
        res = await scout_client.hire_scout(ctx, req, on_progress=lambda stage: ctx.logger.info(f"scout: {stage}"), timeout_s=TIMEOUT_S)
    except Exception as e:
        ctx.logger.warning(f"scout measure failed: {e}")
        return None
    if not res.ok:
        ctx.logger.warning(f"scout measure failed: {res.error}")
        return None
    return next((p for p in res.products if p.dimensions_wdh_m and len(p.dimensions_wdh_m) == 3), None)
