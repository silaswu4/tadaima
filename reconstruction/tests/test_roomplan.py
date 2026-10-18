"""Synthetic native surface packets; no real device scan or accuracy claim."""

from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from reconstruction.geometry import signed_area, validate_request
from reconstruction.roomplan import RoomPlanError, import_scan, run, validate_scan

NOW = "2026-10-18T12:00:00Z"


def surface(ident, start, end, *, category="wall", height=2.7, sill=0, floor=0, parent=None):
    dx, dz = end[0] - start[0], end[1] - start[1]
    width = math.hypot(dx, dz)
    x, z = dx / width, dz / width
    return {"id": ident, "category": category, "dimensions": [width, height, 0],
            "transform": [x, 0, z, 0, 0, 1, 0, 0, -z, 0, x, 0,
                          (start[0] + end[0]) / 2, floor + sill + height / 2,
                          (start[1] + end[1]) / 2, 1],
            "confidence": "high", "parentId": parent, "polygonCorners": [], "isCurved": False}


def packet(points=None, *, floor=0, apertures=True):
    points = points or [[0, 0], [5, 0], [5, 4], [0, 4]]
    walls = [surface(f"wall-{index}", a, points[(index + 1) % len(points)], floor=floor)
             for index, a in enumerate(points)]
    if apertures and len(points) == 4 and points == [[0, 0], [5, 0], [5, 4], [0, 4]]:
        walls += [surface("door-a", [1, 0], [1.9, 0], category="door", height=2.1, floor=floor, parent="wall-0"),
                  surface("window-c", [3.5, 4], [2.1, 4], category="window", height=1.2, sill=0.8, floor=floor, parent="wall-2")]
    return {"schemaVersion": "roomplan-scan/1.0", "projectId": "synthetic-project", "jobId": "synthetic-native-job",
            "inputRevision": 3, "capturedAt": NOW, "roomId": "room-native", "roomLabel": "Synthetic native room",
            "device": {"model": "iPhone14,2", "systemVersion": "18.0"}, "surfaces": walls}


def rotate_packet(value, angle, tx=-7, tz=-9):
    """Apply a proper Y-axis scene rotation to each surface matrix."""
    result = deepcopy(value)
    c, s = math.cos(angle), math.sin(angle)
    for item in result["surfaces"]:
        transform = item["transform"]
        for base in (0, 4, 8):
            x, z = transform[base], transform[base + 2]
            transform[base], transform[base + 2] = c * x - s * z, s * x + c * z
        x, z = transform[12], transform[14]
        transform[12], transform[14] = tx + c * x - s * z, tz + s * x + c * z
    return result


