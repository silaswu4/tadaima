# Tadaima Fetch / ASI:One agent

This is the existing `tadaima` uAgents adapter from `work/backend-fetch-agent`, connected to the **same canonical scanned room** used by the website. It does not reconstruct or copy a new room.

| | |
| --- | --- |
| Agent name | `tadaima` |
| Existing agent address | `agent1qdsuu2yjgd0tnddnu79rp8jxdu7zd9lkjgskxasptxukqrdlrv08szru3em` |
| Protocol | Agent Chat Protocol 0.3.0 and ASI:One cards |

The original address is recovered only by using the team's existing `AGENT_SEED`. A new seed produces a different address. Do not commit a seed or the generated `agent*_data.json` files: that local storage contains per-chat room credentials.

## Connect a scanned room

1. Open the actual scanned room on the website and choose **Ask Tadaima → Fetch chat → Connect this room to Fetch**. Create its short-lived, single-use connection code.
2. In this agent's ASI:One chat, send `connect CODE`.
3. Ask for products near an existing item, for example “find a wood chair under $150 near the desk.” Product search uses the scanned room's metric geometry, constraints, and current revision.
4. Choose **Preview in room** on a result. The website receives a preview request. Review its placement in the room and confirm it there before it joins the room and basket.
5. Whole-room requests create proposals for the website to review and explicitly apply. Say `cart` to read the same basket. Payment approval stays on the website.
6. Revoke the connection on the website to immediately invalidate its credential. `disconnect` removes the local chat binding; server revocation remains available on the website.

No browser session cookie is transferred. No private scan photo, GLB, source evidence URL, or private room image URL is placed in the chat. The connected agent can read a scoped room description, research products, prepare previews, and propose changes. It cannot apply proposals, place purchases, move/store/unlock existing furniture, reset the room, change constraints directly, approve a checkout, or make a payment.

```text
Scanned room → browser-owned connection code
ASI:One chat → Agentverse mailbox → Python adapter → redeem code
                                                 → scoped bearer credential
                                                 → canonical room research/proposals/previews
Website → review + explicit confirmation → canonical room / basket revision
```

The Python adapter also checks the allowed project and actions before sending HTTP requests. Credentials are scoped per chat sender with `ContextVar`; concurrent chats and live search tasks never share authorization headers. The backend is the final authority for scope, expiry, revocation and validation.

## Run locally

Python 3.12:

```bash
cd backend/fetch
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env locally; do not paste keys in chat.
set -a
source .env
set +a
python agent.py
```

Required: `AGENT_SEED` and a `BACKEND_URL` pointing to the website backend that owns the room session. For the local demo, run this Python agent on the same Mac as the website and use `http://127.0.0.1:3017`. ASI:One reaches the agent through Agentverse; it does not need direct access to localhost. A separately hosted agent must reach the same deployed backend and persistence store instead.

`ANTHROPIC_API_KEY` in the Python process enables free-form tool selection. The Next.js backend separately needs its own `ANTHROPIC_API_KEY` for room proposals and `BROWSER_USE_API_KEY` for live retailer research. Catalog-backed search can run without live retailer credentials. `VERCEL_PROTECTION_BYPASS` is optional for protected deployments and is sent only in an HTTP header.

On first start, open the printed Agent Inspector link, click **Connect**, choose **Mailbox**, then use **Chat with Agent** in Agentverse or mention the agent in ASI:One. Starting this process does not prove a public listing, provider configuration, or delivered chat message; those require a live smoke test with the team's credentials.

## Checks

```bash
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
.venv/bin/python -m py_compile agent.py brain.py pairing.py checkout.py payments.py viz.py
```

Tests use fake chat storage and stubbed HTTP/model boundaries. They cover sender isolation, cross-room denial, rejected mutation/payment tools, preview-only product selection, expiry, local disconnect, credentials kept out of model history/cards, and concurrent credential contexts. They do not contact Agentverse, Claude, Browser Use, or Stripe.

## Retained legacy features

The branch's account onboarding, synthetic demo editing, signed room-image helpers, test checkout, and Payment Protocol seller remain in their original Python modules. Set `FETCH_ENABLE_LEGACY_ONBOARDING=1` only when the corresponding legacy `/api/agent/users`, `/api/agent/rooms` and signed `/api/viz` routes are installed. Those unrelated TypeScript routes are not required for scanned-room pairing. The default introduction starts with pairing or an explicitly separate synthetic `demo`.

Payment Protocol and legacy checkout never receive paired-room permissions. Paired-room plans do not emit public visualization URLs. Real retailer orders remain outside this adapter.
