"""Per-chat room credentials and the allowlist at the external agent boundary.

Credentials stay in local uAgents storage, never the model's history or cards.
ContextVar keeps concurrent ASI:One senders and background tasks isolated.
The backend independently enforces these same scopes and expiry/revocation.
"""
from __future__ import annotations

from contextvars import ContextVar
from datetime import datetime, timezone
import re

CURRENT_PAIRING: ContextVar[dict | None] = ContextVar("tadaima_fetch_pairing", default=None)
PRIVATE_PROJECT = re.compile(r"proj_room_[a-f0-9]{32}\Z")
TOKEN = re.compile(r"tadaima_fetch_[a-f0-9]{64}\Z")
CONNECT = re.compile(r"^connect\s+([A-Za-z0-9-]{6,80})\s*$", re.I)
PAIRED_TOOLS = {"get_room", "show_room", "propose_change", "search_products", "place_product", "show_cart"}


def valid_binding(data: dict) -> dict:
    if not isinstance(data, dict) or not PRIVATE_PROJECT.fullmatch(str(data.get("projectId", ""))):
        raise ValueError("invalid paired project")
    if not TOKEN.fullmatch(str(data.get("token", ""))):
        raise ValueError("invalid pairing credential")
    if not data.get("expiresAt"):
        raise ValueError("pairing expiry missing")
    return {key: data[key] for key in ("projectId", "token", "expiresAt")}


def expired(binding: dict) -> bool:
    try:
        raw = binding["expiresAt"]
        if isinstance(raw, (int, float)):
            # The backend uses milliseconds. Also accept Unix seconds for tests.
            end = raw / 1000 if raw > 100_000_000_000 else raw
        else:
            end = datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
        return end <= datetime.now(timezone.utc).timestamp()
    except (KeyError, TypeError, ValueError, OverflowError):
        return True


def paired_headers(method: str, path: str, binding: dict | None) -> dict[str, str]:
    """Refuse accidental cross-room calls before any HTTP request is sent."""
    if binding is None:
        if path.startswith("/api/projects/proj_room_") or path.startswith("/api/agent/pairings/") and path != "/api/agent/pairings/redeem":
            raise PermissionError("connect this scanned room first")
        return {}
    binding = valid_binding(binding)
    if expired(binding):
        raise PermissionError("room connection expired; reconnect from the website")
    project = re.escape(binding["projectId"])
    read = re.fullmatch(rf"/api/projects/{project}(?:/brief(?:\?itemId=[A-Za-z0-9_-]+)?|/shop/[A-Za-z0-9_-]+|/jobs/[A-Za-z0-9_-]+)?", path)
    write = re.fullmatch(rf"/api/projects/{project}/(?:shop|proposals|research)", path)
    scoped = method == "GET" and (read or path == "/api/agent/pairings/cart") or method == "POST" and (write or path == "/api/agent/pairings/preview")
    if not scoped:
        raise PermissionError("this connection only researches and prepares changes; confirm changes and payments on the website")
    return {"Authorization": f"Bearer {binding['token']}"}
