"""Photo-appearance pipeline wiring with synthetic bytes; no model calls."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from reconstruction.appearance import infer_appearance as validate_inference, prepare_appearance
from reconstruction.address.pipeline import _appearance_photos, run as run_address
from reconstruction.address.schema import ResearchError
from reconstruction.capture.bundle import BundleError
from reconstruction.capture.pipeline import run as run_capture
from reconstruction.tests.test_address_pipeline import (
    FakeFetcher, FakeGeometry, FakeResearch, PHOTO_URL, PNG, address_request,
    discovery_fixture, proposal_fixture,
)
from reconstruction.tests.test_capture_pipeline import (
    capture_fixture, photo_fixture, photo_proposal, write_bundle,
)


class AppearanceInputTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.provider = object()
        self.calls = []

        def infer(request, photos, provider):
            self.calls.append((deepcopy(request), deepcopy(photos), provider))
            synthetic = Mock()
            synthetic.extract.return_value = {"surfaces": [{
                "entityId": request["geometry"]["rooms"][0]["id"], "finish": "tile",
                "color": "#a0a0a0", "roughness": .7, "tileMeters": 1,
                "rotationDegrees": 0, "confidence": "low", "evidenceIds": [photos[0]["evidenceId"]],
            }], "notes": ["Synthetic test response; not a real photo interpretation."]}
            return validate_inference(request, photos, synthetic)

        self.file_provider = Mock(return_value=self.provider)
        self.appearance = SimpleNamespace(infer_appearance=infer, FileAppearanceProvider=self.file_provider,
                                          prepare_appearance=prepare_appearance)
        self.addCleanup(patch.stopall)
        patch.dict("sys.modules", {"reconstruction.appearance": self.appearance}).start()

    def capture(self, *, photo_mode=False, **kwargs):
        manifest, files = photo_fixture() if photo_mode else capture_fixture()
        bundle = self.root / "capture.zip"
        write_bundle(bundle, manifest, files)
        if photo_mode:
            geometry = Mock()
            geometry.extract.return_value = photo_proposal(manifest)
            kwargs["geometry_provider"] = geometry
        dossier = run_capture(bundle, self.root / "capture-output", **kwargs)
        return manifest, files, dossier

    def address(self, *, discovery=None, fetcher=None, **kwargs):
        return run_address(address_request(), self.root / "address-output",
                           research_provider=FakeResearch([discovery or discovery_fixture()]),
                           geometry_provider=FakeGeometry(), fetcher=fetcher or FakeFetcher(), **kwargs)

    def test_capture_actual_bytes_and_existing_private_evidence_are_supplied(self):
        manifest, files, dossier = self.capture(appearance_provider=self.provider)
        request, photos, provider = self.calls[0]
        self.assertIs(provider, self.provider)
        self.assertEqual(len(photos), 4)
        evidence = {entry["id"]: entry for entry in request["evidence"]}
        for photo in photos:
            body = files[f"photos/{photo['id']}.jpg"]
            self.assertEqual(photo["body"], body)
            self.assertEqual(photo["sha256"], hashlib.sha256(body).hexdigest())
            self.assertEqual(photo["scope"], "captured_room")
            self.assertIsNone(evidence[photo["evidenceId"]]["dimensionStatus"])
            self.assertIsNone(evidence[photo["evidenceId"]]["confirmedByUserAt"])
            self.assertTrue(evidence[photo["evidenceId"]]["privateAssetId"].endswith(f"photos/{photo['id']}.jpg"))
        from reconstruction.capture.geometry import compile_capture
        self.assertEqual(request["geometry"], compile_capture(manifest)["request"]["geometry"])
        self.assertEqual(dossier["appearanceStatus"], "estimated_needs_review")
        self.assertEqual(dossier["photoUsage"], "vision_input")

    def test_photo_inference_then_appearance_retains_geometry(self):
        _, _, dossier = self.capture(photo_mode=True, appearance_provider=self.provider)
        self.assertEqual(dossier["status"], "needs_review")
        self.assertEqual(len(self.calls), 1)
        saved = json.loads((self.root / "capture-output/reconstruction.request.json").read_text())
        self.assertEqual(saved["geometry"], self.calls[0][0]["geometry"])

    def test_capture_file_provider_receives_same_verified_photos(self):
        path = self.root / "appearance.json"
        self.capture(appearance_file=path)
        self.assertEqual(self.file_provider.call_args.args[0], path)
        self.assertEqual(self.file_provider.call_args.args[1], self.calls[0][0])
        self.assertEqual(self.file_provider.call_args.args[2], self.calls[0][1])

    def test_capture_pending_geometry_does_not_invoke_appearance(self):
        manifest, files = photo_fixture()
        bundle = self.root / "capture.zip"
        write_bundle(bundle, manifest, files)
        dossier = run_capture(bundle, self.root / "capture-output", appearance_provider=self.provider)
        self.assertEqual(dossier["appearanceStatus"], "needs_geometry")
        self.assertFalse(self.calls)

    def test_address_only_photos_are_supplied_with_derived_provenance(self):
        dossier = self.address(appearance_provider=self.provider)
        request, photos, provider = self.calls[0]
        self.assertIs(provider, self.provider)
        self.assertEqual(len(photos), 1)
        photo = photos[0]
        self.assertEqual(photo["id"], "asset002")
        self.assertEqual(photo["body"], PNG + b"synthetic distinct photo")
        self.assertEqual(photo["scope"], "exact_unit")
        evidence = next(entry for entry in request["evidence"] if entry["id"] == photo["evidenceId"])
        self.assertEqual(evidence["sourceUrl"], PHOTO_URL)
        self.assertIsNone(evidence["dimensionStatus"])
        self.assertIsNone(evidence["confirmedByUserAt"])
        self.assertEqual(request["geometry"], proposal_fixture()["geometry"])
        self.assertEqual(dossier["status"], "needs_review")

    def test_building_gallery_never_upgrades_to_exact_unit(self):
        self.address(discovery=discovery_fixture(scope="building_generic"), appearance_provider=self.provider)
        self.assertEqual(self.calls[0][1][0]["scope"], "building_reference")

    def test_unassigned_photo_on_exact_unit_page_remains_unknown(self):
        discovery = discovery_fixture()
        discovery["assets"][1]["candidateId"] = None
        self.address(discovery=discovery, appearance_provider=self.provider)
        self.assertEqual(self.calls[0][1][0]["scope"], "unknown")

    def test_no_photo_keeps_draft_reviewable_and_does_not_call_model(self):
        discovery = discovery_fixture()
        discovery["assets"] = discovery["assets"][:1]
        dossier = self.address(discovery=discovery, appearance_provider=self.provider)
        self.assertEqual(dossier["appearanceStatus"], "needs_photos")
        self.assertEqual(dossier["status"], "needs_review")
        self.assertFalse(self.calls)
        self.assertTrue((self.root / "address-output/reconstruction.request.json").exists())

    def test_address_rechecks_bytes_before_appearance(self):
        dossier = self.address(collect_only=True)
        asset = dossier["assets"][1]
        output = self.root / "address-output"
        (output / asset["path"]).write_bytes(b"replaced bytes")
        with self.assertRaisesRegex(ResearchError, "bytes differ"):
            _appearance_photos({"evidence": []}, dossier, output, "candidate001")

    def test_address_appearance_is_limited_to_eight_distinct_supported_photos(self):
        dossier = self.address(collect_only=True)
        output = self.root / "address-output"
        template = deepcopy(dossier["assets"][1])
        for index in range(12):
            body = PNG + str(index).encode()
            asset = {**template, "id": f"extra-{index}", "path": f"assets/extra-{index}.png",
                     "sha256": hashlib.sha256(body).hexdigest(), "byteLength": len(body)}
            (output / asset["path"]).write_bytes(body)
            dossier["assets"].append(asset)
        request = {"jobId": "test", "projectId": "test", "evidence": []}
        photos = _appearance_photos(request, dossier, output, "candidate001")
        self.assertEqual(len(photos), 8)
        self.assertEqual(len({photo["sha256"] for photo in photos}), 8)
        self.assertEqual(len(request["evidence"]), 8)

    def test_conflicting_foreign_and_unsupported_photos_are_skipped(self):
        for changes in ({"conflictingCandidateIds": ["candidate002"]},
                        {"candidateId": "candidate002"}, {"mediaType": "image/webp"}):
            with self.subTest(changes=changes):
                dossier = {"sources": [{"id": "src", "scope": "exact_unit"}], "candidates": [],
                           "assets": [{"id": "photo", "kind": "photo", "status": "downloaded",
                                       "candidateId": None, "sha256": "a" * 64, "mediaType": "image/jpeg",
                                       **changes}]}
                self.assertEqual(_appearance_photos({"evidence": []}, dossier, self.root, "candidate001"), [])

    def test_appearance_is_opt_in_for_both_pipelines(self):
        _, _, capture = self.capture()
        address = self.address()
        self.assertNotIn("appearanceStatus", capture)
        self.assertNotIn("appearanceStatus", address)
        self.assertFalse(self.calls)

    def test_conflicting_appearance_options_fail_before_output_creation(self):
        with self.assertRaises(BundleError):
            run_capture(self.root / "absent.zip", self.root / "capture-output",
                        appearance_provider=self.provider, appearance_file=self.root / "a.json")
        with self.assertRaises(ResearchError):
            self.address(appearance_provider=self.provider, appearance_file=self.root / "a.json")
        self.assertFalse((self.root / "capture-output").exists())
        self.assertFalse((self.root / "address-output").exists())


if __name__ == "__main__":
    unittest.main()
