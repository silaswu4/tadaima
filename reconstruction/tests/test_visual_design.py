"""Keyless full-photo handoff; no network, provider credentials or image guesses."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from reconstruction.appearance import request_sha256
from reconstruction.design_profile import DESIGN_PROFILE_SCHEMA
from reconstruction.geometry import GeometryError
from reconstruction.roomplan import RoomPlanError, run
from reconstruction.tests.test_roomplan_photo_bundle import archive_bytes, fixture
from reconstruction.visual_design import main, prepare_visual_design


class VisualDesignTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name)
        self.manifest,self.files=fixture(32)
        self.bundle=self.root/"scan.zip"
        self.bundle.write_bytes(archive_bytes(self.manifest,self.files))
        self.imported=self.root/"imported"
        run(self.bundle,self.imported)
        self.input=self.imported/"reconstruction.request.json"
        self.request=json.loads(self.input.read_text())
        self.output=self.root/"handoff.json"

    def prepare(self,**kwargs):
        return prepare_visual_design(self.input,self.bundle,self.output,**kwargs)

    def test_all_32_actual_attachments_hashes_geometry_and_strict_schema_are_bound(self):
        before=self.input.read_bytes()
        packet=self.prepare()
        self.assertEqual(json.loads(self.output.read_text()),packet)
        self.assertEqual(packet["inputSha256"],request_sha256(self.request))
        self.assertEqual(packet["inputFileSha256"],hashlib.sha256(before).hexdigest())
        self.assertEqual(packet["sourceArchiveSha256"],hashlib.sha256(self.bundle.read_bytes()).hexdigest())
        self.assertEqual(packet["geometry"],self.request["geometry"])
        self.assertEqual(packet["items"],self.request.get("items",[]))
        self.assertEqual(packet["outputSchema"],DESIGN_PROFILE_SCHEMA)
        self.assertEqual(len(packet["imageAttachments"]),32)
        self.assertEqual(len(packet["sources"]),32)
        self.assertEqual(packet["photoSha256"],{photo["id"]:photo["sha256"] for photo in self.manifest["photos"]})
        self.assertTrue(packet["reviewRequired"])
        self.assertEqual(packet["status"],"needs_photo_analysis")
        self.assertIsNone(packet["registration"])
        self.assertEqual(packet["cameraRegistrationStatus"],"not_verified")
        self.assertNotIn("sourceToCanonicalTranslation",packet)
        for attachment,original in zip(packet["imageAttachments"],self.manifest["photos"]):
            self.assertFalse(Path(attachment["path"]).is_absolute())
            path=self.output.parent/attachment["path"]
            self.assertEqual(path.read_bytes(),self.files[original["path"]])
            self.assertEqual(attachment["cameraToWorld"],original["cameraToWorld"])
            self.assertEqual(attachment["intrinsics"],original["intrinsics"])
            self.assertNotIn("body",attachment)
            self.assertEqual(attachment["scope"],"captured_room")
        for field in ("inputPath","photoBundlePath"):
            self.assertFalse(Path(packet[field]).is_absolute())
        self.assertNotIn(str(self.root),self.output.read_text())
        self.assertEqual(self.input.read_bytes(),before)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode),0o600)

    def test_optional_registration_remains_estimated_unapplied_and_hash_bound(self):
        path=self.root/"candidate.json"
        context={"schemaVersion":"private-candidate/1.0","status":"registered",
                 "bindings":{"projectId":self.request["projectId"],"jobId":self.request["jobId"],
                             "inputRevision":self.request["inputRevision"],
                             "requestSha256":hashlib.sha256(self.input.read_bytes()).hexdigest()},
                 "matrixRows":[[1,0,0,1],[0,1,0,2],[0,0,1,3],[0,0,0,1]]}
        body=json.dumps(context).encode();path.write_bytes(body)
        result=self.prepare(registration=path)
        reg=result["registration"]
        self.assertEqual(reg["sha256"],hashlib.sha256(body).hexdigest())
        self.assertEqual(reg["context"],context)
        self.assertEqual(reg["status"],"estimated_context_requires_review")
        self.assertFalse(reg["applied"])
        self.assertFalse(Path(reg["path"]).is_absolute())
        self.assertEqual(result["cameraRegistrationStatus"],"estimated_context_only")
        self.assertNotIn("sourceToCanonicalMatrixRows",result)
        self.assertIn("estimated context, not proof",result["prompt"])

    def test_stale_malformed_duplicate_nonfinite_and_oversized_registration_fail_before_output(self):
        path=self.root/"candidate.json"
        bodies=[b'{"x":1,"x":2}',b'{"x":NaN}',b'{"x":1e999}',b'[]',b'bad',b'{}'+b' '*(2*1024*1024)]
        for bindings in ({"jobId":"other"},{"inputRevision":True},{"requestSha256":"0"*64},{"meshSha256":"0"*64}):
            bodies.append(json.dumps({"bindings":bindings}).encode())
        for body in bodies:
            path.write_bytes(body)
            with self.subTest(body=body[:60]),self.assertRaises(GeometryError):
                self.prepare(registration=path)
            self.assertFalse(self.output.exists())

    def test_existing_output_symlink_input_changes_and_tampered_original_photos_fail_closed(self):
        self.output.write_text("preserve")
        with self.assertRaises(GeometryError):self.prepare()
        self.assertEqual(self.output.read_text(),"preserve")
        self.output.unlink()
        self.output.symlink_to(self.root/"absent")
        with self.assertRaises(GeometryError):self.prepare()
        self.output.unlink()
        changed=deepcopy(self.request);changed["jobId"]="other-job"
        original=self.input.read_bytes();self.input.write_text(json.dumps(changed))
        with self.assertRaises(RoomPlanError):self.prepare()
        self.assertFalse(self.output.exists())
        self.input.write_bytes(original)
        photo=self.imported/self.manifest["photos"][0]["path"]
        photo.write_bytes(b"tampered")
        with self.assertRaisesRegex(GeometryError,"differs from the native archive"):self.prepare()
        self.assertFalse(self.output.exists())

    def test_missing_and_escaping_photo_attachments_do_not_create_broken_handoff(self):
        photo=self.imported/self.manifest["photos"][0]["path"]
        photo.unlink()
        with self.assertRaisesRegex(GeometryError,"original imported photos"):self.prepare()
        self.assertFalse(self.output.exists())
        external=self.root/"outside.jpg";external.write_bytes(self.files[self.manifest["photos"][0]["path"]])
        photo.symlink_to(external)
        with self.assertRaises(GeometryError):self.prepare()
        self.assertFalse(self.output.exists())

    def test_supported_draft_request_and_cli_need_no_provider_or_network(self):
        draft=self.imported/"draft";draft.mkdir()
        scene=draft/"scene.json";scene.write_bytes(self.input.read_bytes())
        result=prepare_visual_design(scene,self.bundle,self.output)
        self.assertEqual(len(result["imageAttachments"]),32)
        self.output.unlink()
        with patch.dict("os.environ",{},clear=True),patch("socket.socket",side_effect=AssertionError("Network forbidden")):
            self.assertEqual(main(["prepare","--input",str(self.input),"--photo-bundle",str(self.bundle),"--output",str(self.output)]),0)
        self.assertEqual(len(json.loads(self.output.read_text())["sources"]),32)


if __name__=="__main__":
    unittest.main()
