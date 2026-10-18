"""Pure geometry regression tests; run without Blender using unittest discover."""

import copy
import math
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from geometry import GeometryError, signed_area, triangulate_polygon, validate_request, wall_cells


def rectangle_request():
    polygon = [[0, 0], [5, 0], [5, 4], [0, 4]]
    return {
        "jobId": "job_test", "projectId": "project_test", "inputRevision": 1,
        "geometry": {
            "units": "m", "coordinateSystem": "right-handed-y-up",
            "rooms": [{"id": "room_test", "label": "Synthetic test room", "floorPolygon": polygon,
                       "height": 2.8, "evidenceIds": ["evidence_test"]}],
            "walls": [{"id": f"wall_{i}", "start": a[:], "end": polygon[(i + 1) % 4][:],
                       "height": 2.8, "thickness": 0.15, "evidenceIds": ["evidence_test"]}
                      for i, a in enumerate(polygon)],
            "openings": [opening("door", "wall_0", "door", 1, 0.9, 2.1, 0),
                         opening("window", "wall_2", "window", 1.5, 1.4, 1.2, 0.8)],
        },
        "evidence": [{"id": "evidence_test", "sourceUrl": None, "privateAssetId": None,
                      "observedAt": "2026-10-17T12:00:00Z", "claim": "Synthetic fixture, not measured.",
                      "dimensionStatus": "inferred", "confirmedByUserAt": "2026-10-17T12:00:00Z"}],
    }


def opening(ident, wall, kind, offset, width, height, sill):
    return {"id": ident, "wallId": wall, "kind": kind, "offset": offset, "width": width,
            "height": height, "sillHeight": sill, "evidenceIds": ["evidence_test"]}


