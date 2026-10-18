# Tadaima room planner

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Furniture shopping agent for a real room. Tell it what you want in plain words ("keep the sofa and desk, make the room $300 cheaper, keep seating for four") and it proposes a whole-room plan that physically fits, stays under budget, keeps your locked items and keeps enough seats. You approve each change before it is saved, then review a cart of real retailer products with links.

**Keywords:** furniture, interior design, room planner, home decor, shopping assistant, budget, IKEA, Target, living room, apartment, cart review, fit check

| | |
| --- | --- |
| Agent name | `tadaima` |
| Agent address | `agent1qdsuu2yjgd0tnddnu79rp8jxdu7zd9lkjgskxasptxukqrdlrv08szru3em` |
| Agentverse profile | (fill in) |
| Protocols | Agent Chat Protocol 0.3.0, ASI:One interactive cards |

## What you can do in ASI:One

1. Say hi to see the room: what you own, what you'd buy, seats, budget and known cost, as a product carousel.
2. Ask for a change in plain language, or tap **Find a cheaper one** on a product.
3. Read the proposed diff (each swap, cost before and after, seats, any rule it can't verify) and tap **Apply** or **Try something else**.
4. Say **cart** for a per-merchant cart review with product links. Nothing is bought automatically.
5. **reset** puts your room back to the starting demo.

Each chat gets its own private copy of a synthetic 5.0 x 4.2 m demo living room. The agent doesn't invent prices or sizes: every change is checked by the same deterministic rules the web app uses (in room, clearance, locked items kept, budget, seats, sizes known, product available). Unknown sizes or prices are reported as unknown, never as a pass. Shipping, tax and assembly stay unknown until a real cart is observed.

## How it works

```
ASI:One chat → Agentverse mailbox → this agent (Python, uAgents)
            → Tadaima Next.js API /api/projects/{id}/...  (planner + rules + Redis)
```

The agent is a thin adapter. Planning (Claude), validation, revisions and pricing all live in `backend/plan` and are shared with the web app and the ElevenLabs voice agent, so a change made in ASI:One is a real revision of the canonical plan. Stale approvals are rejected by revision number.

## Run it

Python 3.12.

```bash
cd backend/fetch
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # set AGENT_SEED to a long random secret; BACKEND_URL; bypass secret if deployed
set -a && source .env && set +a
python agent.py
```

On first start it prints an Agent Inspector link. Open it, click **Connect**, choose **Mailbox**. The agent then shows up on [Agentverse](https://agentverse.ai). On its profile set the handle, avatar, description and keywords, then use **Chat with Agent** or @mention it in [ASI:One](https://asi1.ai).

To test against a local backend instead, run `npm run dev` from the repo root and set `BACKEND_URL=http://localhost:3000`. Proposals need `ANTHROPIC_API_KEY` in `.env.local`.

## Limits

- The room is the synthetic demo fixture. Photo attachments are acknowledged but not reconstructed in chat yet.
- Cart review lists the exact products and links; it does not place orders or take payment.
