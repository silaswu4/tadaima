"""
Signed room image URLs for chat, served by app/api/viz/[projectId]/[file]/route.ts.

  plan_image_url(project_id, rev)        -> plan at a revision (r{rev}.png)
  proposal_image_url(project_id, prop)   -> before/after diff of a proposal (p{id}.png)

Both are 1200x800 PNGs (3:2), immutable and CDN cached. The signature is the
first 22 chars of base64url HMAC-SHA256(VIZ_SECRET, "{project_id}/{file}"), the
same as backend/viz/sign.ts. Needs env BACKEND_URL and VIZ_SECRET (same value as
on the Next.js side). Without VIZ_SECRET the URL is unsigned, which only a dev
server accepts.

BACKEND_URL must be publicly fetchable: ASI:One loads the image itself, so a
Vercel preview behind deployment protection won't render. Use the production
domain. Never put VERCEL_PROTECTION_BYPASS in an image URL (it ends up in chat).

Integration (agent.py):

    from viz import plan_image_url, proposal_image_url

    # after a proposal is made: markdown image inside TextContent
    await ctx.send(sender, msg(
        f"![proposed change]({proposal_image_url(project_id, proposal['id'])})",
        summary_text,
        review_card,
    ))

    # after apply, or when showing the room: the plan at its new revision
    await ctx.send(sender, msg(f"![room]({plan_image_url(project_id, plan['revision'])})", ...))

    # or as a card image, e.g. a carousel item or detail hero
    CarouselItem(id="room", image=plan_image_url(project_id, rev), title="Your room", ...)
    # with aspect_ratio="3:2" on card image nodes that take one

Always key the URL by the revision or proposal it describes, never "current":
the image is cached forever, so old messages keep showing what they said.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from urllib.parse import quote


def _sig(secret: str, path: str) -> str:
    mac = hmac.new(secret.encode(), path.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")[:22]


def _url(project_id: str, file: str) -> str:
    base = (os.getenv("PUBLIC_URL") or os.getenv("BACKEND_URL", "http://localhost:3000")).rstrip("/")
    secret = os.getenv("VIZ_SECRET")
    url = f"{base}/api/viz/{quote(project_id, safe='')}/{file}"
    return f"{url}?s={_sig(secret, f'{project_id}/{file}')}" if secret else url


def images_enabled() -> bool:
    """ASI:One fetches images itself, so a localhost backend can't serve them."""
    base = os.getenv("PUBLIC_URL") or os.getenv("BACKEND_URL", "")
    return base.startswith("https://")


def plan_image_url(project_id: str, rev: int) -> str:
    return _url(project_id, f"r{int(rev)}.png")


def proposal_image_url(project_id: str, proposal_id: str) -> str:
    return _url(project_id, f"p{proposal_id}.png")


if __name__ == "__main__":
    # same vector as backend/viz/viz.test.ts
    assert _sig("test-secret", "proj_demo/r1.png") == "1RGH4ibpeHLCWKXQwfq-ry"
    print(plan_image_url("proj_demo", 1))