class NativePacketValidationTests(unittest.TestCase):
    def test_valid_packet_normalizes_without_mutating(self):
        value = packet()
        original = deepcopy(value)
        result = validate_scan(value)
        self.assertEqual(value, original)
        self.assertEqual(result, value)
        self.assertIsNot(result, value)

    def test_requires_exact_supported_fields(self):
        for field in ("execute", "nativeUsdAsset"):
            with self.subTest(field=field):
                value = packet()
                value[field] = "not executed"
                with self.assertRaises(RoomPlanError):
                    validate_scan(value)

    def test_invalid_ids_and_revisions(self):
        for invalid in ("../scan", "a/b", "a.b", "é", "a" * 65):
            with self.subTest(value=invalid):
                value = packet()
                value["jobId"] = invalid
                with self.assertRaises(RoomPlanError):
                    validate_scan(value)
        for invalid in (True, -1, 1.1, 2**53):
            with self.subTest(revision=invalid):
                value = packet()
                value["inputRevision"] = invalid
                with self.assertRaises(RoomPlanError):
                    validate_scan(value)

    def test_nonfinite_boolean_and_huge_matrix_entries_rejected(self):
        for invalid in (float("nan"), float("inf"), True, 10**400):
            with self.subTest(value=repr(invalid)[:30]):
                value = packet()
                value["surfaces"][0]["transform"][12] = invalid
                with self.assertRaises(RoomPlanError):
                    validate_scan(value)

    def test_scale_shear_reflection_and_invalid_homogeneous_matrix_rejected(self):
        for index, invalid in ((0, 2), (4, 0.1), (8, 0.1), (10, -1), (15, 0), (3, 1)):
            with self.subTest(index=index, value=invalid):
                value = packet()
                value["surfaces"][0]["transform"][index] = invalid
                with self.assertRaises(RoomPlanError):
                    validate_scan(value)

    def test_sloped_surfaces_are_rejected(self):
        value = packet()
        angle = math.radians(2)
        value["surfaces"][0]["transform"][:12] = [math.cos(angle), math.sin(angle), 0, 0,
            -math.sin(angle), math.cos(angle), 0, 0, 0, 0, 1, 0]
        with self.assertRaisesRegex(RoomPlanError, "local Y must be upright"):
            validate_scan(value)

    def test_curves_and_nonrectangular_polygons_declined(self):
        value = packet()
        value["surfaces"][0]["isCurved"] = True
        with self.assertRaisesRegex(RoomPlanError, "curved"):
            validate_scan(value)
        value = packet()
        value["surfaces"][0]["polygonCorners"] = [[-2.5, -1.35, 0], [2.5, -1.35, 0], [2.5, 1.35, 0]]
        with self.assertRaisesRegex(RoomPlanError, "nonrectangular"):
            validate_scan(value)

    def test_local_rectangular_polygon_is_accepted_and_bowtie_rejected(self):
        value = packet()
        corners = [[-2.5, -1.35, 0], [2.5, -1.35, 0], [2.5, 1.35, 0], [-2.5, 1.35, 0]]
        value["surfaces"][0]["polygonCorners"] = corners
        self.assertEqual(import_scan(value)["status"], "needs_review")
        value["surfaces"][0]["polygonCorners"] = [corners[0], corners[2], corners[1], corners[3]]
        with self.assertRaisesRegex(RoomPlanError, "corner order"):
            validate_scan(value)

    def test_bad_enum_types_are_domain_errors(self):
        for field in ("category", "confidence"):
            for invalid in ([], {}):
                with self.subTest(field=field, invalid=invalid):
                    value = packet()
                    value["surfaces"][0][field] = invalid
                    with self.assertRaises(RoomPlanError):
                        validate_scan(value)

    def test_duplicate_ids_and_surface_count_caps(self):
        value = packet()
        value["surfaces"][1]["id"] = value["surfaces"][0]["id"]
        with self.assertRaisesRegex(RoomPlanError, "duplicate"):
            validate_scan(value)
        value = packet()
        value["surfaces"] *= 33
        with self.assertRaisesRegex(RoomPlanError, "array"):
            validate_scan(value)


