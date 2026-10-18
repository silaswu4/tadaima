"""Photo inference contracts with synthetic headers and synthetic model output.

No test calls a model or claims that these header fixtures are camera photos.
The tests prove byte binding, provider input, geometry gating, and provenance.
"""

from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from reconstruction.address.providers import ProviderError
from reconstruction.address.schema import ResearchError
from reconstruction.capture.vision import FilePhotoGeometryProvider, infer_capture, write_inference_request
from reconstruction.geometry import validate_request

NOW = "2026-10-18T08:00:00Z"


def fixture(count=4):
    photos, files = [], {}
    for index in range(count):
        ident = f"photo-{index}"
        body = (b"\xff\xd8\xff\xc0\x00\x11\x08" + struct.pack(">HH", 480, 640)
                + b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
                + b"synthetic-header-fixture-" + str(index).encode() + b"\xff\xd9")
        filename = f"photos/{ident}.jpg"
        photos.append({"id": ident, "fileName": filename, "sha256": hashlib.sha256(body).hexdigest(),
                       "mediaType": "image/jpeg", "width": 640, "height": 480,
                       "wall": "abcd"[index % 4], "capturedAt": NOW,
                       "quality": {"meanLuminance": 100, "edgeEnergy": 10}})
        files[filename] = body
    manifest = {"schemaVersion": "mobile-capture/1.0", "jobId": "photo-job", "projectId": "photo-project",
                "inputRevision": 4, "capturedAt": NOW, "captureMode": "photo_inference",
                "room": {"id": "room-photo", "label": "Synthetic room", "shape": "rectangle",
                         "clearWidth": None, "clearDepth": None, "height": None, "wallThickness": None,
                         "confirmedRectangularAt": None}, "photos": photos, "openings": []}
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("capture.json", json.dumps(manifest))
        for filename, body in files.items():
            archive.writestr(filename, body)
    return {"manifest": manifest, "files": files, "warnings": [],
            "sha256": hashlib.sha256(memory.getvalue()).hexdigest()}


def proposal():
    return {"summary": "Synthetic uncalibrated rectangular approximation.",
            "room": {"clearWidth": 5, "clearDepth": 4, "height": 2.7,
                     "photoIds": ["photo-0", "photo-1", "photo-2", "photo-3"]},
            "openings": [{"id": "door-estimated", "wall": "a", "kind": "door", "offset": 1,
                          "width": 0.9, "height": 2.1, "sillHeight": 0, "photoIds": ["photo-0"]}],
            "assumptions": ["Absolute scale is estimated from familiar objects, not measured."],
            "captureRequests": []}


class FakeProvider:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def extract(self, prompt, assets, output_schema):
        self.calls.append({"prompt": prompt, "assets": deepcopy(assets), "schema": deepcopy(output_schema)})
        result = self.responses[min(len(self.calls) - 1, len(self.responses) - 1)]
        if isinstance(result, Exception):
            raise result
        return deepcopy(result)


