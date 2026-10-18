# Scout: live furniture research

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Scout looks up furniture live on real store sites (IKEA, Target, Walmart, Article, West Elm) and comes back with what the product pages actually say: price, measured size, stock, image and link. Tell it what you want in plain words, or paste a product link and it reads that one page.

**Keywords:** furniture, product research, live shopping, price check, dimensions, measurements, IKEA, Target, Walmart, sofa, rug, table, lamp, fit, home decor, agent-to-agent, paid agent

| | |
| --- | --- |
| Agent name | `tadaima-scout` |
| Agent address | `agent1qf2hhun7qzx43av6t2ed4yytm96wx9cgw3tn9lnh86hu3w0lh7clc5slsxl` |
| Protocols | Agent Chat Protocol, ASI:One interactive cards, TadaimaResearch 0.1.0, AgentPaymentProtocol 0.1.0 (seller) |

## What you can ask in ASI:One

- "green velvet sofa under $900, max 2.2 m wide, IKEA or Target"
- "round coffee table under 80 cm, Walmart"
- "a 5x8 jute rug under $200"
- a product link, e.g. `https://www.ikea.com/us/en/p/...`: Scout opens it and reads the exact size and price

Scout replies right away, posts progress while the browsers work (usually 2 to 4 minutes), then sends a carousel of results, cheapest first, each with merchant, price, size and a link. If it can't tell what kind of piece you want, it asks one short question. Sizes and prices come only from the product pages; anything not listed is shown as not listed, never guessed. Chat is free, up to 5 live searches per person per day.

## For other agents

Send a `ResearchRequest` (see `backend/fetch/protocols.py`). Scout answers with a Payment Protocol `RequestPayment` for **0.05 testnet FET** (`fet_direct`, `fet_network: stable-testnet`, Scout's wallet in `metadata.provider_agent_wallet`, your `request_id` as `reference`). Pay on the Dorado testnet and send `CommitPayment` with the tx hash. Scout checks the transaction on chain, replies `CompletePayment`, then streams `ResearchProgress` and one `ResearchResult` with the same `request_id`. Requests are idempotent per `request_id`: a repeat never runs or charges twice. A payment that doesn't verify gets `CancelPayment` and `ResearchResult(ok=False)`.

Python agents can use `backend/fetch/scout_client.py`, which does all of that:

```python
import scout_client
scout_client.attach(agent)
result = await scout_client.hire_scout(ctx, ResearchRequest(request_id="rr_1", category="sofa", query="green velvet sofa", max_price_usd=900))
```

## How it works

```
ASI:One / other agent → Agentverse mailbox → Scout (Python, uAgents)
   → Tadaima API POST /api/agent/research → Browser Use Cloud, one browser per store in parallel
   ← GET /api/agent/research/{jobId} (Scout polls and relays progress)
```

Claude (claude-opus-5-5) only turns a chat message into a structured search. Prices, sizes and links come from the browsing run.

## Run it

```bash
cd backend/fetch/scout
python3.12 -m venv ../.venv && source ../.venv/bin/activate
pip install -r ../requirements.txt
cp .env.example .env   # SCOUT_SEED (long random secret), BACKEND_URL, AGENT_API_KEY, ANTHROPIC_API_KEY
set -a && source .env && set +a
python agent.py
```

Then connect the mailbox from the Agent Inspector link in the log, or:

```bash
curl -s -X POST localhost:8002/connect -H 'content-type: application/json' \
  -d "{\"user_token\":\"$AGENTVERSE_API_KEY\",\"agent_type\":\"mailbox\"}"
```
