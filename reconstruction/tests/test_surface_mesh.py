"""Observed scan geometry boundaries; fixtures are synthetic, never phone scans."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import stat
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from reconstruction.pipeline import PipelineError, resolve_blender
from reconstruction.roomplan import RoomPlanError, run
from reconstruction.roomplan.mesh import validate_mesh
from reconstruction.roomplan.photo_bundle import read_photo_bundle
from reconstruction.roomplan.texture_source import prepare_texture_source
from reconstruction.tests.test_roomplan_photo_bundle import archive_bytes, fixture

ROOT = Path(__file__).resolve().parents[2]
try:
    BLENDER = resolve_blender()
except PipelineError:
    BLENDER = None


def mesh_fixture(identity):
    return {"schemaVersion": "roomplan-mesh/1.0",
        **{key: identity[key] for key in ("projectId", "jobId", "inputRevision")},
        "coordinateSystem": "arkit-gravity-y-up-metres", "captureMethod": "arkit-scene-reconstruction",
        "anchors": [{"id": "mesh-00000000-0000-4000-8000-000000000001",
            "transform": [1,0,0,0,0,1,0,0,0,0,1,0,.4,1.25,-.2,1],
            "vertices": [[0,0,0], [1,0,0], [.2,1,.1], [-.1,.4,.3]],
            "faces": [[0,1,2], [0,2,3]], "classifications": [1,0]}]}


def mesh_bundle():
    manifest, files = fixture()
    manifest["schemaVersion"] = "roomplan-photo-bundle/1.1"
    mesh = mesh_fixture(manifest)
    attach_mesh(manifest, files, mesh)
    return manifest, files, mesh


def attach_mesh(manifest, files, mesh):
    data = json.dumps(mesh).encode()
    files["mesh.json"] = data
    manifest["mesh"] = {"path": "mesh.json", "sha256": hashlib.sha256(data).hexdigest(), "byteLength": len(data)}


class SurfaceMeshTests(unittest.TestCase):
    def read(self, manifest, files):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "scan.zip"
            path.write_bytes(archive_bytes(manifest, files))
            return read_photo_bundle(path)

    def test_new_bundle_preserves_observed_faces_and_original_bytes(self):
        manifest, files, mesh = mesh_bundle()
        result = self.read(manifest, files)
        self.assertEqual(result["mesh"], mesh)
        self.assertEqual(result["files"]["mesh.json"], files["mesh.json"])
        self.assertEqual(validate_mesh(mesh, manifest), mesh)

    def test_new_manifest_requires_mesh_legacy_rejects_it_and_members_are_exact(self):
        manifest, files, _ = mesh_bundle()
        mutations = []
        legacy = deepcopy(manifest)
        legacy["schemaVersion"] = "roomplan-photo-bundle/1.0"
        mutations.append((legacy, files))
        absent = deepcopy(manifest)
        absent.pop("mesh")
        mutations.append((absent, files))
        mutations.append((manifest, {key: value for key, value in files.items() if key != "mesh.json"}))
        for changed, content in mutations:
            with self.subTest(manifest=changed), self.assertRaises(RoomPlanError):
                self.read(changed, content)

    def test_mesh_hash_length_path_crc_and_duplicate_json_fail_closed(self):
        manifest, files, _ = mesh_bundle()
        for key, value in (("sha256", "0" * 64), ("byteLength", True),
                           ("byteLength", len(files["mesh.json"]) + 1), ("path", "../mesh.json")):
            changed = deepcopy(manifest)
            changed["mesh"][key] = value
            with self.subTest(key=key), self.assertRaises(RoomPlanError):
                self.read(changed, files)
        bad = b'{"schemaVersion":1,"schemaVersion":2}'
        changed = deepcopy(manifest)
        changed["mesh"].update(sha256=hashlib.sha256(bad).hexdigest(), byteLength=len(bad))
        with self.assertRaises(RoomPlanError):
            self.read(changed, {**files, "mesh.json": bad})
        body = bytearray(archive_bytes(manifest, files))
        start = body.index(files["mesh.json"])
        body[start + 10] ^= 1
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "broken.zip"
            path.write_bytes(body)
            with self.assertRaises(RoomPlanError):
                read_photo_bundle(path)

    def test_mesh_identity_fields_transform_and_vertex_coordinates_are_strict(self):
        manifest, _, original = mesh_bundle()
        cases = []
        for key, value in (("schemaVersion", "bad"), ("projectId", "other"),
                           ("jobId", "other"), ("inputRevision", True),
                           ("coordinateSystem", "z-up"), ("captureMethod", "guessed"),
                           ("extra", True), ("anchors", [])):
            changed = deepcopy(original)
            changed[key] = value
            cases.append(changed)
        for value in ([2,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
                      [-1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],
                      [1,0,0,0,0,1,0,0,0,0,1,0,float("nan"),0,0,1]):
            changed = deepcopy(original)
            changed["anchors"][0]["transform"] = value
            cases.append(changed)
        for value in ([0,0], [True,0,0], [0,float("inf"),0], [10001,0,0]):
            changed = deepcopy(original)
            changed["anchors"][0]["vertices"][0] = value
            cases.append(changed)
        for changed in cases:
            with self.subTest(packet=changed), self.assertRaises(RoomPlanError):
                validate_mesh(changed, manifest)

    def test_indices_degeneracy_classifications_anchor_ids_and_global_bounds(self):
        manifest, _, original = mesh_bundle()
        for field, value in (("faces", [[0,1,4]]), ("faces", [[0,0,2]]),
                             ("faces", [[False,1,2]]), ("faces", [[0.,1,2]]),
                             ("faces", [[0,1,2], [2,0,1]]),
                             ("classifications", [0]), ("classifications", [True,0]),
                             ("classifications", [8,0]), ("id", "../anchor")):
            changed = deepcopy(original)
            changed["anchors"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(RoomPlanError):
                validate_mesh(changed, manifest)
        degenerate = deepcopy(original)
        degenerate["anchors"][0]["vertices"][2] = [2,0,0]
        with self.assertRaisesRegex(RoomPlanError, "degenerate"):
            validate_mesh(degenerate, manifest)
        duplicate = deepcopy(original)
        duplicate["anchors"].append(deepcopy(duplicate["anchors"][0]))
        with self.assertRaisesRegex(RoomPlanError, "duplicate anchor"):
            validate_mesh(duplicate, manifest)
        world = deepcopy(original)
        world["anchors"][0]["transform"][12] = 10000
        with self.assertRaisesRegex(RoomPlanError, "world vertex"):
            validate_mesh(world, manifest)
        for bound, maximum in (("MAX_ANCHORS", 0), ("MAX_VERTICES", 3), ("MAX_FACES", 1)):
            with self.subTest(bound=bound), patch("reconstruction.roomplan.mesh." + bound, maximum), self.assertRaises(RoomPlanError):
                validate_mesh(original, manifest)

    def test_staged_mesh_is_private_sha_bound_and_camera_translation_is_once(self):
        manifest, files, _ = mesh_bundle()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "scan.zip"
            bundle.write_bytes(archive_bytes(manifest, files))
            run(bundle, root / "imported")
            request = json.loads((root / "imported/reconstruction.request.json").read_text())
            path = prepare_texture_source(bundle, request, root / "source")
            source = json.loads(path.read_text())
            self.assertEqual(source["mesh"], manifest["mesh"])
            self.assertEqual(source["sourceToCanonicalTranslation"], [0,-1.25,0])
            self.assertEqual((path.parent / "mesh.json").read_bytes(), files["mesh.json"])
            self.assertEqual(stat.S_IMODE((path.parent / "mesh.json").stat().st_mode), 0o600)

    @unittest.skipUnless(BLENDER, "Set BLENDER_BIN for observed mesh and real JPEG projection")
    def test_actual_blender_nonbox_observed_geometry_photo_pixels_and_portability(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = subprocess.run([BLENDER, "--background", "--factory-startup", "--disable-autoexec",
                "--python-exit-code", "1", "--python", str(ROOT / "reconstruction/tests/inspect_surface_mesh.py"),
                "--", temporary], capture_output=True, text=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("TADAIMA_OBSERVED_SURFACE_VERIFIED", result.stdout)
            # Exercise the complete importer/worker boundary too: metadata must
            # reference real evidence, planning proxies must stay out of GLB,
            # and packed outputs must survive private staging cleanup.
            root = Path(temporary)
            manifest, files, _ = mesh_bundle()
            photo = manifest["photos"][0]
            photo_data = (root / "synthetic-camera.jpg").read_bytes()
            files[photo["path"]] = photo_data
            photo.update(sha256=hashlib.sha256(photo_data).hexdigest(), byteLength=len(photo_data),
                width=256, height=256, intrinsics=[180,0,0,0,180,0,128,128,1],
                cameraToWorld=[1,0,0,0,0,1,0,0,0,0,1,0,0,2,3,1])
            bundle = root / "synthetic-detailed.zip"
            bundle.write_bytes(archive_bytes(manifest, files))
            run(bundle, root / "imported", render=True, blender=BLENDER)
            draft = root / "imported/draft"
            report = json.loads((draft / "manifest.json").read_text())
            self.assertEqual(report["captureRepresentation"], "observed_surface_mesh")
            self.assertEqual(report["surfaceReconstruction"]["triangleCount"], 2)
            self.assertGreater(report["surfaceReconstruction"]["observedTriangleCount"], 0)
            self.assertFalse((draft / "photo-sources").exists())
            self.assertEqual(report["sourceRequestSha256"], hashlib.sha256(
                (root / "imported/reconstruction.request.json").read_bytes()).hexdigest())
            for command in ([BLENDER, "--background", "--factory-startup", "--disable-autoexec",
                "--python-exit-code", "1", "--python", str(ROOT / "reconstruction/tests/inspect_blend.py"),
                "--", str(draft)], ["node", str(ROOT / "reconstruction/verify-glb.mjs"), str(draft)]):
                checked = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=120)
                self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)


if __name__ == "__main__":
    unittest.main()
