"""HTTP service contract: auth, early validation, job lifecycle, and artifact privacy.

Requires reconstruction/service/requirements-dev.txt; skipped explicitly otherwise.
Blender-backed rendering runs only when BLENDER_BIN points at Blender 4.5+.
"""

import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

try:
    from fastapi.testclient import TestClient
    import python_multipart  # noqa: F401  (capture uploads need it; a partial install must skip, not error)
except ImportError:  # pragma: no cover - depends on optional service deps
    TestClient = None

from test_capture_pipeline import handoff, photo_fixture, photo_proposal, write_bundle
from test_roomplan import packet
from test_roomplan_photo_bundle import archive_bytes, fixture as photo_bundle_fixture

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "reconstruction" / "fixtures" / "living-room.request.json"
TOKEN = "test-token-that-is-long-enough-123"
UPLOAD_KEY = "phone-upload-key-long-enough-4567"


def _blender() -> str | None:
    candidate = os.environ.get("BLENDER_BIN")
    return candidate if candidate and Path(candidate).is_file() else None


@unittest.skipIf(TestClient is None, "service dependencies not installed (pip install -r reconstruction/service/requirements-dev.txt)")
class ServiceTests(unittest.TestCase):
    def setUp(self):
        from reconstruction.service.app import create_app
        from reconstruction.service.settings import Settings
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data = Path(self.temporary.name) / "data"
        self.settings = Settings(data_dir=self.data, api_key=TOKEN, upload_key=UPLOAD_KEY, blender=_blender() or "/nonexistent/blender")
        self.client = TestClient(create_app(self.settings))
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.auth = {"Authorization": f"Bearer {TOKEN}"}

    def wait(self, job_id, timeout=240):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = self.client.get(f"/v1/jobs/{job_id}", headers=self.auth).json()
            if job["status"] in ("succeeded", "failed"):
                return job
            time.sleep(0.05)
        self.fail(f"job {job_id} did not finish in {timeout}s")

    def staging_is_empty(self):
        return not any((self.data / "staging").iterdir())

    # --- auth: the service holds private room photos and addresses -------------

    def test_jobs_require_the_bearer_token(self):
        self.assertEqual(self.client.get("/healthz").status_code, 200)
        for headers in ({}, {"Authorization": "Bearer wrong-token-wrong-token-xx"}, {"Authorization": TOKEN}):
            response = self.client.post("/v1/jobs/geometry", content=FIXTURE.read_bytes(), headers=headers)
            self.assertEqual(response.status_code, 401, headers)
        self.assertEqual(self.client.get("/v1/capabilities").status_code, 401)

    def test_phone_upload_key_can_only_submit_and_poll_roomplan_scans(self):
        # The phone holds this key, so a leaked phone build must not expose other jobs or their files.
        phone = {"x-tadaima-upload-key": UPLOAD_KEY}
        submitted = self.client.post("/v1/jobs/roomplan?render=false", json=packet(), headers=phone)
        self.assertEqual(submitted.status_code, 202)
        job = self.wait(submitted.json()["id"])
        self.assertEqual(self.client.get(f"/v1/jobs/{job['id']}", headers=phone).status_code, 200)
        self.assertEqual(self.client.get("/v1/jobs", headers=phone).status_code, 401)
        artifact = f"/v1/jobs/{job['id']}/artifacts/reconstruction.request.json"
        self.assertEqual(self.client.get(artifact, headers=phone).status_code, 401)
        self.assertEqual(self.client.post("/v1/jobs/geometry", content=FIXTURE.read_bytes(), headers=phone).status_code, 401)
        geometry = self.client.post("/v1/jobs/geometry", content=FIXTURE.read_bytes(), headers=self.auth).json()
        self.assertEqual(self.client.get(f"/v1/jobs/{geometry['id']}", headers=phone).status_code, 404)
        wrong = {"x-tadaima-upload-key": "x" * len(UPLOAD_KEY)}
        self.assertEqual(self.client.post("/v1/jobs/roomplan", json=packet(), headers=wrong).status_code, 401)
        self.wait(geometry["id"])

    def test_settings_refuse_to_start_without_auth_unless_explicitly_local(self):
        from reconstruction.service.settings import Settings, SettingsError
        base = {"TADAIMA_DATA_DIR": str(self.data)}
        with mock.patch.dict(os.environ, base, clear=True):
            with self.assertRaises(SettingsError):
                Settings.from_env()
        with mock.patch.dict(os.environ, {**base, "TADAIMA_API_KEY": "short"}, clear=True):
            with self.assertRaises(SettingsError):
                Settings.from_env()
        with mock.patch.dict(os.environ, {**base, "TADAIMA_ALLOW_NO_AUTH": "1"}, clear=True):
            self.assertIsNone(Settings.from_env().api_key)

    # --- early validation: bad input must not consume a worker or leave files ---

    def test_invalid_geometry_is_rejected_before_queueing(self):
        bad = json.loads(FIXTURE.read_text())
        bad["geometry"]["rooms"][0]["floorPolygon"] = [[0, 0], [1, 0]]
        response = self.client.post("/v1/jobs/geometry", json=bad, headers=self.auth)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["error"], "GeometryError")
        self.assertTrue(self.staging_is_empty())
        self.assertFalse(any((self.data / "jobs").iterdir()))

    def test_oversized_body_is_refused(self):
        response = self.client.post("/v1/jobs/geometry", content=b" " * (2 * 1024 * 1024 + 1), headers=self.auth)
        self.assertEqual(response.status_code, 413)

    def test_open_roomplan_loop_is_rejected_before_queueing(self):
        scan = packet()
        scan["surfaces"] = [surface for surface in scan["surfaces"] if surface["id"] != "wall-1"]
        response = self.client.post("/v1/jobs/roomplan?render=false", json=scan, headers=self.auth)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["error"], "RoomPlanError")
        self.assertTrue(self.staging_is_empty())

    def test_provider_modes_fail_fast_when_keys_are_missing(self):
        # A paid-provider job that can only fail later should be refused up front.
        manifest, files = photo_fixture()
        bundle = Path(self.temporary.name) / "capture.zip"
        write_bundle(bundle, manifest, files)
        response = self.client.post("/v1/jobs/capture", headers=self.auth, data={"infer": "true"},
                                    files={"capture": ("capture.zip", bundle.read_bytes(), "application/zip")})
        self.assertEqual(response.status_code, 503)
        response = self.client.post("/v1/jobs/address", headers=self.auth, json={
            "projectId": "p1", "jobId": "j1", "address": "1 Example St, Los Angeles, CA"})
        self.assertEqual(response.status_code, 503)

    def test_address_rejects_contradictory_flags(self):
        response = self.client.post("/v1/jobs/address", headers=self.auth, json={
            "projectId": "p1", "jobId": "j1", "address": "1 Example St, Los Angeles, CA",
            "collectOnly": True, "renderDraft": True, "discovery": {}})
        self.assertEqual(response.status_code, 422)

    # --- lifecycle --------------------------------------------------------------

    def test_roomplan_job_produces_reviewable_geometry(self):
        response = self.client.post("/v1/jobs/roomplan?render=false", json=packet(), headers=self.auth)
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json()["status"], "queued")
        job = self.wait(response.json()["id"])
        self.assertEqual(job["status"], "succeeded", job["error"])
        self.assertTrue(job["result"]["reviewRequired"])
        names = {artifact["name"] for artifact in job["artifacts"]}
        self.assertEqual(names, {"roomplan.dossier.json", "reconstruction.request.json"})
        request = self.client.get(f"/v1/jobs/{job['id']}/artifacts/reconstruction.request.json", headers=self.auth)
        self.assertEqual(request.status_code, 200)
        self.assertEqual(request.json()["jobId"], "synthetic-native-job")

    def test_capture_job_with_keyless_proposal_handoff(self):
        manifest, files = photo_fixture()
        bundle_path = Path(self.temporary.name) / "capture.zip"
        body = write_bundle(bundle_path, manifest, files)
        proposal = json.dumps(handoff(manifest, body, photo_proposal(manifest))).encode()
        response = self.client.post("/v1/jobs/capture", headers=self.auth, data={"render": "false"}, files={
            "capture": ("capture.zip", body, "application/zip"),
            "proposal": ("proposal.json", proposal, "application/json")})
        self.assertEqual(response.status_code, 202, response.text)
        job = self.wait(response.json()["id"])
        self.assertEqual(job["status"], "succeeded", job["error"])
        # Photo-only scale is a guess; the API must keep saying so.
        self.assertTrue(job["result"]["reviewRequired"])
        self.assertTrue(any("unverified" in warning.lower() or "uncalibrated" in warning.lower()
                            for warning in job["result"]["warnings"]), job["result"]["warnings"])
        self.assertIn("reconstruction.request.json", {artifact["name"] for artifact in job["artifacts"]})

    def test_blender_failure_does_not_leak_private_paths(self):
        if _blender():
            self.skipTest("a working Blender is configured")
        response = self.client.post("/v1/jobs/geometry", content=FIXTURE.read_bytes(), headers=self.auth)
        job = self.wait(response.json()["id"])
        self.assertEqual(job["status"], "failed")
        self.assertNotIn(str(self.data), json.dumps(job["error"]))

    @unittest.skipUnless(_blender(), "set BLENDER_BIN to run Blender-backed service jobs")
    def test_geometry_job_renders_a_downloadable_glb(self):
        response = self.client.post("/v1/jobs/geometry", content=FIXTURE.read_bytes(), headers=self.auth)
        job = self.wait(response.json()["id"])
        self.assertEqual(job["status"], "succeeded", job["error"])
        glb = self.client.get(f"/v1/jobs/{job['id']}/artifacts/scene.glb", headers=self.auth)
        self.assertEqual(glb.headers["content-type"], "model/gltf-binary")
        self.assertEqual(glb.content[:4], b"glTF")
        self.assertEqual(len(glb.content), job["result"]["manifest"]["files"]["glb"]["byteLength"])

    @unittest.skipUnless(_blender(), "set BLENDER_BIN to run Blender-backed service jobs")
    def test_roomplan_job_renders_a_draft(self):
        response = self.client.post("/v1/jobs/roomplan", json=packet(), headers=self.auth)
        job = self.wait(response.json()["id"])
        self.assertEqual(job["status"], "succeeded", job["error"])
        names = {artifact["name"] for artifact in job["artifacts"]}
        # The web importer needs the normalized scene.json that the GLB was built from.
        self.assertTrue({"draft/scene.glb", "draft/scene.json"} <= names, names)

    def test_phone_photo_bundle_zip_is_accepted_as_a_roomplan_job(self):
        # TadaimaScan's "scan + photos" export is a ZIP; the phone uploads it as-is.
        body = archive_bytes(*photo_bundle_fixture(count=2))
        response = self.client.post("/v1/jobs/roomplan?render=false", content=body, headers=self.auth)
        self.assertEqual(response.status_code, 202, response.text)
        self.assertTrue(response.json()["params"]["photos"])
        job = self.wait(response.json()["id"])
        self.assertEqual(job["status"], "succeeded", job["error"])
        self.assertEqual(job["result"]["photoCount"], 2)

    def test_corrupt_photo_bundle_is_rejected_before_queueing(self):
        response = self.client.post("/v1/jobs/roomplan", content=b"PK\x03\x04 not really a zip", headers=self.auth)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["error"], "RoomPlanError")
        self.assertTrue(self.staging_is_empty())

    def test_recent_jobs_are_listed_newest_first_and_filterable(self):
        # The /rooms phone inbox polls this list to find the scan that just arrived.
        first = self.client.post("/v1/jobs/roomplan?render=false", json=packet(), headers=self.auth).json()["id"]
        second = self.client.post("/v1/jobs/geometry", content=FIXTURE.read_bytes(), headers=self.auth).json()["id"]
        listed = [job["id"] for job in self.client.get("/v1/jobs", headers=self.auth).json()["jobs"]]
        self.assertEqual(listed[:2], [second, first])
        only = self.client.get("/v1/jobs?kind=roomplan", headers=self.auth).json()["jobs"]
        self.assertEqual([job["id"] for job in only], [first])
        self.assertEqual(self.client.get("/v1/jobs?kind=bogus", headers=self.auth).status_code, 422)
        self.assertEqual(self.client.get("/v1/jobs").status_code, 401)
        for job_id in (first, second):  # let workers finish before the temp data dir is removed
            self.wait(job_id)

    # --- privacy: only allow-listed outputs leave the service -------------------

    def test_artifact_downloads_are_allow_listed(self):
        response = self.client.post("/v1/jobs/roomplan?render=false", json=packet(), headers=self.auth)
        job = self.wait(response.json()["id"])
        for name in ("scan.input.json", "../input.json", "../../jobs.sqlite3", "%2e%2e/input.json"):
            self.assertEqual(self.client.get(f"/v1/jobs/{job['id']}/artifacts/{name}", headers=self.auth).status_code,
                             404, name)
        self.assertEqual(self.client.get("/v1/jobs/not-a-job", headers=self.auth).status_code, 404)

    def test_restart_marks_unfinished_jobs_failed(self):
        from reconstruction.service.app import create_app
        from reconstruction.service.jobs import JobStore
        store = JobStore(self.data / "jobs.sqlite3")
        job_id = store.create("geometry", {})
        store.mark_running(job_id)
        with TestClient(create_app(self.settings)) as restarted:
            job = restarted.get(f"/v1/jobs/{job_id}", headers=self.auth).json()
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["error"]["error"], "Interrupted")


if __name__ == "__main__":
    unittest.main()
