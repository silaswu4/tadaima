# Fit Check

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Will this furniture fit? Tell Fit Check the piece and the space and it tells you yes, no, or "too close to call", with the numbers: whether it fits the wall or floor space (either way round), clears the ceiling, and gets through the door, tilted if it has to.

**Keywords:** furniture, will it fit, measurements, sofa, couch, bed, bookcase, door, doorway, delivery, moving, apartment, room size, ceiling height, interior design, home, IKEA, Target

| | |
| --- | --- |
| Agent name | `tadaima-fitcheck` |
| Agent address | `agent1qw8a0tffhe420xzu7ultv2naf8k80dkwndq79pnn2ha84v0aam906uprl6v` |
| Protocols | Agent Chat Protocol 0.3.0, TadaimaFitCheck 0.1.0 |
| Part of | Tadaima (room planner) |

## What to ask

- *Will a 2.1 x 0.9 m sofa fit on a 2.4 m wall? The door is 80 x 200 cm.*
- *84" x 38" x 34" couch, 8 ft wall, front door 36 x 80 in.*
- *Bookcase 80 x 30 x 245 cm, my ceilings are 8 feet.*
- Paste a product link and your space. If it can't read the size from the link it asks you for it.

Sizes can be in cm, mm, m, inches or feet. Width is along the wall, depth sticks out into the room. If something's missing you get one short form to fill in. Each answer comes with a summary card: the numbers, each check, which way to place it and how to carry it in.

## How it decides

Claude only reads your message into numbers. The verdict comes from `fit.py`, plain deterministic geometry with tests (`python test_fit.py`):

- **Space:** the footprint inside the space as listed or turned 90 degrees. It says "tight" when there's less than 30 cm in front to walk past.
- **Ceiling:** height under the ceiling.
- **Door:** treated as a solid box carried straight through. One side goes through the doorway and the other two must fit the opening, square-on or tilted corner to corner (exact rectangle-in-rectangle test).
- **Too close to call:** anything within 2 cm of a limit. A door that would only work with the legs off is also "too close to call". It never says yes when it isn't sure.

Limits: it doesn't check hallway turns, stairs, or the trick of hooking a sofa's back around the door frame, so a "no" at the door might still be doable by experienced movers. It doesn't know about door stops, hinges or trim unless you measure the clear opening.

## For agents

Send `FitRequest` and get back one `FitVerdict` with the same `request_id`. Both are defined in `backend/fetch/protocols.py`. It's free. Sizes are meters, `[width, height, depth]`.

```python
from protocols import FitRequest, FitVerdict

reply, status = await ctx.send_and_receive(
    FITCHECK_ADDRESS,
    FitRequest(request_id=rid, dimensions_wdh_m=[2.1, 0.85, 0.9], space_width_m=2.4, door_width_m=0.8, door_height_m=2.0),
    response_type=FitVerdict,
    timeout=30,
)
```

## Run it

```bash
cd backend/fetch/fitcheck
cp .env.example .env   # FITCHECK_SEED: long random secret; ANTHROPIC_API_KEY
set -a && source .env && set +a
python agent.py        # port 8003
```

Then connect the mailbox from the Agent Inspector link it prints (or POST `/connect` on port 8003 with your Agentverse key).

Product links: set `SCOUT_ADDRESS` and, once `backend/fetch/scout_client.py` is on this branch, Fit Check hires the Scout agent to measure the page (Scout charges a small testnet FET fee from this agent's wallet, capped by `SCOUT_MAX_FET`). Without either it just asks for the size.

Tests: `python test_fit.py` (geometry), `python harness.py` (chat and FitRequest handlers with a fake ctx, real Claude parsing), `FITCHECK_ADDRESS=agent1q... python probe.py` (a throwaway local agent sends real FitRequests to the running agent).
