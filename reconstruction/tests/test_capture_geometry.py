"""Capture metadata and measurement-to-centerline regression tests (no Blender)."""

import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from reconstruction.capture.geometry import compile_capture, validate_manifest
from reconstruction.geometry import GeometryError, validate_request

NOW = "2026-10-18T01:30:00-07:00"
MEASURED_AT = "2026-10-17T18:00:00-07:00"


def measurement(value, method="tape"):
    return {"valueMeters": value, "method": method, "observedAt": MEASURED_AT}


def photo(ident="photo_a", wall="a"):
    return {"id": ident, "fileName": f"photos/{ident}.jpg", "sha256": "a" * 64,
            "mediaType": "image/jpeg", "width": 1600, "height": 1200, "wall": wall,
            "capturedAt": NOW, "quality": {"meanLuminance": 125, "edgeEnergy": 25}}


def opening(ident="door_a", wall="a", kind="door"):
    return {"id": ident, "wall": wall, "kind": kind, "offset": measurement(1),
            "width": measurement(0.9), "height": measurement(2.1), "sillHeight": measurement(0)}


def manifest():
    return {"schemaVersion": "mobile-capture/1.0", "jobId": "capture_demo", "projectId": "project_demo",
            "inputRevision": 2, "capturedAt": NOW, "captureMode": "guided_photos",
            "room": {"id": "room_demo", "label": "Example room", "shape": "rectangle",
                     "clearWidth": measurement(5), "clearDepth": measurement(4), "height": measurement(2.8),
                     "wallThickness": measurement(0.2), "confirmedRectangularAt": NOW},
            "photos": [photo()], "openings": [opening()]}


class ManifestValidationTests(unittest.TestCase):
    def test_valid_metadata_normalizes_without_mutation(self):
        value = manifest()
        value["photos"][0]["sha256"] = "A" * 64
        original = copy.deepcopy(value)
        result = validate_manifest(value)
        self.assertEqual(result["photos"][0]["sha256"], "a" * 64)
        self.assertIsInstance(result["room"]["clearWidth"]["valueMeters"], float)
        self.assertEqual(value, original)

    def test_rejects_unknown_fields_and_nonrectangular_rooms(self):
        value = manifest()
        value["room"]["shape"] = "l_shape"
        with self.assertRaisesRegex(GeometryError, "only explicit rectangle"):
            validate_manifest(value)
        value = manifest()
        value["room"]["floorPolygon"] = []
        with self.assertRaisesRegex(GeometryError, "unsupported fields"):
            validate_manifest(value)

    def test_rejects_missing_structural_fields(self):
        value = manifest()
        del value["room"]["height"]
        with self.assertRaisesRegex(GeometryError, "missing fields: height"):
            validate_manifest(value)

    def test_rejects_nonfinite_negative_boolean_zero_and_extreme_dimensions(self):
        for invalid in (float("nan"), float("inf"), -1, True, 0, "5", 101, 10**400):
            with self.subTest(invalid=repr(invalid)[:30]):
                value = manifest()
                value["room"]["clearWidth"]["valueMeters"] = invalid
                with self.assertRaises(GeometryError):
                    validate_manifest(value)

    def test_room_measurement_range_limits(self):
        for key, value in (("clearDepth", 0.1), ("height", 0.4), ("height", 21),
                           ("wallThickness", 0.01), ("wallThickness", 1.1)):
            with self.subTest(key=key, value=value):
                item = manifest()
                item["room"][key]["valueMeters"] = value
                with self.assertRaises(GeometryError):
                    validate_manifest(item)

    def test_unknown_measurement_method_rejected(self):
        value = manifest()
        value["room"]["clearWidth"]["method"] = "photo_ai"
        with self.assertRaisesRegex(GeometryError, "method must"):
            validate_manifest(value)

    def test_timestamps_require_timezones(self):
        value = manifest()
        value["room"]["height"]["observedAt"] = "2026-10-17T18:00:00"
        with self.assertRaisesRegex(GeometryError, "timezone"):
            validate_manifest(value)

    def test_safe_ids_and_safe_exact_photo_paths(self):
        for invalid in ("../secret", "/absolute.jpg", "photos/other.jpg", "photos/photo_a.JPG", "photos/photo_a.jpg/extra"):
            with self.subTest(path=invalid):
                value = manifest()
                value["photos"][0]["fileName"] = invalid
                with self.assertRaisesRegex(GeometryError, "matching-safe-id"):
                    validate_manifest(value)
        for invalid in ("../a", "a/b", "a.b", "é", "a" * 65):
            with self.subTest(id=invalid):
                value = manifest()
                value["projectId"] = invalid
                with self.assertRaisesRegex(GeometryError, "safe ASCII ID"):
                    validate_manifest(value)

    def test_photo_digest_media_dimensions_and_quality(self):
        for field, invalid in (("sha256", "a" * 63), ("sha256", "x" * 64), ("mediaType", "image/png"),
                               ("width", 319), ("height", 4097), ("width", True), ("height", 1200.5),
                               ("wall", "east")):
            with self.subTest(field=field, invalid=invalid):
                value = manifest()
                value["photos"][0][field] = invalid
                with self.assertRaises(GeometryError):
                    validate_manifest(value)
        for field, invalid in (("meanLuminance", 256), ("edgeEnergy", -1), ("edgeEnergy", float("nan"))):
            with self.subTest(field=field, invalid=invalid):
                value = manifest()
                value["photos"][0]["quality"][field] = invalid
                with self.assertRaises(GeometryError):
                    validate_manifest(value)

    def test_caps_and_duplicate_ids(self):
        for field, count in (("photos", 17), ("openings", 33)):
            with self.subTest(field=field):
                value = manifest()
                value[field] *= count
                with self.assertRaisesRegex(GeometryError, "at most"):
                    validate_manifest(value)
        for field in ("photos", "openings"):
            with self.subTest(field=field):
                value = manifest()
                value[field].append(copy.deepcopy(value[field][0]))
                with self.assertRaisesRegex(GeometryError, "duplicate"):
                    validate_manifest(value)

    def test_rejects_invalid_revision(self):
        for invalid in (True, -1, 2.5, 9_007_199_254_740_992):
            with self.subTest(invalid=invalid):
                value = manifest()
                value["inputRevision"] = invalid
                with self.assertRaisesRegex(GeometryError, "integer"):
                    validate_manifest(value)

    def test_rejects_door_sill_and_openings_beyond_clear_dimensions(self):
        for field, value, message in (("sillHeight", 0.1, "door sillHeight"),
                                       ("offset", 4.5, "clear inside wall"),
                                       ("height", 3, "above room height"),
                                       ("width", 0, "finite number")):
            with self.subTest(field=field):
                item = manifest()
                item["openings"][0][field] = measurement(value)
                with self.assertRaisesRegex(GeometryError, message):
                    validate_manifest(item)


