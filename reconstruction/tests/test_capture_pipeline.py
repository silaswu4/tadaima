"""End-to-end capture archive tests using explicitly synthetic JPEG headers.

The small test image fixtures have readable dimensions but are not real camera
photographs or photogrammetric inputs. Blender consumes only validated geometry.
"""

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
from reconstruction.capture.pipeline import run


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