class NativeGeometryTests(unittest.TestCase):
    def test_closed_room_preserves_assumed_clear_faces_and_parented_openings(self):
        result = import_scan(packet())
        self.assertEqual(result["request"], validate_request(result["request"]))
        self.assertEqual(result["status"], "needs_review")
        self.assertTrue(result["reviewRequired"])
        geometry = result["request"]["geometry"]
        walls = {wall["id"]: wall for wall in geometry["walls"]}
        self.assertAlmostEqual(walls["wall-0"]["start"][1] + 0.06, 0)
        self.assertAlmostEqual(walls["wall-1"]["start"][0] - 0.06, 5)
        self.assertAlmostEqual(walls["wall-2"]["start"][1] - 0.06, 4)
        self.assertAlmostEqual(walls["wall-3"]["start"][0] + 0.06, 0)
        openings = {opening["id"]: opening for opening in geometry["openings"]}
        self.assertEqual(openings["door-a"]["wallId"], "wall-0")
        self.assertAlmostEqual(walls["wall-0"]["start"][0] + openings["door-a"]["offset"], 1)
        self.assertAlmostEqual(openings["window-c"]["sillHeight"], 0.8)
        self.assertIn("ASSUMED inside faces", " ".join(result["warnings"]))

    def test_source_evidence_is_sensor_derived_with_inferred_thickness_and_no_confirmation(self):
        value = packet()
        value["surfaces"][0]["confidence"] = "low"
        result = import_scan(value)
        evidence = result["request"]["evidence"]
        self.assertEqual(sum(e["dimensionStatus"] == "source_dimension" for e in evidence), 6)
        self.assertTrue(any(e["dimensionStatus"] == "inferred" and "thickness" in e["claim"] for e in evidence))
        self.assertTrue(all(e["confirmedByUserAt"] is None for e in evidence))
        self.assertTrue(all(e["observedAt"] == NOW for e in evidence))
        self.assertIn("low capture confidence", " ".join(result["warnings"]))
        room_refs = result["request"]["geometry"]["rooms"][0]["evidenceIds"]
        self.assertTrue(all(result["request"]["geometry"]["walls"][i]["evidenceIds"][0] in room_refs for i in range(4)))

    def test_rotated_negative_scene_and_nonzero_floor_preserve_room_geometry(self):
        value = rotate_packet(packet(floor=-3), 0.63)
        result = import_scan(value)
        self.assertAlmostEqual(result["floorY"], -3)
        self.assertEqual(result["coordinatePolicy"]["sourceToCanonicalTranslation"], [0, 3, 0])
        self.assertAlmostEqual(result["request"]["geometry"]["rooms"][0]["height"], 2.7)
        self.assertAlmostEqual(signed_area(result["coordinatePolicy"]["sourcePlaneLoop"]), 20)
        self.assertAlmostEqual(result["request"]["geometry"]["openings"][0]["sillHeight"], 0)

    def test_reversed_source_axes_keep_valid_loop_and_opening_parent(self):
        value = packet()
        for item in value["surfaces"]:
            for index in (0, 1, 2, 8, 9, 10):
                item["transform"][index] *= -1
        self.assertEqual(import_scan(value)["request"], validate_request(import_scan(value)["request"]))

    def test_concave_closed_plan_supported_without_bounding_box(self):
        points = [[0, 0], [5, 0], [5, 2], [2, 2], [2, 4], [0, 4]]
        result = import_scan(packet(points, apertures=False))
        self.assertEqual(len(result["request"]["geometry"]["walls"]), 6)
        self.assertAlmostEqual(signed_area(result["coordinatePolicy"]["sourcePlaneLoop"]), 14)
        self.assertNotEqual(len(result["request"]["geometry"]["rooms"][0]["floorPolygon"]), 4)

    def test_bounded_endpoint_corrections_are_recorded(self):
        value = packet()
        value["surfaces"][0]["dimensions"][0] -= 0.08
        result = import_scan(value)
        joins = [item for item in result["corrections"] if item["kind"] == "wall_endpoint_join"]
        self.assertEqual(len(joins), 2)
        self.assertTrue(all(abs(item["distanceMeters"] - 0.04) < 1e-7 for item in joins))

    def test_missing_wall_large_gap_and_disconnected_loops_are_declined(self):
        for mode in ("missing", "gap", "disconnected"):
            with self.subTest(mode=mode):
                value = packet(apertures=False)
                if mode == "missing":
                    value["surfaces"].pop()
                elif mode == "gap":
                    value["surfaces"][0]["dimensions"][0] -= 0.6
                else:
                    other = packet([[10, 0], [12, 0], [12, 2], [10, 2]], apertures=False)
                    for item in other["surfaces"]:
                        item["id"] += "-other"
                    value["surfaces"] += other["surfaces"]
                with self.assertRaises(RoomPlanError):
                    import_scan(value)

    def test_branched_endpoints_rejected(self):
        value = packet(apertures=False)
        value["surfaces"].append(surface("branch", [0, 0], [-2, 1]))
        with self.assertRaises(RoomPlanError):
            import_scan(value)

    def test_stairs_partial_height_or_different_floor_declined(self):
        for dimension in ("floor", "height"):
            with self.subTest(dimension=dimension):
                value = packet(apertures=False)
                if dimension == "floor":
                    value["surfaces"][0]["transform"][13] += 0.3
                else:
                    value["surfaces"][0]["dimensions"][1] -= 0.3
                    value["surfaces"][0]["transform"][13] -= 0.15
                with self.assertRaisesRegex(RoomPlanError, "flat floor|wall tops"):
                    import_scan(value)

    def test_missing_parent_can_use_unique_geometry_but_wrong_parent_is_not_ignored(self):
        value = packet()
        value["surfaces"][4]["parentId"] = None
        self.assertEqual(import_scan(value)["request"]["geometry"]["openings"][0]["wallId"], "wall-0")
        value["surfaces"][4]["parentId"] = "wall-2"
        with self.assertRaisesRegex(RoomPlanError, "parent"):
            import_scan(value)

    def test_ambiguous_parent_at_split_collinear_wall_declined(self):
        value = packet(apertures=False)
        value["surfaces"][0] = surface("wall-0", [0, 0], [2.5, 0])
        value["surfaces"].append(surface("wall-0-rest", [2.5, 0], [5, 0]))
        value["surfaces"].append(surface("small-window", [2.47, 0], [2.53, 0], category="window", height=0.5, sill=1))
        with self.assertRaisesRegex(RoomPlanError, "ambiguous"):
            import_scan(value)

    def test_split_wall_with_sensor_noise_joins_as_one_straight_edge(self):
        # RoomPlan estimates each piece of a split wall separately in float32, so the
        # pieces are never exactly collinear. Rejecting them declined real rooms.
        # Endpoints deliberately do not coincide: real pieces never share an exact point.
        cases = {"0.5 degree yaw": ([0, 0], [2.5, 0], [2.53, 0.004], [5, 0.0256]),
                 "1e-4 rad yaw + 4 cm gap": ([0, 0], [2.48, 0], [2.52, 0.0002], [5, 0.0005]),
                 "1 degree yaw, 2 cm offset": ([0, 0], [2.5, 0], [2.52, 0.02], [5, 0.0633])}
        for name, (a, b, c, d) in cases.items():
            with self.subTest(name):
                value = packet(apertures=False)
                value["surfaces"][0] = surface("wall-0", a, b)
                value["surfaces"].append(surface("wall-0-rest", c, d))
                value["surfaces"][1] = surface("wall-1", [5, d[1]], [5, 4])
                result = import_scan(rotate_packet(value, 0.7))
                self.assertEqual(result["request"], validate_request(result["request"]))
                self.assertEqual(len(result["request"]["geometry"]["walls"]), 5)

    def test_parallel_but_displaced_walls_are_not_merged(self):
        # A 15 cm step between parallel pieces is a real jog, not sensor noise.
        value = packet(apertures=False)
        value["surfaces"][0] = surface("wall-0", [0, 0], [2.5, 0])
        value["surfaces"].append(surface("wall-0-rest", [2.5, 0.15], [5, 0.15]))
        value["surfaces"][1] = surface("wall-1", [5, 0.15], [5, 4])
        with self.assertRaisesRegex(RoomPlanError, "partial/disconnected"):
            import_scan(value)

    def test_opening_orientation_and_plane_mismatch_rejected(self):
        for mode in ("orientation", "plane"):
            with self.subTest(mode=mode):
                value = packet()
                door = value["surfaces"][4]
                if mode == "orientation":
                    door["transform"][:12] = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0]
                else:
                    door["transform"][14] += 0.2
                with self.assertRaisesRegex(RoomPlanError, "parent"):
                    import_scan(value)

    def test_generic_opening_requires_floor_alignment(self):
        value = packet()
        value["surfaces"][4]["category"] = "opening"
        self.assertEqual(import_scan(value)["request"]["geometry"]["openings"][0]["kind"], "door")
        value["surfaces"][4]["transform"][13] += 0.2
        with self.assertRaisesRegex(RoomPlanError, "not relabeled as a window"):
            import_scan(value)

    def test_tiny_door_floor_correction_is_reported(self):
        value = packet()
        value["surfaces"][4]["transform"][13] += 0.02
        result = import_scan(value)
        self.assertEqual(result["request"]["geometry"]["openings"][0]["sillHeight"], 0)
        self.assertTrue(any(item["kind"] == "opening_floor_alignment" for item in result["corrections"]))


class NativePipelineTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.input = self.root / "scan.json"
        self.output = self.root / "private-job"

    def write(self, value):
        self.input.write_text(json.dumps(value))

    def test_private_source_request_dossier_and_exact_source_hash(self):
        self.write(packet())
        source_bytes = self.input.read_bytes()
        result = run(self.input, self.output, expected_project="synthetic-project", expected_revision=3)
        self.assertEqual(result["inputSha256"], hashlib.sha256(source_bytes).hexdigest())
        self.assertEqual((self.output / "scan.input.json").read_bytes(), source_bytes)
        self.assertTrue((self.output / "reconstruction.request.json").is_file())
        self.assertEqual(os.stat(self.output).st_mode & 0o777, 0o700)
        for file in self.output.iterdir():
            self.assertEqual(os.stat(file).st_mode & 0o777, 0o600)
        with self.assertRaises(RoomPlanError):
            run(self.input, self.output)

    def test_wrong_authorized_identity_does_not_create_output(self):
        self.write(packet())
        with self.assertRaisesRegex(RoomPlanError, "authorized job"):
            run(self.input, self.output, expected_job="wrong-job")
        self.assertFalse(self.output.exists())

    def test_unsupported_scan_retains_raw_packet_and_failed_dossier_without_fake_request(self):
        value = packet()
        value["surfaces"][0]["isCurved"] = True
        self.write(value)
        with self.assertRaisesRegex(RoomPlanError, "curved"):
            run(self.input, self.output)
        self.assertTrue((self.output / "scan.input.json").exists())
        self.assertEqual(json.loads((self.output / "roomplan.dossier.json").read_text())["status"], "failed")
        self.assertFalse((self.output / "reconstruction.request.json").exists())

    def test_duplicate_json_keys_and_oversize_inputs_rejected(self):
        for content in (b'{"schemaVersion":"a","schemaVersion":"b"}', b" " * (2 * 1024 * 1024 + 1)):
            with self.subTest(length=len(content)):
                self.input.write_bytes(content)
                with self.assertRaises(RoomPlanError):
                    run(self.input, self.output)
                self.assertFalse(self.output.exists())

    def test_cli_emits_review_state_for_valid_input(self):
        self.write(packet())
        process = subprocess.run([sys.executable, "-m", "reconstruction.roomplan", "--input", str(self.input),
                                  "--output", str(self.output)], capture_output=True, text=True,
                                 cwd=Path(__file__).resolve().parents[2], check=False)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout)["status"], "needs_review")

    @unittest.skipUnless(os.environ.get("BLENDER_BIN"), "Set BLENDER_BIN for actual RoomPlan-to-Blender integration")
    def test_actual_blender_produces_editable_scene_and_glb(self):
        self.write(packet())
        result = run(self.input, self.output, render=True, blender=os.environ["BLENDER_BIN"])
        self.assertEqual(result["draftManifestPath"], "draft/manifest.json")
        self.assertTrue((self.output / "draft/scene.blend").read_bytes().startswith(b"BLENDER"))
        self.assertTrue((self.output / "draft/scene.glb").read_bytes().startswith(b"glTF"))
        manifest = json.loads((self.output / "draft/manifest.json").read_text())
        self.assertEqual(manifest["statistics"]["entityCount"], 7)
        self.assertEqual(manifest["units"], "m")


if __name__ == "__main__":
    unittest.main()
