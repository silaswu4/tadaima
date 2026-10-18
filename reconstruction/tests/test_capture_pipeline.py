"""End-to-end capture archive tests using explicitly synthetic JPEG headers.

The small test image fixtures have readable dimensions but are not real camera
photographs or photogrammetric inputs. Blender consumes only validated geometry.
"""

from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from reconstruction.capture.bundle import BundleError
from reconstruction.capture.pipeline import _has_four_views, run
from reconstruction.address.schema import ResearchError


NOW = "2026-10-18T04:00:00Z"


def measurement(value):
    return {"valueMeters": value, "method": "tape", "observedAt": NOW}


def synthetic_jpeg(label):
    return (b"\xff\xd8\xff\xc0\x00\x11\x08" + struct.pack(">HH", 480, 640)
            + b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
            + b"synthetic-header-fixture-" + label.encode("ascii") + b"\xff\xd9")


def capture_fixture(*, manual=False, walls="abcd", duplicate_images=False):
    photos, files = [], {}
    for index, wall in enumerate(walls):
        ident = f"reference-{index}"
        filename = f"photos/{ident}.jpg"
        body = synthetic_jpeg("same" if duplicate_images else str(index))
        photos.append({"id": ident, "fileName": filename, "sha256": hashlib.sha256(body).hexdigest(),
            "mediaType": "image/jpeg", "width": 640, "height": 480, "wall": wall,
            "capturedAt": NOW, "quality": {"meanLuminance": 100, "edgeEnergy": 10}})
        files[filename] = body
    manifest = {"schemaVersion": "mobile-capture/1.0", "projectId": "synthetic-capture-project",
        "jobId": "synthetic-capture-job", "inputRevision": 7, "capturedAt": NOW,
        "captureMode": "manual" if manual else "guided_photos",
        "room": {"id": "synthetic-room", "label": "Synthetic measured rectangular room",
            "shape": "rectangle", "clearWidth": measurement(4.2), "clearDepth": measurement(3.5),
            "height": measurement(2.7), "wallThickness": measurement(0.12),
            "confirmedRectangularAt": NOW},
        "photos": photos, "openings": [{"id": "entry", "kind": "door", "wall": "a",
            "offset": measurement(0.6), "width": measurement(0.9),
            "height": measurement(2.1), "sillHeight": measurement(0)}]}
    return manifest, files


def photo_fixture(**kwargs):
    """Photos only: no measurements, scale, or rectangle confirmation supplied."""
    manifest, files = capture_fixture(**kwargs)
    manifest["captureMode"] = "photo_inference"
    for field in ("clearWidth", "clearDepth", "height", "wallThickness", "confirmedRectangularAt"):
        manifest["room"][field] = None
    manifest["openings"] = []
    return manifest, files


def photo_proposal(manifest):
    """Synthetic model output; dimensions differ from the measured-mode fixture."""
    return {"summary": "Synthetic visual approximation for integration testing",
        "room": {"clearWidth": 4.8, "clearDepth": 3.6, "height": 2.6,
                 "photoIds": [photo["id"] for photo in manifest["photos"]]},
        "openings": [{"id": "estimated-door", "wall": "a", "kind": "door",
            "offset": 1, "width": 0.9, "height": 2.1, "sillHeight": 0,
            "photoIds": [manifest["photos"][0]["id"]]}],
        "assumptions": ["Synthetic uncalibrated dimensions, not measurements or an actual photo inspection."],
        "captureRequests": []}


def handoff(manifest, zip_body, proposal):
    return {"schemaVersion": "capture-geometry-handoff/1.0", "producer": "synthetic-integration-test",
        "projectId": manifest["projectId"], "jobId": manifest["jobId"],
        "inputRevision": manifest["inputRevision"], "bundleSha256": hashlib.sha256(zip_body).hexdigest(),
        "photoSha256": {photo["id"]: photo["sha256"] for photo in manifest["photos"]},
        "proposal": proposal}


