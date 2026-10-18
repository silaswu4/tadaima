"""Geometry-derived cloudy daylight; no location, compass or sun inference.

Positions and directions use the application's right-handed Y-up meters.
The point-in-polygon probes deliberately avoid bounding-box center heuristics,
which incorrectly classify concave rooms and walls shared by two rooms.
"""

import math

from reconstruction.geometry import _strict_inside

MAX_WINDOW_LIGHTS = 12


def daylight_plan(geometry, *, max_windows=MAX_WINDOW_LIGHTS):
    if not isinstance(max_windows, int) or isinstance(max_windows, bool) or not 1 <= max_windows <= MAX_WINDOW_LIGHTS:
        raise ValueError("max_windows must be between 1 and 12")
    walls = {wall["id"]: wall for wall in geometry["walls"]}
    windows, interior, unknown = [], [], []
    for opening in geometry["openings"]:
        if opening["kind"] != "window":
            continue
        wall = walls[opening["wallId"]]
        dx = wall["end"][0] - wall["start"][0]
        dz = wall["end"][1] - wall["start"][1]
        length = math.hypot(dx, dz)
        tangent = (dx / length, dz / length)
        normal = (-tangent[1], tangent[0])
        distance = opening["offset"] + opening["width"] / 2
        center2 = [wall["start"][i] + tangent[i] * distance for i in range(2)]
        epsilon = min(.001, length * .0001, opening["width"] * .0001)
        sides = [any(_strict_inside([center2[i] + sign * normal[i] * epsilon for i in range(2)], room["floorPolygon"])
                     for room in geometry["rooms"]) for sign in (1, -1)]
        if sides == [True, True]:
            interior.append(opening["id"])
            continue
        if sides == [False, False]:
            unknown.append(opening["id"])
            continue
        sign = 1 if sides[0] else -1
        inward = [sign * normal[0], 0, sign * normal[1]]
        center = [center2[0], opening["sillHeight"] + opening["height"] / 2, center2[1]]
        stand_off = wall["thickness"] / 2 + .02
        windows.append({"openingId": opening["id"], "wallId": wall["id"],
                        "center": center, "inward": inward,
                        "position": [center[i] - inward[i] * stand_off for i in range(3)],
                        "width": opening["width"], "height": opening["height"]})
    windows.sort(key=lambda item: (-item["width"] * item["height"], item["openingId"]))
    return {"mode": "window_daylight" if windows else "studio_fallback",
            "assumption": "Soft cloudy daylight through exterior openings; brightness is a presentation estimate, not measured illumination or a geolocated sun.",
            "windows": windows[:max_windows],
            "omittedWindowIds": [item["openingId"] for item in windows[max_windows:]],
            "skippedInteriorWindowIds": sorted(interior), "unclassifiedWindowIds": sorted(unknown)}
