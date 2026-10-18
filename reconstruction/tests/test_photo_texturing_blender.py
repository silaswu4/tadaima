"""Exercise calibrated RGB projection in actual Blender, not mocked bpy."""

from pathlib import Path
import subprocess
import tempfile
import unittest

from reconstruction.pipeline import PipelineError, resolve_blender

ROOT = Path(__file__).resolve().parents[2]
try:
    BLENDER = resolve_blender()
except PipelineError:
    BLENDER = None


@unittest.skipUnless(BLENDER, "Set BLENDER_BIN to run calibrated photo texture projection")
class PhotoTexturingBlenderTests(unittest.TestCase):
    def test_rendered_calibrated_photos_preserve_pixels_and_geometry(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [BLENDER, "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1",
                 "--python", str(ROOT / "reconstruction/tests/inspect_photo_texturing.py"), "--", directory],
                capture_output=True, text=True, timeout=180)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("TADAIMA_PHOTO_TEXTURES_VERIFIED", result.stdout)


if __name__ == "__main__":
    unittest.main()
