from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from reconstruction.appearance import request_sha256
from reconstruction.design_profile import read_design_profile, validate_design_profile
from reconstruction.geometry import GeometryError, validate_request

FIXTURE = Path(__file__).parents[1] / "fixtures/living-room.request.json"


class DesignProfileTests(unittest.TestCase):
    def setUp(self):
        self.request = json.loads(FIXTURE.read_text())
        photo_evidence = {**deepcopy(self.request["evidence"][0]), "id": "photo-evidence",
                          "claim": "Actual captured room photo", "dimensionStatus": None}
        self.request["evidence"].append(photo_evidence)
        self.request["items"] = [{"id": "owned-chair", "roomId": "living-room", "label": "Detected chair",
            "origin": "existing_owned", "productId": None, "assetUrl": None,
            "position": [1.5, 0, 1.1], "rotationY": .53, "dimensions": [.8, .9, .6],
            "locked": True, "evidenceIds": ["synthetic-reference"]}]
        self.request = validate_request(self.request)
        body = b"synthetic image evidence, not a phone capture"
        self.photos = [{"id": "photo-one", "evidenceId": "photo-evidence",
                        "sha256": hashlib.sha256(body).hexdigest(), "body": body,
                        "cameraToWorld": [1, 0, 0, 0] * 4}]
        self.surface = {"entityId": "living-room", "finish": "carpet", "color": "#BAA99D",
            "secondaryColor": "#EEEEEE", "pattern": "dash", "roughness": .9,
            "repeatMeters": .2, "rotationDegrees": 90, "confidence": "medium",
            "evidenceIds": ["photo-evidence"]}
        self.item = {"itemId": "owned-chair", "label": "Curved plywood armchair",
            "model": "loop_arm_plywood_chair", "primaryColor": "#CE9B62", "secondaryColor": "#BE8B52",
            "frameColor": "#AAAAAA", "accentColor": "#222222", "pattern": "plain", "seatCount": 1,
            "confidence": "high", "evidenceIds": ["photo-evidence"], "notes": "Photo-informed approximate form."}
        self.profile = {"schemaVersion": "room-visual-design/1.0", "producer": "Codex local photo inspection",
            "projectId": self.request["projectId"], "jobId": self.request["jobId"],
            "inputRevision": self.request["inputRevision"], "inputSha256": request_sha256(self.request),
            "sources": [{"photoId": "photo-one", "evidenceId": "photo-evidence", "sha256": self.photos[0]["sha256"]}],
            "surfaces": [self.surface], "items": [self.item], "notes": ["Hidden details remain inferred."]}

    def validate(self, raw=None, request=None, photos=None):
        return validate_design_profile(self.profile if raw is None else raw,
            self.request if request is None else request, self.photos if photos is None else photos)

    def test_photo_cited_profile_preserves_inputs_and_normalizes_colors(self):
        before_request, before_profile = deepcopy(self.request), deepcopy(self.profile)
        result = self.validate()
        self.assertEqual(result["items"][0]["primaryColor"], "#ce9b62")
        self.assertEqual(result["surfaces"][0]["color"], "#baa99d")
        self.assertEqual(self.request, before_request)
        self.assertEqual(self.profile, before_profile)
        self.assertEqual(result["inputSha256"], request_sha256(self.request))
        self.assertNotIn("geometry", result)
        self.assertNotIn("dimensions", result["items"][0])

    def test_partial_and_unresolved_assignments_retain_fallback(self):
        result = self.validate({**self.profile, "surfaces": [], "items": []})
        self.assertEqual(result["items"], [])
        unresolved = {**self.item, "model": "unresolved_proxy", "confidence": "low"}
        self.assertEqual(self.validate({**self.profile, "items": [unresolved]})["items"][0]["model"], "unresolved_proxy")

    def test_photo_observed_inset_dash_floor_preserves_estimated_zone_repeat(self):
        surface={**self.surface,"pattern":"inset_dash","repeatMeters":4.}
        result=self.validate({**self.profile,"surfaces":[surface]})
        self.assertEqual(result["surfaces"][0]["pattern"],"inset_dash")
        self.assertEqual(result["surfaces"][0]["repeatMeters"],4.)

    def test_stale_identity_revision_hash_and_changed_request_are_rejected(self):
        for updates in ({"projectId": "another"}, {"jobId": "another"}, {"inputRevision": 2},
                        {"inputRevision": True}, {"inputRevision": float(self.request["inputRevision"])},
                        {"inputSha256": "0" * 64}, {"schemaVersion": "future"}):
            with self.subTest(updates=updates), self.assertRaises(GeometryError):
                self.validate({**self.profile, **updates})
        changed = deepcopy(self.request)
        changed["items"][0]["position"][0] += .1
        with self.assertRaises(GeometryError):
            self.validate(request=changed)

    def test_source_photo_identity_evidence_hash_and_actual_bytes_are_bound(self):
        source = self.profile["sources"][0]
        for updates in ({"photoId": "unknown"}, {"evidenceId": "synthetic-reference"}, {"sha256": "f" * 64}):
            with self.subTest(updates=updates), self.assertRaises(GeometryError):
                self.validate({**self.profile, "sources": [{**source, **updates}]})
        with self.assertRaises(GeometryError):
            self.validate(photos=[{**self.photos[0], "body": b"changed"}])
        with self.assertRaises(GeometryError):
            self.validate({**self.profile, "sources": [source, source]})
        with self.assertRaises(GeometryError):
            self.validate(photos=[self.photos[0], self.photos[0]])
        with self.assertRaises(GeometryError):
            self.validate(photos=[])

    def test_known_entities_and_unique_item_bindings_only(self):
        for field, record, identity in (("surfaces", self.surface, "entityId"), ("items", self.item, "itemId")):
            for bindings in ([{**record, identity: "unknown"}], [record, record]):
                with self.subTest(field=field, bindings=bindings), self.assertRaises(GeometryError):
                    self.validate({**self.profile, field: bindings})
        for field, record in (("surfaces", self.surface), ("items", self.item)):
            for evidence in ([], ["synthetic-reference"], ["photo-evidence", "photo-evidence"]):
                with self.subTest(field=field, evidence=evidence), self.assertRaises(GeometryError):
                    self.validate({**self.profile, field: [{**record, "evidenceIds": evidence}]})

    def test_geometry_and_execution_injection_are_rejected(self):
        for updates in ({"geometry": self.request["geometry"]}, {"position": [0, 0, 0]}, {"script": "run()"}):
            with self.subTest(updates=updates), self.assertRaises(GeometryError):
                self.validate({**self.profile, **updates})
        for updates in ({"dimensions": [1, 2, 3]}, {"position": [1, 2, 3]}, {"rotationY": 0},
                        {"assetUrl": "https://example.com/model.glb"}, {"model": "execute-python"}):
            with self.subTest(updates=updates), self.assertRaises(GeometryError):
                self.validate({**self.profile, "items": [{**self.item, **updates}]})

    def test_numeric_material_and_color_bounds(self):
        for updates in ({"roughness": True}, {"roughness": .01}, {"roughness": 1.1},
                        {"repeatMeters": .001}, {"repeatMeters": 21}, {"rotationDegrees": float("nan")},
                        {"rotationDegrees": 361}, {"finish": "metal"}, {"color": "rgb(1,2,3)"},
                        {"secondaryColor": "#12345678"}, {"pattern": "python"}, {"confidence": "measured"}):
            with self.subTest(updates=updates), self.assertRaises(GeometryError):
                self.validate({**self.profile, "surfaces": [{**self.surface, **updates}]})
        for seat_count in (0, 5, True, 1.0, float("inf")):
            with self.subTest(seat_count=seat_count), self.assertRaises(GeometryError):
                self.validate({**self.profile, "items": [{**self.item, "seatCount": seat_count}]})

    def test_full_staged_metadata_without_body_supports_keyless_handoff(self):
        metadata = {k: v for k, v in self.photos[0].items() if k != "body"}
        self.assertEqual(self.validate(photos=[metadata])["sources"], self.profile["sources"])
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "design.json"
            path.write_text(json.dumps(self.profile))
            self.assertEqual(read_design_profile(path, self.request, [metadata]), self.validate())

    def test_all_32_staged_photos_can_bind_beyond_appearance_subset(self):
        request = deepcopy(self.request)
        photos = deepcopy(self.photos)
        for index in range(1, 32):
            ident = "photo-evidence-" + str(index)
            request["evidence"].append({**deepcopy(request["evidence"][-1]), "id": ident})
            photos.append({**deepcopy(photos[0]), "id": "photo-" + str(index), "evidenceId": ident})
        profile = deepcopy(self.profile)
        profile["inputSha256"] = request_sha256(request)
        profile["sources"] = [{"photoId": p["id"], "evidenceId": p["evidenceId"], "sha256": p["sha256"]} for p in photos]
        profile["items"][0]["evidenceIds"] = [photos[-1]["evidenceId"]]
        result = self.validate(profile, request=request, photos=photos)
        self.assertEqual(len(result["sources"]), 32)
        self.assertEqual(result["items"][0]["evidenceIds"], ["photo-evidence-31"])

    def test_reader_rejects_duplicates_nonfinite_malformed_and_oversize(self):
        for body in ('{"schemaVersion":"one","schemaVersion":"two"}', '{"value":NaN}',
                     '{"value":Infinity}', '{bad', '[' * 1500, ' ' * (2 * 1024 * 1024 + 1)):
            with self.subTest(length=len(body)), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "design.json"
                path.write_text(body)
                with self.assertRaises(GeometryError):
                    read_design_profile(path, self.request, self.photos)

    def test_collection_bounds(self):
        for field, values in (("sources", self.profile["sources"] * 33),
                              ("surfaces", [self.surface] * 545), ("items", [self.item] * 257),
                              ("notes", ["note"] * 65)):
            with self.subTest(field=field), self.assertRaises(GeometryError):
                self.validate({**self.profile, field: values})
        with self.assertRaises(GeometryError):
            self.validate(photos=self.photos * 33)


if __name__ == "__main__":
    unittest.main()