class CaptureCompilationTests(unittest.TestCase):
    def test_centerline_conversion_preserves_clear_inside_dimensions(self):
        result = compile_capture(manifest())
        self.assertEqual(result["status"], "ready_for_review")
        self.assertTrue(result["reviewRequired"])
        request = result["request"]
        self.assertEqual(request, validate_request(request))
        geometry = request["geometry"]
        self.assertEqual(geometry["rooms"][0]["floorPolygon"],
                         [[-0.1, -0.1], [5.1, -0.1], [5.1, 4.1], [-0.1, 4.1]])
        a, b, c, d = geometry["walls"]
        self.assertAlmostEqual(b["start"][0] - b["thickness"] / 2, 5)
        self.assertAlmostEqual(d["start"][0] + d["thickness"] / 2, 0)
        self.assertAlmostEqual(c["start"][1] - c["thickness"] / 2, 4)
        self.assertAlmostEqual(a["start"][1] + a["thickness"] / 2, 0)
        self.assertEqual(geometry["openings"][0]["offset"], 1.1)
        self.assertAlmostEqual(a["start"][0] + geometry["openings"][0]["offset"], 1)

    def test_offsets_follow_reversed_c_and_d_wall_directions(self):
        value = manifest()
        value["openings"] = [opening("door_c", "c"), opening("door_d", "d")]
        geometry = compile_capture(value)["request"]["geometry"]
        wall_map = {wall["id"]: wall for wall in geometry["walls"]}
        c_opening, d_opening = geometry["openings"]
        c, d = wall_map[c_opening["wallId"]], wall_map[d_opening["wallId"]]
        self.assertAlmostEqual(c["start"][0] - c_opening["offset"], 4)
        self.assertAlmostEqual(d["start"][1] - d_opening["offset"], 3)

    def test_missing_dimensions_do_not_generate_or_guess_geometry(self):
        value = manifest()
        value["room"]["clearWidth"] = None
        value["room"]["height"] = None
        result = compile_capture(value)
        self.assertEqual(result["status"], "needs_measurements")
        self.assertEqual(result["missingMeasurements"], ["room.clearWidth", "room.height"])
        self.assertIsNone(result["request"])

    def test_rectangle_confirmation_required_without_fake_confirmation(self):
        value = manifest()
        value["room"]["confirmedRectangularAt"] = None
        result = compile_capture(value)
        self.assertEqual(result["missingMeasurements"], ["room.confirmedRectangularAt"])
        self.assertIsNone(result["request"])

    def test_default_thickness_is_inferred_and_needs_review(self):
        value = manifest()
        value["room"]["wallThickness"] = None
        result = compile_capture(value)
        self.assertEqual(result["status"], "needs_review")
        self.assertEqual(result["request"]["geometry"]["walls"][0]["thickness"], 0.12)
        inferred = [e for e in result["request"]["evidence"] if e["dimensionStatus"] == "inferred"]
        self.assertEqual(len(inferred), 1)
        self.assertIn("defaulted", inferred[0]["claim"])
        self.assertIsNone(inferred[0]["confirmedByUserAt"])

    def test_estimated_room_or_opening_measurement_needs_review(self):
        for field in ("room", "opening"):
            with self.subTest(field=field):
                value = manifest()
                target = value["room"]["clearWidth"] if field == "room" else value["openings"][0]["width"]
                target["method"] = "estimate"
                result = compile_capture(value)
                self.assertEqual(result["status"], "needs_review")
                self.assertTrue(any(e["dimensionStatus"] == "inferred" for e in result["request"]["evidence"]))

    def test_measurement_evidence_retains_observed_time_and_does_not_invent_confirmation(self):
        result = compile_capture(manifest())
        evidence = result["request"]["evidence"]
        measurements = [e for e in evidence if e["dimensionStatus"] == "measured"]
        self.assertEqual(len(measurements), 8)
        self.assertTrue(all(e["observedAt"] == MEASURED_AT for e in measurements))
        self.assertTrue(all(e["confirmedByUserAt"] is None for e in measurements))
        self.assertTrue(all(e["sourceUrl"] is None for e in evidence))
        self.assertTrue(all(e["privateAssetId"].startswith("capture:project_demo:capture_demo:") for e in evidence))
        shape = [e for e in evidence if e["confirmedByUserAt"] is not None]
        self.assertEqual(len(shape), 1)
        self.assertEqual(shape[0]["confirmedByUserAt"], NOW)

    def test_photos_are_references_and_never_dimensional_evidence(self):
        request = compile_capture(manifest())["request"]
        photos = [e for e in request["evidence"] if "photos/" in e["privateAssetId"]]
        self.assertEqual(len(photos), 1)
        self.assertIsNone(photos[0]["dimensionStatus"])
        self.assertIsNone(photos[0]["confirmedByUserAt"])
        self.assertIn("no dimensions derived", photos[0]["claim"])
        self.assertIn(photos[0]["id"], request["geometry"]["walls"][0]["evidenceIds"])

    def test_manual_mode_accepts_dimension_only_inputs(self):
        value = manifest()
        value["captureMode"] = "manual"
        value["photos"] = []
        result = compile_capture(value)
        self.assertEqual(result["status"], "ready_for_review")
        self.assertFalse(any("coverage is incomplete" in warning for warning in result["warnings"]))
        self.assertIn("measurement-driven", result["warnings"][0])

    def test_guided_mode_warns_about_missing_photo_coverage(self):
        result = compile_capture(manifest())
        warnings = " ".join(result["warnings"])
        self.assertIn("B, C, D", warnings)

    def test_four_wall_views_do_not_require_optional_overview(self):
        value = manifest()
        value["photos"] = [photo("photo_" + wall, wall) for wall in "abcd"]
        result = compile_capture(value)
        self.assertFalse(any("coverage is incomplete" in warning for warning in result["warnings"]))

    def test_opening_overlap_uses_existing_room_validator(self):
        value = manifest()
        second = opening("second")
        second["offset"] = measurement(1.5)
        value["openings"].append(second)
        with self.assertRaisesRegex(GeometryError, "overlaps opening"):
            compile_capture(value)

    def test_max_length_ids_stay_safe_and_output_is_deterministic(self):
        value = manifest()
        value["room"]["id"] = "r" * 64
        value["jobId"] = "j" * 64
        value["projectId"] = "p" * 64
        first = compile_capture(value)
        self.assertEqual(first, compile_capture(copy.deepcopy(value)))
        ids = [e["id"] for e in first["request"]["evidence"]]
        self.assertTrue(all(len(ident) <= 64 for ident in ids))
        self.assertEqual(len(ids), len(set(ids)))

    def test_different_jobs_have_distinct_evidence_but_stable_wall_identity(self):
        first = manifest()
        second = manifest()
        second["jobId"] = "different_capture"
        a, b = compile_capture(first)["request"], compile_capture(second)["request"]
        self.assertEqual(a["geometry"]["walls"][0]["id"], b["geometry"]["walls"][0]["id"])
        self.assertFalse({e["id"] for e in a["evidence"]} & {e["id"] for e in b["evidence"]})


if __name__ == "__main__":
    unittest.main()