def write_bundle(path, manifest, files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("capture.json", json.dumps(manifest))
        for filename, body in files.items():
            archive.writestr(filename, body)
    body = output.getvalue()
    path.write_bytes(body)
    return body


class CapturePipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "synthetic.capture.zip"
        self.output = self.root / "processed"

    def prepare(self, **kwargs):
        manifest, files = capture_fixture(**kwargs)
        body = write_bundle(self.bundle, manifest, files)
        return manifest, files, body

    def test_guided_bundle_produces_metric_request_and_private_reference_photos(self):
        manifest, files, body = self.prepare()
        with patch("reconstruction.capture.pipeline.generate") as generate:
            result = run(self.bundle, self.output)
        generate.assert_not_called()
        self.assertEqual(result["status"], "ready_for_review")
        self.assertTrue(result["reviewRequired"])
        self.assertEqual(result["photoUsage"], "reference_only")
        self.assertEqual(result["method"], "user_dimensions_rectangular_shell")
        self.assertEqual(result["bundleSha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(result["photoCount"], 4)
        self.assertIsNone(result["draftManifestPath"])
        request = json.loads((self.output / result["reconstructionRequestPath"]).read_text())
        self.assertEqual((request["projectId"], request["jobId"], request["inputRevision"]),
                         (manifest["projectId"], manifest["jobId"], manifest["inputRevision"]))
        geometry = request["geometry"]
        self.assertEqual(geometry["units"], "m")
        self.assertEqual(geometry["coordinateSystem"], "right-handed-y-up")
        floor = geometry["rooms"][0]["floorPolygon"]
        # The supplied 4.2 x 3.5 clear interior stays exact after conversion to
        # centerlines; thickness must not accidentally shrink the usable room.
        self.assertAlmostEqual(min(point[0] for point in floor) + 0.06, 0)
        self.assertAlmostEqual(max(point[0] for point in floor) - 0.06, 4.2)
        self.assertAlmostEqual(min(point[1] for point in floor) + 0.06, 0)
        self.assertAlmostEqual(max(point[1] for point in floor) - 0.06, 3.5)
        self.assertEqual(geometry["rooms"][0]["height"], 2.7)
        self.assertEqual(len(geometry["walls"]), 4)
        self.assertEqual(len(geometry["openings"]), 1)
        self.assertAlmostEqual(geometry["openings"][0]["offset"], 0.66)
        self.assertEqual(geometry["openings"][0]["width"], 0.9)
        for filename, photo in files.items():
            self.assertEqual((self.output / filename).read_bytes(), photo)
        self.assertEqual(json.loads((self.output / "capture.json").read_text()), manifest)
        self.assertEqual(json.loads((self.output / "capture.dossier.json").read_text()), result)
        self.assertTrue(any("not independently verified" in evidence["claim"] for evidence in request["evidence"]))

    def test_missing_required_dimensions_never_starts_blender(self):
        for field in ("clearWidth", "clearDepth", "height"):
            with self.subTest(field=field):
                manifest, files = capture_fixture()
                manifest["room"][field] = None
                write_bundle(self.bundle, manifest, files)
                output = self.root / f"missing-{field}"
                with patch("reconstruction.capture.pipeline.generate") as generate:
                    result = run(self.bundle, output, render=True)
                generate.assert_not_called()
                self.assertEqual(result["status"], "needs_measurements")
                self.assertIn("room." + field, result["missingMeasurements"])
                self.assertIsNone(result["reconstructionRequestPath"])
                self.assertFalse((output / "draft").exists())

    def test_bundle_hash_uses_bounded_snapshot_without_rereading_input(self):
        _, _, body = self.prepare()
        with patch.object(Path, "read_bytes", side_effect=AssertionError("Unbounded second read")):
            result = run(self.bundle, self.output)
        self.assertEqual(result["bundleSha256"], hashlib.sha256(body).hexdigest())

    def test_absent_rectangle_confirmation_never_starts_blender(self):
        manifest, files = capture_fixture()
        manifest["room"]["confirmedRectangularAt"] = None
        write_bundle(self.bundle, manifest, files)
        with patch("reconstruction.capture.pipeline.generate") as generate:
            result = run(self.bundle, self.output, render=True)
        generate.assert_not_called()
        self.assertEqual(result["status"], "needs_measurements")
        self.assertIn("room.confirmedRectangularAt", result["missingMeasurements"])

    def test_guided_missing_wall_views_requires_capture_and_never_renders(self):
        self.prepare(walls="abc")
        with patch("reconstruction.capture.pipeline.generate") as generate:
            result = run(self.bundle, self.output, render=True)
        generate.assert_not_called()
        self.assertEqual(result["status"], "needs_capture")
        self.assertIsNone(result["draftManifestPath"])
        self.assertTrue(any("distinct reference photos" in warning for warning in result["warnings"]))

    def test_duplicate_photos_cannot_prove_four_wall_views(self):
        self.prepare(duplicate_images=True)
        with patch("reconstruction.capture.pipeline.generate") as generate:
            result = run(self.bundle, self.output, render=True)
        generate.assert_not_called()
        self.assertEqual(result["photoCount"], 4)
        self.assertEqual(result["status"], "needs_capture")
        self.assertTrue(any("duplicates another image" in warning for warning in result["warnings"]))

    def test_manual_dimensions_work_without_photos(self):
        self.prepare(manual=True, walls="")
        result = run(self.bundle, self.output)
        self.assertEqual(result["status"], "ready_for_review")
        self.assertEqual(result["photoCount"], 0)
        self.assertTrue(result["reconstructionRequestPath"])
        self.assertTrue(result["reviewRequired"])

    def test_authorized_context_mismatch_rejected_before_output(self):
        self.prepare()
        for kwargs in ({"expected_project": "another-project"}, {"expected_job": "another-job"},
                       {"expected_revision": 8}):
            with self.subTest(kwargs=kwargs), patch("reconstruction.capture.pipeline.generate") as generate:
                with self.assertRaisesRegex(BundleError, "authorized job"):
                    run(self.bundle, self.output, render=True, **kwargs)
                generate.assert_not_called()
                self.assertFalse(self.output.exists())

    def test_matching_authorized_context_is_accepted(self):
        manifest, _, _ = self.prepare()
        result = run(self.bundle, self.output, expected_project=manifest["projectId"],
                     expected_job=manifest["jobId"], expected_revision=manifest["inputRevision"])
        self.assertEqual(result["inputRevision"], 7)

    def test_existing_output_is_preserved(self):
        self.prepare()
        self.output.mkdir()
        sentinel = self.output / "sentinel.txt"
        sentinel.write_text("preserve concurrent job")
        with patch("reconstruction.capture.pipeline.generate") as generate:
            with self.assertRaises(FileExistsError):
                run(self.bundle, self.output, render=True)
        generate.assert_not_called()
        self.assertEqual(sentinel.read_text(), "preserve concurrent job")
        self.assertEqual(list(self.output.iterdir()), [sentinel])

    def test_worker_failure_preserves_capture_evidence_and_dossier(self):
        _, files, _ = self.prepare()
        with patch("reconstruction.capture.pipeline.generate", side_effect=RuntimeError("worker stopped")):
            with self.assertRaisesRegex(RuntimeError, "worker stopped"):
                run(self.bundle, self.output, render=True)
        result = json.loads((self.output / "capture.dossier.json").read_text())
        self.assertEqual(result["status"], "failed")
        self.assertTrue(result["reviewRequired"])
        self.assertIsNone(result["draftManifestPath"])
        self.assertTrue((self.output / "capture.json").is_file())
        self.assertTrue((self.output / "reconstruction.request.json").is_file())
        for filename, body in files.items():
            self.assertEqual((self.output / filename).read_bytes(), body)

    def test_photo_only_without_provider_waits_for_reconstruction_not_measurements(self):
        manifest, files = photo_fixture()
        write_bundle(self.bundle, manifest, files)
        with patch("reconstruction.capture.pipeline.generate") as generate:
            result = run(self.bundle, self.output, render=True)
        generate.assert_not_called()
        self.assertEqual(result["status"], "needs_reconstruction")
        self.assertEqual(result["photoUsage"], "pending_vision")
        self.assertEqual(result["missingMeasurements"], [])
        self.assertTrue(result["reviewRequired"])
        self.assertIsNone(result["reconstructionRequestPath"])
        self.assertIsNone(result["draftManifestPath"])
        self.assertEqual(result["inferenceRequestPath"], "inference.request.json")
        self.assertTrue((self.output / "inference.request.json").is_file())
        inference = json.loads((self.output / "inference.request.json").read_text())
        self.assertEqual(inference["projectId"], manifest["projectId"])
        self.assertEqual(inference["photoSha256"], {photo["id"]: photo["sha256"] for photo in manifest["photos"]})
        self.assertFalse((self.output / "reconstruction.request.json").exists())
        saved = json.loads((self.output / "capture.json").read_text())
        self.assertEqual(saved, manifest)
        for field in ("clearWidth", "clearDepth", "height", "wallThickness", "confirmedRectangularAt"):
            self.assertIsNone(saved["room"][field])
        for filename, body in files.items():
            self.assertEqual((self.output / filename).read_bytes(), body)

    def test_wall_coverage_accepts_valid_alternatives_and_ignores_overview_order(self):
        manifest, _ = photo_fixture()
        photos = manifest["photos"]
        overview = {**photos[0], "wall": "overview"}
        manifest["photos"] = [overview, *photos]
        self.assertTrue(_has_four_views(manifest))
        # The first A image is also B's only image, but an alternate A allows
        # four distinct wall assignments; greedy first-image selection fails.
        manifest["photos"] = [{**photos[1], "wall": "a"}, *photos]
        self.assertTrue(_has_four_views(manifest))
        manifest["photos"] = [photos[0], {**photos[0], "wall": "b"}, *photos[2:]]
        self.assertFalse(_has_four_views(manifest))

    def test_photo_only_missing_views_does_not_invoke_provider(self):
        manifest, files = photo_fixture(walls="abc")
        write_bundle(self.bundle, manifest, files)
        provider = unittest.mock.Mock()
        with patch("reconstruction.capture.pipeline.generate") as generate:
            result = run(self.bundle, self.output, geometry_provider=provider, render=True)
        self.assertEqual(provider.mock_calls, [])
        generate.assert_not_called()
        self.assertEqual(result["status"], "needs_capture")
        self.assertEqual(result["missingMeasurements"], [])
        self.assertIsNone(result["reconstructionRequestPath"])
        self.assertIsNone(result["draftManifestPath"])

    def test_photo_only_duplicate_views_do_not_invoke_provider(self):
        manifest, files = photo_fixture(duplicate_images=True)
        write_bundle(self.bundle, manifest, files)
        provider = unittest.mock.Mock()
        with patch("reconstruction.capture.pipeline.generate") as generate:
            result = run(self.bundle, self.output, geometry_provider=provider, render=True)
        self.assertEqual(provider.mock_calls, [])
        generate.assert_not_called()
        self.assertEqual(result["status"], "needs_capture")
        self.assertIsNone(result["reconstructionRequestPath"])

    def test_photo_only_valid_proposal_uses_actual_bytes_and_estimated_geometry(self):
        manifest, files = photo_fixture()
        write_bundle(self.bundle, manifest, files)
        provider = unittest.mock.Mock()
        provider.extract.return_value = photo_proposal(manifest)
        result = run(self.bundle, self.output, geometry_provider=provider)
        provider.extract.assert_called_once()
        _, supplied_assets, _ = provider.extract.call_args.args
        expected = {photo["id"]: files[photo["fileName"]] for photo in manifest["photos"]}
        self.assertEqual({asset["id"]: asset["body"] for asset in supplied_assets}, expected)
        self.assertEqual(result["status"], "needs_review")
        self.assertEqual(result["photoUsage"], "vision_input")
        self.assertEqual(result["method"], "vision_estimated_rectangular_shell")
        self.assertTrue(result["reviewRequired"])
        self.assertEqual(result["missingMeasurements"], [])
        self.assertEqual(result["proposalPath"], "vision.proposal.json")
        self.assertEqual(result["citations"]["room"], [photo["id"] for photo in manifest["photos"]])
        request = json.loads((self.output / "reconstruction.request.json").read_text())
        floor = request["geometry"]["rooms"][0]["floorPolygon"]
        self.assertAlmostEqual(max(point[0] for point in floor) - min(point[0] for point in floor) - 0.12, 4.8)
        self.assertAlmostEqual(max(point[1] for point in floor) - min(point[1] for point in floor) - 0.12, 3.6)
        self.assertEqual(request["geometry"]["rooms"][0]["height"], 2.6)
        self.assertEqual(len(request["geometry"]["openings"]), 1)
        self.assertTrue(all(evidence["dimensionStatus"] in {None, "inferred"} for evidence in request["evidence"]))
        self.assertTrue(all(evidence["confirmedByUserAt"] is None for evidence in request["evidence"]))
        raw = json.loads((self.output / "capture.json").read_text())
        self.assertIsNone(raw["room"]["clearWidth"])
        self.assertIsNone(raw["room"]["confirmedRectangularAt"])

    def test_photo_only_estimated_request_reaches_blender_adapter(self):
        manifest, files = photo_fixture()
        write_bundle(self.bundle, manifest, files)
        provider = unittest.mock.Mock()
        provider.extract.return_value = photo_proposal(manifest)
        def worker(request_path, output_path, **kwargs):
            self.assertEqual(Path(request_path).name, "reconstruction.request.json")
            self.assertEqual(json.loads(Path(request_path).read_text())["geometry"]["rooms"][0]["height"], 2.6)
            Path(output_path).mkdir()
            return {"warnings": [], "projectId": manifest["projectId"], "jobId": manifest["jobId"]}
        with patch("reconstruction.capture.pipeline.generate", side_effect=worker) as generate:
            result = run(self.bundle, self.output, geometry_provider=provider, render=True)
        generate.assert_called_once()
        self.assertEqual(result["status"], "needs_review")
        self.assertEqual(result["draftManifestPath"], "draft/manifest.json")
        draft = json.loads((self.output / "draft/manifest.json").read_text())
        self.assertTrue(any("scale and dimensions are unverified" in warning for warning in draft["warnings"]))

    def test_photo_only_inconclusive_model_requests_photos_without_measurement_gate(self):
        manifest, files = photo_fixture()
        write_bundle(self.bundle, manifest, files)
        provider = unittest.mock.Mock()
        provider.extract.return_value = {"summary": "Photos do not support a coherent rectangular layout",
            "room": None, "openings": [], "assumptions": [],
            "captureRequests": ["Retake wall B with its adjacent corners visible."]}
        with patch("reconstruction.capture.pipeline.generate") as generate:
            result = run(self.bundle, self.output, geometry_provider=provider, render=True)
        generate.assert_not_called()
        self.assertEqual(result["status"], "needs_capture")
        self.assertIsNone(result["reconstructionRequestPath"])
        self.assertNotEqual(result["status"], "needs_measurements")
        self.assertTrue((self.output / "vision.proposal.json").is_file())

    def test_photo_only_keyless_handoff_binds_exact_bundle_and_images(self):
        manifest, files = photo_fixture()
        body = write_bundle(self.bundle, manifest, files)
        packet = handoff(manifest, body, photo_proposal(manifest))
        proposal_file = self.root / "vision-handoff.json"
        proposal_file.write_text(json.dumps(packet))
        result = run(self.bundle, self.output, proposal_file=proposal_file)
        self.assertEqual(result["status"], "needs_review")
        self.assertEqual(result["photoUsage"], "vision_input")
        self.assertTrue((self.output / "reconstruction.request.json").is_file())

    def test_photo_only_handoff_identity_and_hash_mismatches_never_render(self):
        manifest, files = photo_fixture()
        body = write_bundle(self.bundle, manifest, files)
        original = handoff(manifest, body, photo_proposal(manifest))
        cases = []
        for field, value in (("projectId", "wrong-project"), ("jobId", "wrong-job"),
                             ("inputRevision", 999), ("bundleSha256", "0" * 64)):
            packet = deepcopy(original)
            packet[field] = value
            cases.append((field, packet))
        packet = deepcopy(original)
        packet["photoSha256"][manifest["photos"][0]["id"]] = "0" * 64
        cases.append(("photoSha256", packet))
        for field, packet in cases:
            with self.subTest(field=field):
                proposal_file = self.root / f"bad-{field}.json"
                proposal_file.write_text(json.dumps(packet))
                output = self.root / f"rejected-{field}"
                with patch("reconstruction.capture.pipeline.generate") as generate:
                    with self.assertRaises(ResearchError):
                        run(self.bundle, output, proposal_file=proposal_file, render=True)
                generate.assert_not_called()
                self.assertFalse((output / "reconstruction.request.json").exists())
                self.assertEqual(json.loads((output / "capture.dossier.json").read_text())["status"], "failed")

    def test_photo_only_provider_failure_preserves_photos_and_failed_dossier(self):
        manifest, files = photo_fixture()
        write_bundle(self.bundle, manifest, files)
        provider = unittest.mock.Mock()
        provider.extract.side_effect = RuntimeError("vision transport failed")
        with patch("reconstruction.capture.pipeline.generate") as generate:
            with self.assertRaisesRegex(RuntimeError, "vision transport failed"):
                run(self.bundle, self.output, geometry_provider=provider, render=True)
        provider.extract.assert_called_once()
        generate.assert_not_called()
        result = json.loads((self.output / "capture.dossier.json").read_text())
        self.assertEqual(result["status"], "failed")
        self.assertIsNone(result["reconstructionRequestPath"])
        self.assertIsNone(result["draftManifestPath"])
        for filename, body in files.items():
            self.assertEqual((self.output / filename).read_bytes(), body)

    @unittest.skipUnless(os.environ.get("BLENDER_BIN"), "Set BLENDER_BIN for actual capture-to-Blender integration")
    def test_real_blender_build_from_measured_guided_capture(self):
        self.prepare()
        result = run(self.bundle, self.output, render=True, blender=os.environ["BLENDER_BIN"])
        self.assertEqual(result["status"], "ready_for_review")
        self.assertEqual(result["draftManifestPath"], "draft/manifest.json")
        draft = self.output / "draft"
        manifest = json.loads((draft / "manifest.json").read_text())
        self.assertEqual(manifest["projectId"], "synthetic-capture-project")
        self.assertEqual(manifest["jobId"], "synthetic-capture-job")
        self.assertEqual(manifest["inputRevision"], 7)
        self.assertEqual(manifest["statistics"]["entityCount"], 6)
        self.assertEqual(manifest["statistics"]["meshCount"], 5)
        self.assertTrue((draft / "scene.blend").read_bytes().startswith(b"BLENDER"))
        glb = (draft / "scene.glb").read_bytes()
        magic, version, length = struct.unpack("<4sII", glb[:12])
        self.assertEqual((magic, version, length), (b"glTF", 2, len(glb)))
        for kind, artifact in manifest["files"].items():
            data = (draft / artifact["fileName"]).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), artifact["sha256"], kind)
            self.assertEqual(len(data), artifact["byteLength"], kind)


if __name__ == "__main__":
    unittest.main()
