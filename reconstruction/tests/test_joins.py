"""Miter geometry checks independent of Blender."""

import copy
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from reconstruction.joins import wall_join_slopes


def wall(ident, start, end, thickness=0.2, height=2.8):
    return {"id": ident, "start": list(start), "end": list(end),
            "thickness": thickness, "height": height, "evidenceIds": []}


def rectangle():
    points = [[0, 0], [5, 0], [5, 4], [0, 4]]
    return [wall(f"wall_{i}", p, points[(i + 1) % 4]) for i, p in enumerate(points)]


def cap_points(item, slope, at_start):
    dx, dz = item["end"][0] - item["start"][0], item["end"][1] - item["start"][1]
    length = math.hypot(dx, dz)
    f = (dx / length, -dz / length)
    n = (-f[1], f[0])
    points = []
    for v in (-item["thickness"] / 2, item["thickness"] / 2):
        u = (0 if at_start else length) + slope * v
        points.append((item["start"][0] + u * f[0] + v * n[0],
                       -item["start"][1] + u * f[1] + v * n[1]))
    return sorted(points)


class JoinTests(unittest.TestCase):
    def assertPointsMatch(self, first, second):
        for a, b in zip(first, second):
            for x, y in zip(a, b):
                self.assertAlmostEqual(x, y, places=7)

    def test_rectangle_cap_planes_match_and_fill_outer_corner(self):
        walls = rectangle()
        for index, item in enumerate(walls):
            own = wall_join_slopes(item, walls, [])
            other = walls[(index + 1) % 4]
            other_slopes = wall_join_slopes(other, walls, [])
            self.assertAlmostEqual(own[0], -1)
            self.assertAlmostEqual(own[1], 1)
            self.assertPointsMatch(cap_points(item, own[1], False), cap_points(other, other_slopes[0], True))
        start = cap_points(walls[0], wall_join_slopes(walls[0], walls, [])[0], True)
        self.assertPointsMatch(start, [(-0.1, 0.1), (0.1, -0.1)])

    def test_rotated_negative_coordinate_room_and_reversed_wall_directions(self):
        walls = rectangle()
        angle = 0.63
        for item in walls:
            for key in ("start", "end"):
                x, z = item[key]
                item[key] = [-8 + x * math.cos(angle) - z * math.sin(angle),
                             -11 + x * math.sin(angle) + z * math.cos(angle)]
        for index, item in enumerate(walls):
            other = walls[(index + 1) % 4]
            slopes = wall_join_slopes(item, walls, [])
            next_slopes = wall_join_slopes(other, walls, [])
            self.assertPointsMatch(cap_points(item, slopes[1], False), cap_points(other, next_slopes[0], True))
        for item in walls:
            item["start"], item["end"] = item["end"], item["start"]
        for index, item in enumerate(walls):
            other = walls[(index + 1) % 4]
            slopes = wall_join_slopes(item, walls, [])
            next_slopes = wall_join_slopes(other, walls, [])
            self.assertPointsMatch(cap_points(item, slopes[0], True), cap_points(other, next_slopes[1], False))

    def test_collinear_and_isolated_walls_use_butt_caps(self):
        first = wall("first", [0, 0], [2, 0])
        second = wall("second", [2, 0], [5, 0])
        self.assertEqual(wall_join_slopes(first, [first], []), (0, 0))
        self.assertEqual(wall_join_slopes(first, [first, second], []), (0, 0))

    def test_t_junction_and_three_endpoint_junction_fall_back(self):
        stem = wall("stem", [2, 0], [2, 2])
        base = wall("base", [0, 0], [4, 0])
        self.assertEqual(wall_join_slopes(stem, [stem, base], []), (0, 0))
        first = wall("first", [0, 0], [4, 0])
        up = wall("up", [4, 0], [4, 4])
        down = wall("down", [4, 0], [4, -4])
        self.assertEqual(wall_join_slopes(first, [first, up, down], []), (0, 0))

    def test_mismatched_profiles_fall_back(self):
        first = wall("first", [0, 0], [5, 0])
        for thickness, height in ((0.3, 2.8), (0.2, 3.0)):
            other = wall("other", [5, 0], [5, 4], thickness, height)
            self.assertEqual(wall_join_slopes(first, [first, other], []), (0, 0))

    def test_endpoint_aperture_disables_both_participants(self):
        walls = rectangle()
        openings = [{"id": "door", "wallId": "wall_1", "kind": "door", "offset": 0,
                     "width": 0.9, "height": 2.1, "sillHeight": 0, "evidenceIds": []}]
        self.assertEqual(wall_join_slopes(walls[0], walls, openings)[1], 0)
        self.assertEqual(wall_join_slopes(walls[1], walls, openings)[0], 0)
        self.assertNotEqual(wall_join_slopes(walls[0], walls, openings)[0], 0)

    def test_near_endpoint_grid_guard_disables_both(self):
        walls = rectangle()
        openings = [{"id": "door", "wallId": "wall_1", "kind": "door", "offset": 0.05,
                     "width": 0.9, "height": 2.1, "sillHeight": 0, "evidenceIds": []}]
        self.assertEqual(wall_join_slopes(walls[0], walls, openings)[1], 0)
        self.assertEqual(wall_join_slopes(walls[1], walls, openings)[0], 0)

    def test_sharp_angle_exceeds_miter_limit(self):
        first = wall("first", [0, 0], [5, 0])
        angle = math.radians(10)
        other = wall("other", [5, 0], [5 - 4 * math.cos(angle), 4 * math.sin(angle)])
        self.assertEqual(wall_join_slopes(first, [first, other], []), (0, 0))

    def test_short_wall_guard_prevents_crossing_end_caps(self):
        walls = rectangle()
        for item in walls:
            for key in ("start", "end"):
                if item[key][0] == 5:
                    item[key][0] = 0.15
        self.assertEqual(wall_join_slopes(walls[0], walls, []), (0, 0))

    def test_deterministic_and_nonmutating(self):
        walls = rectangle()
        before = copy.deepcopy(walls)
        result = wall_join_slopes(walls[0], walls, [])
        self.assertEqual(result, wall_join_slopes(walls[0], list(reversed(walls)), []))
        self.assertEqual(walls, before)


if __name__ == "__main__":
    unittest.main()
