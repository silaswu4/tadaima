import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from reconstruction.geometry import GeometryError
from reconstruction.pipeline import PipelineError, generate, read_request, resolve_blender

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "reconstruction/fixtures/living-room.request.json"


class InputAndFailureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_duplicate_json_keys_rejected(self):
        path = self.root / "bad.json"
        path.write_text('{"jobId":"one","jobId":"two"}')
        with self.assertRaisesRegex(GeometryError, "Duplicate JSON key"):
            read_request(path)

    def test_input_size_limit(self):
        path = self.root / "large.json"
        path.write_bytes(b" " * (2 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(GeometryError, "2 MiB"):
            read_request(path)

    def test_nonfinite_json_rejected(self):
        path = self.root / "bad.json"
        path.write_text('{"number":NaN}')
        with self.assertRaisesRegex(GeometryError, "Non-finite"):
            read_request(path)

    def test_invalid_input_never_starts_blender(self):
        path = self.root / "bad.json"
        path.write_text("{}")
        with patch("reconstruction.pipeline.subprocess.run") as process:
            with self.assertRaises(GeometryError):
                generate(path, self.root / "output")
            process.assert_not_called()
        self.assertFalse((self.root / "output").exists())

    def test_existing_output_preserved(self):
        output = self.root / "output"
        output.mkdir()
        (output / "sentinel").write_text("keep")
        with self.assertRaisesRegex(PipelineError, "already exists"):
            generate(FIXTURE, output, blender=sys.executable)
        self.assertEqual((output / "sentinel").read_text(), "keep")

    def test_timeout_does_not_publish_or_leave_staging(self):
        with patch("reconstruction.pipeline.subprocess.run", side_effect=subprocess.TimeoutExpired("blender", 0.1)):
            with self.assertRaisesRegex(PipelineError, "exceeded"):
                generate(FIXTURE, self.root / "output", blender=sys.executable, timeout=0.1)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_worker_failure_does_not_publish(self):
        with self.assertRaisesRegex(PipelineError, "Blender failed"):
            # Python is a real executable but cannot run Blender's CLI arguments.
            generate(FIXTURE, self.root / "output", blender=sys.executable)
        self.assertEqual(list(self.root.iterdir()), [])


def installed_blender():
    try:
        return resolve_blender()
    except PipelineError:
        return None


BLENDER = installed_blender()


@unittest.skipUnless(BLENDER, "Set BLENDER_BIN to run real Blender integration tests")
class BlenderIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def inspect(self, output):
        result = subprocess.run([BLENDER, "--background", "--factory-startup", "--disable-autoexec",
                                 "--python-exit-code", "1", "--python",
                                 str(ROOT / "reconstruction/tests/inspect_blend.py"), "--", str(output)],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("TADAIMA_BLEND_VERIFIED", result.stdout)
        result = subprocess.run(["node", "reconstruction/verify-glb.mjs", str(output)], cwd=ROOT,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_real_blender_glb_scale_identity_holes_and_editability(self):
        output = self.root / "room"
        manifest = generate(FIXTURE, output, blender=BLENDER)
        self.assertEqual(manifest["inputRevision"], 1)
        self.assertEqual(manifest["sourceRequestSha256"], hashlib.sha256(FIXTURE.read_bytes()).hexdigest())
        self.assertEqual(manifest["statistics"]["meshCount"], 5)
        self.assertEqual(manifest["statistics"]["entityCount"], 7)
        for key, file in manifest["files"].items():
            data = (output / file["fileName"]).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), file["sha256"], key)
        self.inspect(output)
        with self.assertRaises(PipelineError):
            generate(FIXTURE, output, blender=BLENDER)

    def test_concave_collinear_and_rotated_walls(self):
        request = json.loads(FIXTURE.read_text())
        # An L-shaped room, with a redundant collinear vertex and a rotation.
        points = [[0, 0], [2, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]]
        import math
        cosine, sine = math.cos(0.43), math.sin(0.43)
        points = [[x * cosine - z * sine, x * sine + z * cosine] for x, z in points]
        request["geometry"]["rooms"][0]["floorPolygon"] = points
        request["geometry"]["walls"] = [
            {"id": f"wall-{i}", "start": p, "end": points[(i + 1) % len(points)],
             "height": 2.7, "thickness": 0.12, "evidenceIds": ["synthetic-reference"]}
            for i, p in enumerate(points)
        ]
        request["geometry"]["openings"] = []
        path = self.root / "concave.json"
        path.write_text(json.dumps(request))
        output = self.root / "concave"
        generate(path, output, blender=BLENDER)
        self.inspect(output)

    def test_fully_open_wall_retains_semantic_id_and_large_revision(self):
        request = json.loads(FIXTURE.read_text())
        request["inputRevision"] = 2**40
        request["geometry"]["openings"] = [
            {"id": "full-opening", "wallId": "front", "kind": "door", "offset": 0,
             "width": 4.2, "height": 2.7, "sillHeight": 0, "evidenceIds": ["synthetic-reference"]}
        ]
        path = self.root / "open.json"
        path.write_text(json.dumps(request))
        output = self.root / "open"
        manifest = generate(path, output, blender=BLENDER)
        self.assertEqual(manifest["statistics"]["meshCount"], 4)
        self.assertEqual(manifest["inputRevision"], 2**40)
        self.inspect(output)


if __name__ == "__main__":
    unittest.main()
