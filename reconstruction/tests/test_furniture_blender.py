"""Actual Blender/Three integration for separate detected-furniture proxies."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from reconstruction.pipeline import PipelineError, generate, resolve_blender

ROOT = Path(__file__).resolve().parents[2]

try:
    BLENDER = resolve_blender()
except PipelineError:
    BLENDER = None


@unittest.skipUnless(BLENDER, "Set BLENDER_BIN to run real furniture Blender integration")
class FurnitureBlenderTests(unittest.TestCase):
    def test_rotated_elevated_proxies_preserve_shell_and_canonical_transforms(self):
        request = json.loads((ROOT / "reconstruction/fixtures/living-room.request.json").read_text())
        request["items"] = [
            {"id": "owned-chair", "roomId": "living-room", "label": "Detected chair",
             "origin": "existing_owned", "productId": None, "assetUrl": None,
             "position": [1.5, .3, 1.1], "rotationY": .53, "dimensions": [.8, .6, .4],
             "locked": True, "evidenceIds": ["synthetic-reference"]},
            {"id": "owned-cabinet", "roomId": "living-room", "label": "Detected cabinet",
             "origin": "existing_owned", "productId": None, "assetUrl": None,
             "position": [3, 1.2, 2.3], "rotationY": -.71, "dimensions": [.6, 1.9, 1.2],
             "locked": False, "evidenceIds": ["synthetic-reference"]},
        ]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory / "request.json"
            source.write_text(json.dumps(request))
            output = directory / "result"
            manifest = generate(source, output, blender=BLENDER)
            self.assertEqual(manifest["statistics"]["meshCount"], 7)
            self.assertEqual(manifest["statistics"]["entityCount"], 9)
            # Each independent box adds exactly 12 triangles to the old shell.
            self.assertEqual(manifest["statistics"]["triangleCount"], 144 + 24)
            self.assertAlmostEqual(manifest["bounds"]["max"][1], 3.1, places=5)
            roles = {entity["id"]: entity["role"] for entity in manifest["objects"]}
            for item in request["items"]:
                self.assertEqual(roles[item["id"]], "existing_furniture")
            self.assertEqual(json.loads((output / "scene.json").read_text())["geometry"], request["geometry"])
            result = subprocess.run(
                [BLENDER, "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1",
                 "--python", str(ROOT / "reconstruction/tests/inspect_blend.py"), "--", str(output)],
                capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("TADAIMA_BLEND_VERIFIED", result.stdout)
            result = subprocess.run(["node", "reconstruction/verify-glb.mjs", str(output)], cwd=ROOT,
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)["testedExistingFurniture"], 2)


if __name__ == "__main__":
    unittest.main()
