"""Actual Blender verification of photo-informed room finishes and opening trim."""
from pathlib import Path
import subprocess
import tempfile
import unittest

from reconstruction.pipeline import PipelineError, resolve_blender

ROOT=Path(__file__).resolve().parents[2]
try:
    BLENDER=resolve_blender()
except PipelineError:
    BLENDER=None


@unittest.skipUnless(BLENDER,"Set BLENDER_BIN for actual designed-surface and aperture checks")
class DesignedSurfaceTests(unittest.TestCase):
    def test_estimated_finish_portability_and_closed_aperture_details(self):
        with tempfile.TemporaryDirectory() as temporary:
            result=subprocess.run([BLENDER,"--background","--factory-startup","--disable-autoexec","--python-exit-code","1",
                "--python",str(ROOT/"reconstruction/tests/inspect_designed_surfaces.py"),"--",temporary],
                capture_output=True,text=True,timeout=120)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            self.assertIn("TADAIMA_DESIGNED_SURFACES_VERIFIED",result.stdout)


if __name__=="__main__":
    unittest.main()
