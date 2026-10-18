"""
Throwaway local agent that sends Fit Check a FitRequest and waits for the FitVerdict.

  FITCHECK_ADDRESS=agent1q... python backend/fetch/fitcheck/probe.py

Talks to the running agent on localhost:8003 directly (no mailbox round trip).
"""

from __future__ import annotations

import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from uagents import Agent, Context  # noqa: E402
from uagents.resolver import RulesBasedResolver  # noqa: E402

from protocols import FitRequest, FitVerdict  # noqa: E402

FITCHECK = os.environ["FITCHECK_ADDRESS"]
probe = Agent(
    name="fit-probe",
    seed="fit-probe-" + uuid.uuid4().hex,
    port=8094,
    endpoint=["http://127.0.0.1:8094/submit"],
    resolve=RulesBasedResolver({FITCHECK: "http://127.0.0.1:8003/submit"}),
)

CASES = [
    FitRequest(request_id="a2a-sofa", dimensions_wdh_m=[2.1, 0.85, 0.9], space_width_m=2.4, space_depth_m=3.5, door_width_m=0.9, door_height_m=2.0),
    FitRequest(request_id="a2a-tall", dimensions_wdh_m=[0.8, 2.45, 0.3], ceiling_m=2.4),
    FitRequest(request_id="a2a-link", product_url="https://www.ikea.com/us/en/p/kivik-sofa-s29440588/", space_width_m=2.5),
]


@probe.on_event("startup")
async def go(ctx: Context):
    ok = 0
    for req in CASES:
        reply, status = await ctx.send_and_receive(FITCHECK, req, response_type=FitVerdict, timeout=20)
        good = isinstance(reply, FitVerdict) and reply.request_id == req.request_id
        ok += good
        print(f"{'PASS' if good else 'FAIL'} {req.request_id}: {getattr(reply, 'fits', None)} {getattr(reply, 'reasons', status)}", flush=True)
    print(f"{ok}/{len(CASES)} replies matched", flush=True)
    os._exit(0 if ok == len(CASES) else 1)


if __name__ == "__main__":
    probe.run()
