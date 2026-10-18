"""
Agent-to-agent protocols between the tadaima agents (Tadaima, Scout, Fit Check).

Humans talk to every agent over the Agent Chat Protocol. Agents talk to each
other with these typed messages, so a request is validated, has a stable id
and can be answered or timed out without parsing chat text.

  Tadaima / Fit Check  --ResearchRequest-->  Scout
                       <--ResearchProgress--  (zero or more, same request_id)
                       <--ResearchResult----  (exactly one)

  Tadaima              --FitRequest-->       Fit Check
                       <--FitVerdict--

Sizes are meters, [width, height, depth] like backend/contracts.ts. Prices are USD.
Scout charges other agents per research run through the Payment Protocol
(testnet FET); see scout/agent.py.
"""

from __future__ import annotations

from uagents import Model, Protocol


class Product(Model):
    id: str
    merchant: str
    label: str
    source_url: str
    image_url: str | None = None
    category: str | None = None
    price_usd: float | None = None
    dimensions_wdh_m: list[float] | None = None
    seats: int | None = None
    availability: str = "unknown"
    observed_at: str | None = None


class ResearchRequest(Model):
    request_id: str
    category: str
    query: str
    max_price_usd: float | None = None
    max_width_m: float | None = None
    max_depth_m: float | None = None
    merchants: list[str] = ["IKEA", "Target"]
    limit: int = 5
    # measure this one product page instead of searching (query and category then describe it)
    product_url: str | None = None


class ResearchProgress(Model):
    request_id: str
    stage: str


class ResearchResult(Model):
    request_id: str
    ok: bool
    products: list[Product] = []
    error: str | None = None
    cost_usd: float | None = None


class FitRequest(Model):
    request_id: str
    # either a size or a product link (Fit Check asks Scout to measure links)
    dimensions_wdh_m: list[float] | None = None
    product_url: str | None = None
    space_width_m: float | None = None
    space_depth_m: float | None = None
    ceiling_m: float | None = None
    door_width_m: float | None = None
    door_height_m: float | None = None
    clearance_m: float = 0.3


class FitVerdict(Model):
    request_id: str
    fits: str  # "yes" | "no" | "unknown"
    reasons: list[str] = []
    product: Product | None = None


research_protocol = Protocol(name="TadaimaResearch", version="0.1.0")
fit_protocol = Protocol(name="TadaimaFitCheck", version="0.1.0")