class RequestValidationTests(unittest.TestCase):
    def setUp(self):
        self.request = rectangle_request()

    def test_valid_fixture_is_normalized_without_mutating_input(self):
        original = copy.deepcopy(self.request)
        result = validate_request(self.request)
        self.assertEqual(result, original)
        self.assertIsNot(result, self.request)
        self.assertIsNot(result["geometry"], self.request["geometry"])
        self.assertIsInstance(result["geometry"]["rooms"][0]["height"], float)
        self.assertEqual(self.request, original)

    def test_explicit_closure_is_removed(self):
        points = self.request["geometry"]["rooms"][0]["floorPolygon"]
        points.append(points[0][:])
        self.assertEqual(len(validate_request(self.request)["geometry"]["rooms"][0]["floorPolygon"]), 4)

    def test_rejects_nonfinite_bool_and_huge_numbers(self):
        for value in (True, False, float("nan"), float("inf"), -float("inf"), 10**400, "2.8", 0, -1):
            with self.subTest(value=repr(value)[:80]):
                self.request["geometry"]["rooms"][0]["height"] = value
                with self.assertRaises(GeometryError):
                    validate_request(self.request)

    def test_rejects_bad_revision(self):
        for value in (-1, True, 1.2, "1", 9_007_199_254_740_992):
            with self.subTest(value=value):
                self.request["inputRevision"] = value
                with self.assertRaises(GeometryError):
                    validate_request(self.request)

    def test_rejects_path_like_or_unicode_ids(self):
        for value in ("../job", "a/b", "a\\b", "..", "é", "job space", "x" * 65, ""):
            with self.subTest(value=value):
                self.request["jobId"] = value
                with self.assertRaises(GeometryError):
                    validate_request(self.request)

    def test_rejects_unknown_schema_fields(self):
        self.request["geometry"]["fixedFixtures"] = []
        with self.assertRaisesRegex(GeometryError, "unsupported fields: fixedFixtures"):
            validate_request(self.request)

    def test_rejects_unknown_or_duplicate_evidence(self):
        self.request["geometry"]["rooms"][0]["evidenceIds"] = ["not_found"]
        with self.assertRaisesRegex(GeometryError, "unknown evidence"):
            validate_request(self.request)
        self.request["geometry"]["rooms"][0]["evidenceIds"] = ["evidence_test", "evidence_test"]
        with self.assertRaisesRegex(GeometryError, "duplicate evidence"):
            validate_request(self.request)
        self.request["geometry"]["rooms"][0]["evidenceIds"] = []
        self.request["evidence"].append(copy.deepcopy(self.request["evidence"][0]))
        with self.assertRaisesRegex(GeometryError, "duplicate evidence"):
            validate_request(self.request)

    def test_rejects_invalid_evidence_timestamp(self):
        self.request["evidence"][0]["observedAt"] = "2026-10-17"
        with self.assertRaisesRegex(GeometryError, "timezone"):
            validate_request(self.request)

    def test_rejects_wrong_coordinate_conventions(self):
        self.request["geometry"]["coordinateSystem"] = "z-up"
        with self.assertRaisesRegex(GeometryError, "right-handed-y-up"):
            validate_request(self.request)

    def test_rejects_nonfinite_or_excessive_coordinates(self):
        for value in (True, float("nan"), float("inf"), 10_001):
            with self.subTest(value=value):
                request = rectangle_request()
                request["geometry"]["rooms"][0]["floorPolygon"][0][0] = value
                with self.assertRaises(GeometryError):
                    validate_request(request)

    def test_rejects_duplicate_cross_element_ids(self):
        self.request["geometry"]["walls"][0]["id"] = "room_test"
        with self.assertRaisesRegex(GeometryError, "duplicate room/wall/opening"):
            validate_request(self.request)

    def test_rejects_missing_boundary_wall(self):
        self.request["geometry"]["walls"].pop()
        with self.assertRaisesRegex(GeometryError, "missing wall coverage"):
            validate_request(self.request)

    def test_rejects_interior_partition_and_diagonal_boundary_chord(self):
        self.request["geometry"]["walls"].append({"id": "partition", "start": [0, 0], "end": [5, 4],
            "height": 2.8, "thickness": 0.15, "evidenceIds": []})
        with self.assertRaisesRegex(GeometryError, "must follow a room boundary"):
            validate_request(self.request)

    def test_rejects_duplicate_partial_wall(self):
        wall = copy.deepcopy(self.request["geometry"]["walls"][0])
        wall.update(id="duplicate_wall", start=[0.5, 0], end=[1.5, 0])
        self.request["geometry"]["walls"].append(wall)
        with self.assertRaisesRegex(GeometryError, "overlaps wall"):
            validate_request(self.request)

    def test_accepts_split_boundary_wall(self):
        wall = self.request["geometry"]["walls"][0]
        wall["end"] = [2.5, 0]
        rest = copy.deepcopy(wall)
        rest.update(id="wall_0_rest", start=[2.5, 0], end=[5, 0])
        self.request["geometry"]["walls"].append(rest)
        self.assertEqual(len(validate_request(self.request)["geometry"]["walls"]), 5)

    def test_rejects_zero_length_wall(self):
        self.request["geometry"]["walls"][0]["end"] = [0, 0]
        with self.assertRaisesRegex(GeometryError, "zero-length wall"):
            validate_request(self.request)

    def test_opening_errors(self):
        for field, value, message in (("wallId", "missing_wall", "unknown parent"),
                ("kind", "archway", "unsupported opening"), ("offset", -0.1, "range"),
                ("offset", 4.5, "wall length"), ("sillHeight", 1, "above wall height"),
                ("sillHeight", 0.1, "door sillHeight"), ("height", 3, "above wall height")):
            with self.subTest(field=field, value=value):
                request = rectangle_request()
                request["geometry"]["openings"][0][field] = value
                with self.assertRaisesRegex(GeometryError, message):
                    validate_request(request)

    def test_rejects_overlapping_cutouts(self):
        self.request["geometry"]["openings"].append(opening("overlap", "wall_0", "window", 1.4, 1, 1, 1))
        with self.assertRaisesRegex(GeometryError, "overlaps opening"):
            validate_request(self.request)

    def test_touching_cutouts_and_stacked_cutouts_allowed(self):
        self.request["geometry"]["openings"].extend([
            opening("touch", "wall_0", "door", 1.9, 1, 2.1, 0),
            opening("stack", "wall_0", "window", 1, 0.9, 0.4, 2.1)])
        self.assertEqual(len(validate_request(self.request)["geometry"]["openings"]), 4)

    def test_rejects_corner_only_cutout_contact(self):
        for offset in (0.5, 1.9):
            with self.subTest(offset=offset):
                request = rectangle_request()
                request["geometry"]["openings"].append(
                    opening("corner", "wall_0", "window", offset, 0.5, 0.5, 2.1))
                with self.assertRaisesRegex(GeometryError, "only at a corner"):
                    validate_request(request)

    def test_nearly_touching_corner_is_rejected_within_geometry_tolerance(self):
        self.request["geometry"]["openings"].append(
            opening("near_corner", "wall_0", "window", 1.9 + 1e-10, 0.5, 0.5, 2.1 + 1e-10))
        with self.assertRaisesRegex(GeometryError, "only at a corner"):
            validate_request(self.request)

    def test_spatially_separate_cutouts_remain_allowed(self):
        self.request["geometry"]["openings"].append(
            opening("separate", "wall_0", "window", 2, 0.5, 0.5, 2.1))
        self.assertEqual(len(validate_request(self.request)["geometry"]["openings"]), 3)

    def test_rejects_overlapping_rooms_including_identical_boundary(self):
        room = self.request["geometry"]["rooms"][0]
        for polygon in (room["floorPolygon"], [[1, 1], [2, 1], [2, 2], [1, 2]],
                        [[4, -1], [6, -1], [6, 1], [4, 1]],
                        [[0, 0], [5, 0], [5, 2], [0, 2]]):
            with self.subTest(polygon=polygon):
                request = rectangle_request()
                added = copy.deepcopy(room)
                added.update(id="room_overlap", floorPolygon=copy.deepcopy(polygon))
                request["geometry"]["rooms"].append(added)
                with self.assertRaisesRegex(GeometryError, "interior overlaps"):
                    validate_request(request)

    def test_adjacent_rooms_share_one_wall(self):
        geometry = self.request["geometry"]
        geometry["rooms"].append({"id": "room_adjacent", "label": "Adjacent", "height": 2.8,
            "floorPolygon": [[5, 0], [7, 0], [7, 4], [5, 4]], "evidenceIds": []})
        for i, (a, b) in enumerate((([5, 0], [7, 0]), ([7, 0], [7, 4]), ([7, 4], [5, 4]))):
            geometry["walls"].append({"id": f"added_{i}", "start": a, "end": b,
                "height": 2.8, "thickness": 0.15, "evidenceIds": []})
        self.assertEqual(len(validate_request(self.request)["geometry"]["rooms"]), 2)

    def test_array_caps(self):
        self.request["geometry"]["rooms"] = [self.request["geometry"]["rooms"][0]] * 33
        with self.assertRaisesRegex(GeometryError, "0|32"):
            validate_request(self.request)