class PhotoInferenceTests(unittest.TestCase):
    def setUp(self):
        self.bundle = fixture()

    def test_actual_image_bytes_are_supplied_and_geometry_is_inferred(self):
        provider = FakeProvider(proposal())
        result = infer_capture(self.bundle, provider)
        self.assertEqual(len(provider.calls), 1)
        for asset in provider.calls[0]["assets"]:
            self.assertEqual(asset["body"], self.bundle["files"][f"photos/{asset['id']}.jpg"])
            self.assertEqual(asset["mediaType"], "image/jpeg")
        self.assertEqual(result["status"], "needs_review")
        self.assertTrue(result["reviewRequired"])
        self.assertEqual(result["photoUsage"], "vision_input")
        self.assertEqual(result["method"], "vision_estimated_rectangular_shell")
        self.assertEqual(result["missingMeasurements"], [])
        self.assertEqual(result["captureRequests"], [])
        self.assertEqual(result["request"], validate_request(result["request"]))
        evidence = result["request"]["evidence"]
        self.assertTrue(all(e["dimensionStatus"] in (None, "inferred") for e in evidence))
        self.assertTrue(all(e["confirmedByUserAt"] is None for e in evidence))
        self.assertTrue(all(e["sourceUrl"] is None for e in evidence))

    def test_no_rectangular_confirmation_is_fabricated_or_added_to_input(self):
        original = deepcopy(self.bundle)
        result = infer_capture(self.bundle, FakeProvider(proposal()))
        self.assertIsNone(self.bundle["manifest"]["room"]["confirmedRectangularAt"])
        self.assertEqual(self.bundle, original)
        self.assertTrue(all(e["confirmedByUserAt"] is None for e in result["request"]["evidence"]))

    def test_null_room_returns_capture_requests_without_fallback_dimensions(self):
        response = {"summary": "Blank/occluded images cannot support a coherent room.", "room": None,
                    "openings": [], "assumptions": [],
                    "captureRequests": ["Photograph each corner with overlapping views and more light."]}
        provider = FakeProvider(response)
        result = infer_capture(self.bundle, provider)
        self.assertEqual(result["status"], "needs_capture")
        self.assertIsNone(result["request"])
        self.assertEqual(result["missingMeasurements"], [])
        self.assertEqual(result["captureRequests"], response["captureRequests"])
        self.assertEqual(len(provider.calls[0]["assets"]), 4)
        self.assertNotIn("tape", " ".join(result["captureRequests"]).lower())

    def test_null_room_requires_useful_photo_requests_and_no_openings(self):
        for openings, requests in (([], []), (proposal()["openings"], ["Show the corners."])):
            with self.subTest(openings=openings):
                response = {"summary": "Not enough visible room.", "room": None, "openings": openings,
                            "assumptions": [], "captureRequests": requests}
                with self.assertRaises(ResearchError):
                    infer_capture(self.bundle, FakeProvider(response))

    def test_empty_unknown_and_duplicate_photo_citations_reject(self):
        for refs in ([], ["not-a-photo"], ["photo-0", "photo-0"]):
            with self.subTest(refs=refs):
                value = proposal()
                value["room"]["photoIds"] = refs
                with self.assertRaises(ResearchError):
                    infer_capture(self.bundle, FakeProvider(value))

    def test_opening_evidence_is_restricted_to_its_explicit_cited_photo(self):
        value = proposal()
        value["room"]["photoIds"] = ["photo-0", "photo-1"]
        value["openings"][0]["photoIds"] = ["photo-2"]
        result = infer_capture(self.bundle, FakeProvider(value))
        request = result["request"]
        evidence = {e["id"]: e for e in request["evidence"]}
        aperture = request["geometry"]["openings"][0]
        photo_refs = [evidence[ref] for ref in aperture["evidenceIds"] if evidence[ref]["dimensionStatus"] is None]
        self.assertEqual(len(photo_refs), 1)
        self.assertTrue(photo_refs[0]["privateAssetId"].endswith("photos/photo-2.jpg"))
        self.assertEqual(result["citations"]["openings"], {"door-estimated": ["photo-2"]})

    def test_existing_measurements_do_not_override_visual_output(self):
        for key, value in (("clearWidth", 80), ("clearDepth", 70), ("height", 10), ("wallThickness", 0.9)):
            self.bundle["manifest"]["room"][key] = {"valueMeters": value, "method": "tape", "observedAt": NOW}
        self.bundle["manifest"]["room"]["confirmedRectangularAt"] = NOW
        result = infer_capture(self.bundle, FakeProvider(proposal()))
        points = result["request"]["geometry"]["rooms"][0]["floorPolygon"]
        self.assertAlmostEqual(points[1][0], 5.06)
        self.assertAlmostEqual(points[2][1], 4.06)
        self.assertEqual(result["request"]["geometry"]["rooms"][0]["height"], 2.7)
        self.assertTrue(all(e["dimensionStatus"] != "measured" for e in result["request"]["evidence"]))

    def test_invalid_geometry_gets_one_repair_attempt(self):
        invalid = proposal()
        invalid["openings"][0]["offset"] = 4.8
        provider = FakeProvider(invalid, proposal())
        result = infer_capture(self.bundle, provider)
        self.assertEqual(len(provider.calls), 2)
        self.assertIn("One repair attempt", provider.calls[1]["prompt"])
        self.assertEqual(result["status"], "needs_review")

    def test_twice_invalid_geometry_fails_without_defaults(self):
        invalid = proposal()
        invalid["room"]["clearWidth"] = -5
        provider = FakeProvider(invalid)
        with self.assertRaises(ResearchError):
            infer_capture(self.bundle, provider)
        self.assertEqual(len(provider.calls), 2)

    def test_nonfinite_geometry_is_rejected(self):
        invalid = proposal()
        invalid["room"]["height"] = float("nan")
        with self.assertRaises(ResearchError):
            infer_capture(self.bundle, FakeProvider(invalid))

    def test_provider_failure_is_not_retried(self):
        provider = FakeProvider(ProviderError("Synthetic provider failure"))
        with self.assertRaises(ProviderError):
            infer_capture(self.bundle, provider)
        self.assertEqual(len(provider.calls), 1)

    def test_hash_mismatch_fails_before_provider_call(self):
        self.bundle["files"]["photos/photo-0.jpg"] += b"changed"
        provider = FakeProvider(proposal())
        with self.assertRaisesRegex(ResearchError, "actual bundled image bytes"):
            infer_capture(self.bundle, provider)
        self.assertFalse(provider.calls)

    def test_missing_actual_image_or_extra_file_is_rejected(self):
        for mutate in (lambda files: files.pop("photos/photo-0.jpg"),
                       lambda files: files.update({"photos/extra.jpg": b"unexpected"})):
            with self.subTest(mutate=mutate):
                bundle = deepcopy(self.bundle)
                mutate(bundle["files"])
                with self.assertRaisesRegex(ResearchError, "files differ"):
                    infer_capture(bundle, FakeProvider(proposal()))

    def test_no_actual_images_cannot_create_a_room(self):
        with self.assertRaisesRegex(ResearchError, "requires actual room photos"):
            infer_capture(fixture(0), FakeProvider(proposal()))

    def test_at_most_eight_images_with_four_wall_coverage_prioritized(self):
        bundle = fixture(12)
        provider = FakeProvider(proposal())
        result = infer_capture(bundle, provider)
        supplied = provider.calls[0]["assets"]
        self.assertEqual(len(supplied), 8)
        self.assertEqual([a["id"] for a in supplied[:4]], ["photo-0", "photo-1", "photo-2", "photo-3"])
        archived = [e for e in result["request"]["evidence"] if "archived but not supplied" in e["claim"]]
        self.assertEqual(len(archived), 4)

    def test_cannot_cite_an_actual_photo_omitted_by_image_limit(self):
        value = proposal()
        value["room"]["photoIds"] = ["photo-11"]
        with self.assertRaisesRegex(ResearchError, "not supplied"):
            infer_capture(fixture(12), FakeProvider(value))


class FilePhotoHandoffTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "handoff.json"
        self.bundle = fixture()

    def packet(self):
        manifest = self.bundle["manifest"]
        return {"schemaVersion": "capture-geometry-handoff/1.0", "producer": "synthetic-test-agent",
                **{key: manifest[key] for key in ("projectId", "jobId", "inputRevision")},
                "bundleSha256": self.bundle["sha256"],
                "photoSha256": {photo["id"]: photo["sha256"] for photo in manifest["photos"]},
                "proposal": proposal()}

    def write(self, packet):
        self.path.write_text(json.dumps(packet))

    def test_bound_handoff_generates_reviewable_geometry_without_api_keys(self):
        self.write(self.packet())
        provider = FilePhotoGeometryProvider(self.path, self.bundle)
        result = infer_capture(self.bundle, provider)
        self.assertEqual(result["status"], "needs_review")
        self.assertEqual(provider.producer, "synthetic-test-agent")

    def test_wrong_identity_revision_or_bundle_hash_rejected(self):
        for key, invalid in (("jobId", "other-job"), ("projectId", "other-project"), ("inputRevision", 5),
                             ("inputRevision", 4.0), ("inputRevision", True), ("bundleSha256", "0" * 64)):
            with self.subTest(key=key, invalid=invalid):
                packet = self.packet()
                packet[key] = invalid
                self.write(packet)
                with self.assertRaises(ResearchError):
                    FilePhotoGeometryProvider(self.path, self.bundle)

    def test_full_photo_hash_set_and_actual_bytes_required(self):
        for mutate in (lambda hashes: hashes.pop("photo-0"),
                       lambda hashes: hashes.update({"photo-0": "0" * 64}),
                       lambda hashes: hashes.update({"unknown": "1" * 64})):
            with self.subTest(mutate=mutate):
                packet = self.packet()
                mutate(packet["photoSha256"])
                self.write(packet)
                with self.assertRaises(ResearchError):
                    FilePhotoGeometryProvider(self.path, self.bundle)

    def test_bound_provider_cannot_be_reused_for_another_job(self):
        self.write(self.packet())
        provider = FilePhotoGeometryProvider(self.path, self.bundle)
        other = deepcopy(self.bundle)
        other["manifest"]["jobId"] = "other-job"
        with self.assertRaisesRegex(ResearchError, "different capture identity"):
            infer_capture(other, provider)

    def test_changed_bytes_after_binding_fail(self):
        self.write(self.packet())
        provider = FilePhotoGeometryProvider(self.path, self.bundle)
        assets = [{"id": photo["id"], "mediaType": "image/jpeg",
                   "body": self.bundle["files"][photo["fileName"]]} for photo in self.bundle["manifest"]["photos"]]
        assets[0]["body"] += b"changed"
        with self.assertRaisesRegex(ResearchError, "changed after binding"):
            provider.extract("unused", assets, {})

    def test_static_invalid_geometry_fails_without_repair(self):
        packet = self.packet()
        packet["proposal"]["openings"][0]["sillHeight"] = 0.5
        self.write(packet)
        provider = FilePhotoGeometryProvider(self.path, self.bundle)
        with self.assertRaisesRegex(ResearchError, "door sillHeight"):
            infer_capture(self.bundle, provider)

    def test_packet_is_data_only_and_unknown_fields_are_rejected(self):
        packet = self.packet()
        packet["execute"] = "never executed"
        self.write(packet)
        with self.assertRaisesRegex(ResearchError, "unsupported fields"):
            FilePhotoGeometryProvider(self.path, self.bundle)

    def test_request_file_contains_relative_selected_photos_schema_and_full_hashes(self):
        path = Path(self.directory.name) / "request.json"
        result = write_inference_request(self.bundle, path)
        self.assertEqual(json.loads(path.read_text()), result)
        self.assertEqual(result["schemaVersion"], "capture-geometry-request/1.0")
        self.assertEqual(len(result["photos"]), 4)
        self.assertEqual(result["photos"][0]["fileName"], "photos/photo-0.jpg")
        self.assertEqual(result["photoSha256"], self.packet()["photoSha256"])
        self.assertEqual(result["outputSchema"]["type"], "object")
        self.assertIn("uncertain visual estimates", result["prompt"])
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            write_inference_request(self.bundle, path)


if __name__ == "__main__":
    unittest.main()
