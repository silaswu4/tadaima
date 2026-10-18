"""Conservative miter caps for simple equal-profile room-wall corners.

wall_join_slopes(wall, all_walls, openings) returns (startSlope, endSlope).
In the wall's Blender-local horizontal basis F=(dx,-dz)/length and
N=(-F.y,F.x), the caps are u=startSlope*v and u=length+endSlope*v.
The helper consumes already validated geometry, does no Blender work, and
falls back to ordinary perpendicular butt caps (slope 0) at ambiguous joints.

Only degree-two, non-collinear, equal-height/thickness corners are supported.
Openings reaching either participant's endpoint disable that shared miter.
The standard miter ratio is capped at four. A conservative half-length guard
also keeps both end caps from crossing on short wall segments. This is shell
visualization geometry, not a general CAD wall-junction solver.
"""

from __future__ import annotations

import math

from reconstruction.geometry import EPS, wall_cells

MITER_LIMIT = 4.0


def _length(wall):
    return math.hypot(wall["end"][0] - wall["start"][0], wall["end"][1] - wall["start"][1])


def _near(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1]) <= EPS


def _basis(wall):
    length = _length(wall)
    forward = ((wall["end"][0] - wall["start"][0]) / length,
               -(wall["end"][1] - wall["start"][1]) / length)
    normal = (-forward[1], forward[0])
    return forward, normal


def _on_interior(point, wall):
    a, b = wall["start"], wall["end"]
    dx, dz = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dz)
    if length <= EPS:
        return False
    along = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length
    cross = dx * (point[1] - a[1]) - dz * (point[0] - a[0])
    return EPS < along < length - EPS and abs(cross) <= EPS * max(1, length)


def _partner(wall, at_start, all_walls):
    point = wall["start"] if at_start else wall["end"]
    matches = []
    for candidate in all_walls:
        if candidate["id"] == wall["id"]:
            continue
        # A through-wall at the same point makes this a T/cross junction even
        # when that wall is not explicitly split at the intersection.
        if _on_interior(point, candidate):
            return None
        if _near(point, candidate["start"]):
            matches.append((candidate, True))
        elif _near(point, candidate["end"]):
            matches.append((candidate, False))
    return matches[0] if len(matches) == 1 else None


def _cap_slope(wall, at_start, other, other_at_start):
    forward, normal = _basis(wall)
    other_forward, _ = _basis(other)
    own_sign = 1 if at_start else -1
    other_sign = 1 if other_at_start else -1
    outward = (own_sign * forward[0] + other_sign * other_forward[0],
               own_sign * forward[1] + other_sign * other_forward[1])
    denominator = outward[0] * normal[0] + outward[1] * normal[1]
    if abs(denominator) <= EPS:
        return None
    return (outward[0] * forward[0] + outward[1] * forward[1]) / denominator


def _endpoint_clearance(wall, at_start, openings):
    length = _length(wall)
    own_openings = [item for item in openings if item["wallId"] == wall["id"]]
    for opening in own_openings:
        if at_start and opening["offset"] <= EPS:
            return 0.0
        if not at_start and opening["offset"] + opening["width"] >= length - EPS:
            return 0.0
    cells = wall_cells(wall, own_openings)
    if at_start:
        widths = [cell["u1"] - cell["u0"] for cell in cells if abs(cell["u0"]) <= EPS]
    else:
        widths = [cell["u1"] - cell["u0"] for cell in cells if abs(cell["u1"] - length) <= EPS]
    return min(widths, default=0.0)


def _safe(wall, at_start, slope, openings):
    if slope is None or not math.isfinite(slope) or math.hypot(1, slope) > MITER_LIMIT:
        return False
    clearance = _endpoint_clearance(wall, at_start, openings)
    displacement = abs(slope) * wall["thickness"] / 2
    return displacement < min(clearance, _length(wall) / 2) - EPS


def wall_join_slopes(wall: dict, all_walls: list[dict], openings: list[dict]) -> tuple[float, float]:
    """Return conservative start/end miter slopes for a validated wall.

    Each decision checks both participants, so either both use a matching
    miter plane or both retain their original butt cap. No input is mutated.
    """
    slopes = []
    for at_start in (True, False):
        partner = _partner(wall, at_start, all_walls)
        slope = 0.0
        if partner is not None:
            other, other_at_start = partner
            if (abs(wall["thickness"] - other["thickness"]) <= EPS
                    and abs(wall["height"] - other["height"]) <= EPS):
                own_slope = _cap_slope(wall, at_start, other, other_at_start)
                other_slope = _cap_slope(other, other_at_start, wall, at_start)
                if (_safe(wall, at_start, own_slope, openings)
                        and _safe(other, other_at_start, other_slope, openings)):
                    slope = own_slope
        slopes.append(slope)
    return tuple(slopes)