class PolygonTests(unittest.TestCase):
    def test_concave_ear_clipping_area_and_both_windings(self):
        original = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]
        for points in (original, list(reversed(original)), original + [original[0]]):
            with self.subTest(points=points):
                triangles = triangulate_polygon(points)
                self.assertEqual(len(triangles), 4)
                areas = [signed_area([points[i] for i in tri]) for tri in triangles]
                self.assertTrue(all(a > 0 for a in areas))
                self.assertAlmostEqual(sum(areas), 7)

    def test_collinear_redundant_vertex_is_supported(self):
        points = [[0, 0], [2, 0], [4, 0], [4, 4], [0, 4]]
        triangles = triangulate_polygon(points)
        self.assertAlmostEqual(sum(signed_area([points[i] for i in tri]) for tri in triangles), 16)

    def test_seeded_concave_polygons_preserve_area(self):
        randomizer = random.Random(1741)
        for _ in range(30):
            points = []
            for index in range(12):
                angle = index * math.tau / 12
                radius = randomizer.uniform(2.5, 3) if index % 2 else randomizer.uniform(0.8, 1.3)
                points.append([radius * math.cos(angle), radius * math.sin(angle)])
            triangles = triangulate_polygon(points)
            self.assertEqual(len(triangles), len(points) - 2)
            self.assertAlmostEqual(sum(signed_area([points[i] for i in tri]) for tri in triangles), signed_area(points))

    def test_invalid_polygons(self):
        cases = [
            [[0, 0], [1, 1], [0, 1], [1, 0]],  # crossing
            [[0, 0], [1, 0], [2, 0]],  # no area
            [[0, 0], [1, 0], [1, 0], [0, 1]],  # zero edge
            [[0, 0], [3, 0], [2, 0], [2, 1], [0, 1]],  # adjacent overlap
            [[0, 0], [4, 0], [4, 4], [2, 0], [0, 4]],  # endpoint on nonadjacent edge
            [[0, 0], [4, 0], [4, 3], [1, 3], [1, 0], [3, 0], [3, 2], [0, 2]],
        ]
        for points in cases:
            with self.subTest(points=points), self.assertRaises(GeometryError):
                triangulate_polygon(points)


