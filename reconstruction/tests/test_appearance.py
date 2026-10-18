from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO

from reconstruction.appearance import (FileAppearanceProvider, infer_appearance,
    prepare_appearance, read_photos, request_sha256, main)
from reconstruction.geometry import GeometryError, validate_request

FIXTURE = Path(__file__).parents[1] / "fixtures/living-room.request.json"


class Provider:
    def __init__(self, proposal):
        self.proposal = proposal
        self.calls = []
    def extract(self, prompt, assets, schema):
        self.calls.append((prompt, assets, schema))
        return deepcopy(self.proposal)


class AppearanceTests(unittest.TestCase):
    def setUp(self):
        self.request = validate_request(json.loads(FIXTURE.read_text()))
        evidence = deepcopy(self.request["evidence"][0])
        evidence.update(id="photo-evidence", claim="Room photo", dimensionStatus=None)
        self.request["evidence"].append(evidence)
        # Byte boundary tests; actual render verification uses an inspected JPEG.
        body = b"\xff\xd8\xffappearance-test"
        self.photos = [{"id": "photo1", "evidenceId": evidence["id"], "body": body,
                        "sha256": hashlib.sha256(body).hexdigest(), "mediaType": "image/jpeg", "scope": "captured_room"}]
        self.surface = {"entityId": self.request["geometry"]["rooms"][0]["id"], "finish": "wood", "color": "#A9A296",
                        "roughness": .7, "tileMeters": 1.2, "rotationDegrees": 90,
                        "confidence": "medium", "evidenceIds": [evidence["id"]]}
        self.proposal = {"surfaces": [self.surface], "notes": ["Proxy material; review color under neutral light."]}

    def infer(self, proposal=None, photos=None):
        return infer_appearance(self.request, photos or self.photos, Provider(proposal or self.proposal))

    def test_actual_bytes_geometry_preserved_and_no_input_mutation(self):
        before = deepcopy(self.request)
        provider = Provider(self.proposal)
        result = infer_appearance(self.request, self.photos, provider)
        self.assertEqual(before, self.request)
        self.assertEqual(result["geometry"], before["geometry"])
        self.assertEqual(provider.calls[0][1][0]["body"], self.photos[0]["body"])
        self.assertEqual(result["appearance"]["surfaces"][0]["color"], "#a9a296")
        self.assertIs(result["appearance"]["reviewRequired"], True)
        self.assertEqual(validate_request(result), result)

    def test_scope_cannot_be_upgraded(self):
        self.photos[0]["scope"] = "building_reference"
        self.assertEqual(self.infer()["appearance"]["scope"], "building_reference")
        self.photos[0]["scope"] = "unknown"
        self.assertEqual(self.infer()["appearance"]["scope"], "unknown")

    def test_uncited_surfaces_remain_defaults(self):
        result = self.infer({"surfaces": [], "notes": ["Insufficient visibility; no assignments."]})
        self.assertEqual(result["appearance"]["sources"], [])
        self.assertEqual(result["appearance"]["scope"], "unknown")

    def test_hash_mismatch_rejected_before_provider_call(self):
        self.photos[0]["body"] += b"changed"
        provider = Provider(self.proposal)
        with self.assertRaises(GeometryError):
            infer_appearance(self.request, self.photos, provider)
        self.assertEqual(provider.calls, [])

    def test_non_photo_and_missing_scope_rejected(self):
        for updates in ({"mediaType": "application/pdf"}, {"scope": "exact_building"}, {"evidenceId": "unknown"}):
            with self.subTest(updates=updates), self.assertRaises(GeometryError):
                self.infer(photos=[{**self.photos[0], **updates}])

    def test_bad_proposals_rejected(self):
        for updates in ({"entityId": "unknown"}, {"evidenceIds": ["made-up-photo"]},
                        {"roughness": 10}, {"tileMeters": 0}, {"rotationDegrees": 361},
                        {"color": "red"}, {"roughness": True}, {"confidence": "measured"},
                        {"finish": "script"}, {"evidenceIds": ["photo-evidence", "photo-evidence"]}):
            with self.subTest(updates=updates), self.assertRaises(GeometryError):
                self.infer({"surfaces": [{**self.surface, **updates}], "notes": []})
        with self.assertRaises(GeometryError):
            self.infer({"surfaces": [self.surface, self.surface], "notes": []})

    def test_optional_profile_validates_strictly(self):
        result = self.infer()
        for updates in ({"reviewRequired": False}, {"reviewRequired": 1}, {"scope": "verified"},
                        {"sources": []}, {"schemaVersion": "future"}, {"extra": "no"}):
            with self.subTest(updates=updates), self.assertRaises(GeometryError):
                validate_request({**result, "appearance": {**result["appearance"], **updates}})

    def test_handoff_binds_geometry_revision_and_photos(self):
        packet = prepare_appearance(self.request, self.photos)
        handoff = {key: packet[key] for key in ("projectId", "jobId", "inputRevision", "inputSha256", "photoSha256")}
        handoff.update(schemaVersion="appearance-handoff/1.0", producer="Codex inspected photos", proposal=self.proposal)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "handoff.json"
            path.write_text(json.dumps(handoff))
            provider = FileAppearanceProvider(path, self.request, self.photos)
            self.assertTrue(infer_appearance(self.request, self.photos, provider)["appearance"]["surfaces"])
            for field, value in (("inputRevision", 999), ("inputSha256", "0" * 64), ("photoSha256", {}), ("projectId", "other")):
                path.write_text(json.dumps({**handoff, field: value}))
                with self.subTest(field=field), self.assertRaises(GeometryError):
                    infer_appearance(self.request, self.photos, FileAppearanceProvider(path, self.request, self.photos))

    def test_photo_manifest_confines_paths_and_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as other:
            root = Path(directory)
            (root / "photo.jpg").write_bytes(self.photos[0]["body"])
            entry = {key: value for key, value in self.photos[0].items() if key != "body"}
            manifest = root / "photos.json"
            manifest.write_text(json.dumps({"photos": [{**entry, "path": "photo.jpg"}]}))
            self.assertEqual(read_photos(manifest)[0]["body"], self.photos[0]["body"])
            (root / "escape").symlink_to(other, target_is_directory=True)
            (Path(other) / "photo.jpg").write_bytes(self.photos[0]["body"])
            for path in ("../outside.jpg", "escape/photo.jpg", str(root / "photo.jpg")):
                manifest.write_text(json.dumps({"photos": [{**entry, "path": path}]}))
                with self.subTest(path=path), self.assertRaises(GeometryError):
                    read_photos(manifest)

    def test_request_hash_changes_for_geometry_and_appearance(self):
        result = self.infer()
        self.assertNotEqual(request_sha256(self.request), request_sha256(result))
        changed = deepcopy(self.request)
        changed["inputRevision"] += 1
        self.assertNotEqual(request_sha256(self.request), request_sha256(changed))

    def test_cli_writes_private_fresh_file_and_rejects_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "input.json").write_text(json.dumps(self.request))
            (root / "photo.jpg").write_bytes(self.photos[0]["body"])
            photo = {key: value for key, value in self.photos[0].items() if key != "body"}
            (root / "photos.json").write_text(json.dumps({"photos": [{**photo, "path": "photo.jpg"}]}))
            args = ["--input", str(root / "input.json"), "--photos", str(root / "photos.json"), "--output", str(root / "packet.json")]
            with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                self.assertEqual(main(args), 0)
                before = (root / "packet.json").read_bytes()
                self.assertEqual(main(args), 2)
            self.assertEqual(before, (root / "packet.json").read_bytes())
            self.assertEqual((root / "packet.json").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
