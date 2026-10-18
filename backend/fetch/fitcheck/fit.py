"""
Will it fit? Pure, deterministic geometry. No I/O, no LLM.

Sizes are meters. A piece is [width, height, depth] like backend/contracts.ts:
width runs along the wall, depth sticks out into the room, height is up.

Three checks, each yes / no / unknown, combined worst-first (no > unknown > yes):

1. Space: the w x d footprint inside space_w x space_d, as given or turned
   90 degrees. A fit is "tight" unless the open front (depth) has at least
   `clearance` m to walk past; side gaps against walls are reported, not required.
   Only a wall width given: width along the wall is checked, depth is not.
2. Ceiling: height under the ceiling.
3. Door: carried straight through an opening dw x dh. One of the piece's three
   dimensions goes through the doorway; the other two form the cross-section.
   For each choice of that through-dimension the cross-section must fit the
   door rectangle either square-on (in some assignment of its sides) or tilted
   corner to corner (the exact rectangle-in-rectangle test, Carver 1956), which
   is how a long thin piece slips past the door diagonal. The piece is a solid
   box: no credit for curved backs, hooking a sofa around the frame, or a
   hallway turn, so a "no" can be beaten by a good mover but a "yes" is real.
   Turns and stairs before or after the door are not checked.

Anything within MARGIN of its limit is "unknown" (listed sizes are rounded and
door frames, trims and carpets eat centimeters). A door miss that legs coming
off would fix is "unknown" too. Never a "yes" we can't stand behind.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

MARGIN = 0.02  # within 2 cm of a limit is too close to call
DEFAULT_CLEARANCE = 0.3  # same default as the web app's plan constraints
LEG_ALLOWANCE = 0.12  # how much height removable legs usually give back

ORDER = {"no": 0, "unknown": 1, "yes": 2}


@dataclass
class Check:
    name: str
    verdict: str
    reason: str


@dataclass
class Result:
    fits: str  # "yes" | "no" | "unknown"
    reasons: list[str]
    orientation: str | None = None  # how to place it in the space
    door_orientation: str | None = None  # how to carry it through the door
    checks: list[Check] = field(default_factory=list)
    tight: bool = False  # fits, but less than the clearance in front


def m(x: float) -> str:
    return f"{x:.2f} m"


def cm(x: float) -> str:
    return f"{x * 100:.0f} cm"


def _pos(x) -> float | None:
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if x > 0 and math.isfinite(x) else None


def _worst(verdicts: list[str]) -> str:
    return min(verdicts, key=ORDER.__getitem__) if verdicts else "unknown"


# ---------- space and ceiling ----------


def _slack_verdict(slack: float) -> str:
    if abs(slack) < MARGIN:
        return "unknown"
    return "yes" if slack > 0 else "no"


def check_space(w: float, d: float, space_w: float, space_d: float | None, clearance: float) -> tuple[Check, str | None, bool]:
    """Returns (check, best orientation, tight)."""
    if space_d is None:
        slack = space_w - w
        v = _slack_verdict(slack)
        if v == "yes":
            return Check("space", "yes", f"{m(w)} wide on a {m(space_w)} wall leaves {cm(slack)} to spare. I didn't check how far it sticks out ({m(d)} deep)."), "as listed", False
        if v == "unknown":
            return Check("space", "unknown", f"{m(w)} wide on a {m(space_w)} wall is within {cm(MARGIN)}, too close to call. Measure the wall at floor height."), None, False
        if d < space_w - MARGIN:
            return Check("space", "unknown", f"{m(w)} wide, your wall is {m(space_w)}. Turned sideways it would fit along the wall, but then it sticks out {m(w)} and I don't know the room depth."), None, False
        return Check("space", "no", f"{m(w)} wide, your wall is {m(space_w)}, {cm(w - space_w)} too long. Turned sideways it's still {m(d)}."), None, False

    options = []
    for label, along, out in (("as listed", w, d), ("turned 90 degrees", d, w)):
        sw, sd = space_w - along, space_d - out
        options.append((label, along, out, sw, sd, _worst([_slack_verdict(sw), _slack_verdict(sd)])))
    # prefer a clear fit, then one with walking room in front, then the listed way
    best = max(options, key=lambda o: (ORDER[o[5]], o[4] >= clearance, o[0] == "as listed"))
    label, along, out, sw, sd, v = best
    if v == "yes":
        tight = sd < clearance
        front = f"{cm(sd)} in front" + (f", less than the {cm(clearance)} you'd want to walk past" if tight else "")
        if label == "as listed":
            return Check("space", "yes", f"{m(w)} wide, {m(d)} deep in a {m(space_w)} x {m(space_d)} space: {cm(sw)} to spare across, {front}."), label, tight
        only = "It only fits turned 90 degrees" if options[0][5] != "yes" else "Turned 90 degrees it fits best"
        return Check("space", "yes", f"{only}: {m(along)} along the {m(space_w)} side and {m(out)} into the {m(space_d)}, {cm(sw)} to spare across, {front}."), label, tight
    if v == "unknown":
        return Check("space", "unknown", f"{m(along)} x {m(out)} in a {m(space_w)} x {m(space_d)} space is within {cm(MARGIN)} of a wall. Too close to call, measure again."), None, False
    listed = options[0]
    over = []
    if listed[3] < 0:
        over.append(f"{m(w)} wide, your space is {m(space_w)}")
    if listed[4] < 0:
        over.append(f"{m(d)} deep, your space is {m(space_d)}")
    return Check("space", "no", "It's " + " and ".join(over) + ". Turned 90 degrees it doesn't fit either."), None, False


def check_ceiling(h: float, ceiling: float) -> Check:
    slack = ceiling - h
    v = _slack_verdict(slack)
    if v == "yes":
        return Check("ceiling", "yes", f"{m(h)} tall under a {m(ceiling)} ceiling.")
    if v == "unknown":
        return Check("ceiling", "unknown", f"{m(h)} tall under a {m(ceiling)} ceiling is within {cm(MARGIN)}. Too close to call, and you'd need room to tip it upright.")
    return Check("ceiling", "no", f"{m(h)} tall, your ceiling is {m(ceiling)}.")


# ---------- door ----------


def rect_fits(a: float, b: float, p: float, q: float) -> tuple[float, str]:
    """
    Does an a x b rectangle fit in a p x q rectangle? Returns (slack, how):
    slack > 0 fits, < 0 doesn't, both in meters (the worst side's spare room,
    or for the tilted case how much wider the door would need to be, signed).
    """
    L, S = max(a, b), min(a, b)
    Q, P = max(p, q), min(p, q)
    straight = min(P - S, Q - L)
    if straight >= 0 or L <= Q:
        return straight, "straight"
    # long side beats the door's long side: only corner to corner can work (Carver)
    if S > P:
        return straight, "straight"
    need = (2 * L * S * Q + (L * L - S * S) * math.sqrt(L * L + S * S - Q * Q)) / (L * L + S * S)
    return P - need, "tilted"


def _door_options(w: float, h: float, d: float, door_w: float, door_h: float) -> list[tuple[float, str, str]]:
    dims = {"width": w, "height": h, "depth": d}
    out = []
    for through in dims:
        a, b = (v for k, v in dims.items() if k != through)
        slack, how = rect_fits(a, b, door_w, door_h)
        out.append((slack, how, through))
    return out


def _best(options: list[tuple[float, str, str]]) -> tuple[float, str, str]:
    # a clear pass wins, square-on before tilted; otherwise the nearest miss
    return max(options, key=lambda o: (o[0] >= MARGIN, o[1] == "straight", o[0]))


def check_door(w: float, h: float, d: float, door_w: float, door_h: float) -> tuple[Check, str | None]:
    slack, how, through = _best(_door_options(w, h, d, door_w, door_h))
    door = f"{cm(door_w)} x {cm(door_h)} door"
    way = {"width": "end first", "depth": "back first", "height": "on its back, top first"}[through]
    if slack >= MARGIN:
        if how == "tilted":
            return Check("door", "yes", f"Through the {door} only tilted corner to corner, {way}. Expect it to be fiddly."), f"tilted, {way}"
        return Check("door", "yes", f"Through the {door} {way}, with {cm(slack)} to spare."), way
    if slack > -MARGIN:
        return Check("door", "unknown", f"Through the {door} it's within {cm(MARGIN)}. Too close to call, measure the opening inside the frame."), None
    if h > 2 * LEG_ALLOWANCE and _best(_door_options(w, h - LEG_ALLOWANCE, d, door_w, door_h))[0] >= MARGIN:
        return Check("door", "unknown", f"As a solid box it won't go through the {door}, short by {cm(-slack)}. It might with the legs off (about {cm(LEG_ALLOWANCE)}), check the listing."), None
    s = sorted((w, h, d))
    return Check("door", "no", f"Its two smallest sides are {m(s[0])} and {m(s[1])}, your door opening is {m(door_w)} x {m(door_h)}. No way through, even tilted."), None


# ---------- all together ----------


def check(
    dims_wdh: list[float] | None,
    space_w: float | None = None,
    space_d: float | None = None,
    ceiling: float | None = None,
    door_w: float | None = None,
    door_h: float | None = None,
    clearance: float | None = DEFAULT_CLEARANCE,
) -> Result:
    dims = [_pos(x) for x in (dims_wdh or [])]
    space_w, space_d, ceiling, door_w, door_h = map(_pos, (space_w, space_d, ceiling, door_w, door_h))
    clearance = clearance if clearance is not None and clearance >= 0 else DEFAULT_CLEARANCE
    if len(dims) != 3 or not dims[0] or not dims[2]:
        return Result("unknown", ["I need the piece's width and depth (and height for doors and ceilings)."])
    w, h, d = dims
    checks: list[Check] = []
    missing: list[str] = []
    orientation, door_orientation, tight = None, None, False

    if space_w:
        c, orientation, tight = check_space(w, d, space_w, space_d, clearance)
        checks.append(c)
    if ceiling:
        checks.append(check_ceiling(h, ceiling) if h else Check("ceiling", "unknown", "I need its height to check the ceiling."))
    if door_w and door_h:
        if h:
            c, door_orientation = check_door(w, h, d, door_w, door_h)
            checks.append(c)
        else:
            checks.append(Check("door", "unknown", "I need its height to check the door."))
    elif door_w or door_h:
        missing.append("both the door's width and height")

    if not checks:
        return Result("unknown", ["Tell me the space: the wall or floor area it goes in, the ceiling, or the door it comes through."])
    fits = _worst([c.verdict for c in checks])
    reasons = [c.reason for c in sorted(checks, key=lambda c: ORDER[c.verdict])]
    if missing:
        reasons.append(f"I skipped the door check, I need {missing[0]}.")
    if any(c.name == "door" and c.verdict == "yes" for c in checks):
        reasons.append("That's the doorway itself; tight hallway turns and stairs aren't checked.")
    return Result(fits, reasons, orientation, door_orientation, checks, tight)
