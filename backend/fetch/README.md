# Tadaima: furnish your real room

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Tadaima plans furniture for your actual room, with real products that physically fit, stay in your budget and keep what you already own. Tell it what you want in plain words. It searches real stores, checks every piece against your room's measurements, shows you the floor plan before and after, and only buys after you approve the exact amount.

**Keywords:** furniture, interior design, room planner, home decor, apartment, living room, bedroom, shopping assistant, IKEA, Target, budget, fit check, floor plan, checkout

| | |
| --- | --- |
| Agent name | `tadaima` |
| Agent address | `agent1qdsuu2yjgd0tnddnu79rp8jxdu7zd9lkjgskxasptxukqrdlrv08szru3em` |
| Protocols | Agent Chat Protocol 0.3.0, Agent Payment Protocol 0.1.0 (seller), ASI:One interactive cards |
| Works with | `tadaima-scout` (live product research), `tadaima-fitcheck` (will it fit, will it get through the door) |

## Try it

- `hi` to set up your Tadaima account, your address and your room (what you own, budget, seats, style)
- `make the room $300 cheaper but keep my sofa and seating for four`
- `find a green rug under $150 that fits under the coffee table`
- `swap the armchair for something smaller`
- `put the floor lamp away`
- `how much am I spending and how many seats do I have?`
- `my rooms`, `new room`
- `check out`

## What happens

1. **Onboarding in chat.** Account, address and room setup are forms right in the conversation. Every room you make is saved to your account and comes back next time.
2. **Planning.** Whole-room goals become a proposal: each swap, cost before and after, seats, and any rule it can't verify, with a before/after floor plan. Nothing changes until you tap **Apply**. Stale approvals are refused by revision number.
3. **Finding pieces.** A search is measured at the exact spot in your room. Catalog matches come back at once; a live search of the stores keeps running and posts what it finds into the chat a few minutes later. Tap **Add to room** or **Swap it in**.
4. **Checking it fits.** Every change passes the same deterministic rules as the Tadaima web app and voice agent: inside the room, clearance around each piece, locked items kept, budget, seats, known sizes, in stock. Unknown is reported as unknown, never as a pass.
5. **Checkout.** A one-time service fee through the Fetch Payment Protocol (Stripe test mode), then a live price and stock recheck, then an approval card for the exact amount, stores and a 30 minute window. Only then does the agent pay, and you get an order card. In this build money is Stripe test mode and retailer orders are simulated, and both are labeled.

## How it works

```
ASI:One chat --Agent Chat Protocol--> tadaima (uAgents, mailbox)
   card clicks and forms -> fixed routing
   typed messages       -> Claude picks tools (room, propose, apply, search, place, move, store, cart)
   checkout             -> Payment Protocol fee -> recheck -> approval -> charge
   every tool           -> Tadaima backend (/api/projects, /api/agent): planner, rules, Browser Use, Stripe, Redis
   live research        -> tadaima-scout (TadaimaResearch protocol, paid per run in testnet FET)
   delivery fit         -> tadaima-fitcheck (TadaimaFitCheck protocol)
```

The agent never owns state of its own: plans, revisions, carts and orders live in the Tadaima backend shared with the web app and voice agent, so a change made in ASI:One is a real revision of your room.

## Run it

Python 3.12. From the repo root, with the Next.js backend running (`npm run dev`) or deployed:

```bash
cd backend/fetch
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # AGENT_SEED, BACKEND_URL, AGENT_API_KEY, ANTHROPIC_API_KEY, VIZ_SECRET, Stripe test keys
set -a && source .env && set +a
python agent.py
```

Connect the mailbox once, from the printed Agent Inspector link (Connect, then Mailbox) or with your Agentverse API key:

```bash
curl -X POST localhost:8001/connect -H 'content-type: application/json' \
  -d "{\"user_token\":\"$AGENTVERSE_API_KEY\",\"agent_type\":\"mailbox\"}"
```

## Limits

- Room shapes come from a prepared floor plan for the address; you confirm what you own, budget and seats.
- Payments are Stripe test mode (card 4242 4242 4242 4242). Retailer orders are simulated.
- Live store search takes a few minutes and covers IKEA and Target.