class WallCellTests(unittest.TestCase):
    def setUp(self):
        self.request = validate_request(rectangle_request())

    def test_cutout_volume_and_empty_door_region(self):
        wall = self.request["geometry"]["walls"][0]
        openings = self.request["geometry"]["openings"]
        cells = wall_cells(wall, openings)
        solid_area = sum((c["u1"] - c["u0"]) * (c["y1"] - c["y0"]) for c in cells)
        self.assertAlmostEqual(solid_area * wall["thickness"], (5 * 2.8 - 0.9 * 2.1) * 0.15)
        for cell in cells:
            u, y = (cell["u0"] + cell["u1"]) / 2, (cell["y0"] + cell["y1"]) / 2
            self.assertFalse(1 < u < 1.9 and 0 < y < 2.1)
        self.assertEqual(cells, wall_cells(wall, list(reversed(openings))))

    def test_no_openings_is_single_cell(self):
        self.assertEqual(wall_cells(self.request["geometry"]["walls"][0], []),
                         [{"u0": 0, "u1": 5, "y0": 0, "y1": 2.8}])

    def test_opening_can_span_whole_wall(self):
        wall = self.request["geometry"]["walls"][0]
        cutout = opening("full", "wall_0", "door", 0, 5, 2.8, 0)
        self.assertEqual(wall_cells(wall, [cutout]), [])

    def test_window_keeps_sill_and_lintel(self):
        wall = self.request["geometry"]["walls"][2]
        cells = wall_cells(wall, self.request["geometry"]["openings"])
        area = sum((c["u1"] - c["u0"]) * (c["y1"] - c["y0"]) for c in cells)
        self.assertAlmostEqual(area, 5 * 2.8 - 1.4 * 1.2)
        self.assertTrue(any(c["u0"] == 1.5 and c["y1"] == 0.8 for c in cells))
        self.assertTrue(any(c["u0"] == 1.5 and c["y0"] == 2 for c in cells))

    def test_tolerated_float_overhang_is_clipped_to_actual_wall(self):
        wall = self.request["geometry"]["walls"][0]
        cutout = opening("full", "wall_0", "window", 0, 5 + 1e-10, 2.8 + 1e-10, 0)
        self.assertEqual(wall_cells(wall, [cutout]), [])

    def test_corner_only_contact_is_rejected_by_wall_cells_too(self):
        wall = self.request["geometry"]["walls"][0]
        cutouts = [opening("one", "wall_0", "window", 1, 1, 1, 0.5),
                   opening("two", "wall_0", "window", 2, 1, 1, 1.5)]
        with self.assertRaisesRegex(GeometryError, "only at a corner"):
            wall_cells(wall, cutouts)


if __name__ == "__main__":
    unittest.main()
