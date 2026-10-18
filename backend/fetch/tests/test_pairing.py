from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pairing import CURRENT_PAIRING, PAIRED_TOOLS, expired, paired_headers, valid_binding


def binding(char="a"):
    return {"projectId": "proj_room_" + char * 32, "token": "tadaima_fetch_" + char * 64,
            "expiresAt": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}


class BoundaryTests(unittest.IsolatedAsyncioTestCase):
    def test_cross_room_and_mutations_refused(self):
        b = binding()
        paths = [("GET", "/api/projects/" + binding("b")["projectId"]),
                 ("POST", f"/api/projects/{b['projectId']}/place"),
                 ("POST", f"/api/projects/{b['projectId']}/changes"),
                 ("POST", f"/api/projects/{b['projectId']}/proposals/p_one/apply"),
                 ("POST", f"/api/projects/{b['projectId']}/checkout/approve"),
                 ("POST", f"/api/projects/{b['projectId']}/checkout/execute"),
                 ("POST", f"/api/projects/{b['projectId']}/reset"),
                 ("GET", "/api/agent/users?sender=someone")]
        for method, path in paths:
            with self.subTest(path=path), self.assertRaises(PermissionError):
                paired_headers(method, path, b)

    def test_allowed_requests_carry_only_current_bearer(self):
        b = binding()
        for method, path in [("GET", f"/api/projects/{b['projectId']}"),
                             ("GET", f"/api/projects/{b['projectId']}/shop/job_one"),
                             ("GET", f"/api/projects/{b['projectId']}/jobs/job_one"),
                             ("POST", f"/api/projects/{b['projectId']}/shop"),
                             ("POST", f"/api/projects/{b['projectId']}/proposals"),
                             ("POST", "/api/agent/pairings/preview"),
                             ("GET", "/api/agent/pairings/cart")]:
            self.assertEqual(paired_headers(method, path, b), {"Authorization": f"Bearer {b['token']}"})

    def test_no_private_fallback_and_invalid_expiry(self):
        with self.assertRaises(PermissionError):
            paired_headers("GET", f"/api/projects/{binding()['projectId']}", None)
        self.assertEqual(paired_headers("POST", "/api/agent/pairings/redeem", None), {})
        self.assertTrue(expired({"expiresAt": "invalid"}))
        b = {**binding(), "expiresAt": 1}
        with self.assertRaises(PermissionError):
            paired_headers("GET", f"/api/projects/{b['projectId']}", b)
        with self.assertRaises(ValueError):
            valid_binding({**binding(), "projectId": "proj_demo"})

    async def test_concurrent_contexts_and_background_tasks_are_isolated(self):
        async def chat(b):
            token = CURRENT_PAIRING.set(b)
            try:
                async def request():
                    await asyncio.sleep(0)
                    live = CURRENT_PAIRING.get()
                    return paired_headers("GET", f"/api/projects/{b['projectId']}", live)
                task = asyncio.create_task(request())
                await asyncio.sleep(0)
                return await task
            finally:
                CURRENT_PAIRING.reset(token)
        a, b = binding(), binding("b")
        results = await asyncio.gather(chat(a), chat(b))
        self.assertEqual([r["Authorization"] for r in results], [f"Bearer {a['token']}", f"Bearer {b['token']}"])
        self.assertIsNone(CURRENT_PAIRING.get())


# Importing the adapter must not publish, start a server, or derive a real identity.
os.environ.setdefault("AGENT_SEED", "test-only-no-real-agent-seed")
with patch("uagents.Agent"):
    import agent
from uagents_core.contrib.protocols.chat import ChatMessage, TextContent


class Storage:
    def __init__(self): self.rows = {}
    def get(self, key): return self.rows.get(key)
    def set(self, key, value): self.rows[key] = value


class Context:
    def __init__(self):
        self.storage = Storage()
        self.sent = []
        self.logger = type("Log", (), {"error": lambda *_: None})()
    async def send(self, sender, message): self.sent.append((sender, message))


def message(text):
    return ChatMessage(content=[TextContent(text=text)])


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_connect_is_per_sender_and_never_enters_model_or_chat_output(self):
        ctx = Context()
        async def api(method, path, body=None, **kwargs):
            self.assertEqual((method, path), ("POST", "/api/agent/pairings/redeem"))
            return binding("a" if body["sender"] == "alice" else "b")
        with patch.object(agent, "api", side_effect=api), patch.object(agent, "show_room", new=AsyncMock()) as show, patch.object(agent.brain, "run_turn", new=AsyncMock()) as model:
            await asyncio.gather(agent.handle_turn(ctx, "alice", message("connect CODE-ALICE")),
                                 agent.handle_turn(ctx, "bob", message("connect CODE-BOB")))
        self.assertEqual(agent.conv(ctx, "alice")["projectId"], binding()["projectId"])
        self.assertEqual(agent.conv(ctx, "bob")["projectId"], binding("b")["projectId"])
        self.assertEqual(show.await_count, 2)
        model.assert_not_awaited()
        output = str(ctx.sent)
        self.assertNotIn(binding()["token"], output)
        self.assertNotIn("CODE-ALICE", output)
        self.assertIsNone(CURRENT_PAIRING.get())

    async def test_private_tools_and_card_selection_only_preview(self):
        ctx = Context()
        b = binding()
        agent.set_conv(ctx, "alice", step="ready", projectId=b["projectId"], pairing=b)
        seen = []
        async def api(method, path, body=None, **kwargs):
            seen.append((method, path, body, CURRENT_PAIRING.get()))
            return {"reviewRequired": True}
        with patch.object(agent, "api", side_effect=api):
            await agent.handle_turn(ctx, "alice", message('{"action":"place","productId":"chair","x":1,"z":2,"projectId":"' + b["projectId"] + '"}'))
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][:2], ("POST", "/api/agent/pairings/preview"))
        self.assertEqual(seen[0][2]["spot"], {"position": [1, 0, 2]})
        self.assertEqual(seen[0][3], b)
        token = CURRENT_PAIRING.set(b)
        try:
            self.assertEqual(set(agent.tools_for(ctx, "alice", b["projectId"])), PAIRED_TOOLS)
            self.assertIsNone(agent.room_image(b["projectId"], 1))
        finally:
            CURRENT_PAIRING.reset(token)

    async def test_stale_product_card_cannot_preview_in_another_room(self):
        ctx = Context()
        b = binding()
        agent.set_conv(ctx, "alice", step="ready", projectId=b["projectId"], pairing=b)
        with patch.object(agent, "api", new=AsyncMock()) as api:
            await agent.handle_turn(ctx, "alice", message('{"action":"place","productId":"chair","x":1,"z":2,"projectId":"' + binding("b")["projectId"] + '"}'))
        api.assert_not_awaited()

    async def test_apply_checkout_payment_and_reset_do_not_reach_backend(self):
        ctx = Context()
        b = binding()
        agent.set_conv(ctx, "alice", step="ready", projectId=b["projectId"], pairing=b)
        with patch.object(agent, "api", new=AsyncMock()) as api, patch.object(agent, "think", new=AsyncMock()) as think:
            for text in ['{"action":"apply","proposalId":"p_one"}', '{"action":"approve_mandate"}', "checkout", "reset"]:
                await agent.handle_turn(ctx, "alice", message(text))
        api.assert_not_awaited()
        think.assert_not_awaited()

    async def test_expiry_and_local_disconnect_never_fall_back_to_demo(self):
        ctx = Context()
        b = {**binding(), "expiresAt": 1}
        agent.set_conv(ctx, "alice", step="ready", projectId=b["projectId"], pairing=b)
        with patch.object(agent, "api", new=AsyncMock()) as api, patch.object(agent, "show_room", new=AsyncMock()) as show:
            await agent.handle_turn(ctx, "alice", message("show room"))
            self.assertIsNone(agent.conv(ctx, "alice")["projectId"])
            agent.set_conv(ctx, "alice", step="ready", projectId=binding()["projectId"], pairing=binding())
            await agent.handle_turn(ctx, "alice", message("disconnect"))
        self.assertIsNone(agent.conv(ctx, "alice")["pairing"])
        api.assert_not_awaited()
        show.assert_not_awaited()

    async def test_actual_http_headers_are_scoped_without_global_agent_key(self):
        sent = []
        class Response:
            status = 200
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def json(self, **kwargs): return {"ok": True}
        class Session:
            def __init__(self, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            def request(self, method, url, **kwargs):
                sent.append((url, kwargs["headers"]))
                return Response()
        async def read(b):
            token = CURRENT_PAIRING.set(b)
            try:
                await asyncio.sleep(0)
                return await agent.api("GET", f"/api/projects/{b['projectId']}")
            finally:
                CURRENT_PAIRING.reset(token)
        with patch.object(agent.aiohttp, "ClientSession", Session), patch.object(agent, "AGENT_API_KEY", "global-secret"):
            await asyncio.gather(read(binding()), read(binding("b")))
        self.assertEqual(len(sent), 2)
        for (url, headers), b in zip(sent, [binding(), binding("b")]):
            self.assertTrue(url.endswith(b["projectId"]))
            self.assertEqual(headers["Authorization"], f"Bearer {b['token']}")
            self.assertNotIn("x-agent-key", headers)
            self.assertNotIn(b["token"], url)

    async def test_paired_cart_uses_scope_without_payment_details(self):
        ctx = Context()
        b = binding()
        agent.set_conv(ctx, "alice", step="ready", projectId=b["projectId"], pairing=b)
        cart = {"merchants": [], "subtotal": {"amountMinor": 0, "currency": "USD"}, "unknownCosts": []}
        with patch.object(agent, "api", new=AsyncMock(return_value={"cart": cart})) as api:
            await agent.handle_turn(ctx, "alice", message("cart"))
        api.assert_awaited_once_with("GET", "/api/agent/pairings/cart")


if __name__ == "__main__":
    unittest.main()
