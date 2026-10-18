"""Real Blender verification for closed, measured-envelope furniture templates."""
from pathlib import Path
import json
import subprocess
import tempfile
import unittest

from reconstruction.pipeline import PipelineError, resolve_blender

ROOT = Path(__file__).resolve().parents[2]
try:
    BLENDER = resolve_blender()
except PipelineError:
    BLENDER = None


@unittest.skipUnless(BLENDER, "Set BLENDER_BIN to verify actual designed furniture meshes")
class DesignedFurnitureTests(unittest.TestCase):
    def test_templates_are_closed_nonbox_semantic_meshes_and_export_materials(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            process = subprocess.run([BLENDER, "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1",
                                      "--python", str(ROOT / "reconstruction/tests/inspect_designed_furniture.py"), "--", str(output)],
                                     capture_output=True, text=True, timeout=180)
            self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
            self.assertIn("TADAIMA_DESIGNED_FURNITURE_VERIFIED 10", process.stdout)
            self.assertEqual(len(json.loads((output / "designed-furniture-check.json").read_text())), 10)
            script = r'''
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const bytes = readFileSync(process.argv[1]), length = bytes.readUInt32LE(12);
const raw = JSON.parse(bytes.subarray(20,20+length));
const nodes = raw.nodes.filter(n => n.extras?.representation === "photo_informed_parametric");
assert.equal(nodes.length,10);
assert(nodes.every(n => n.extras.proxyGeometry === "photo_informed_parts" && n.extras.appearanceStatus === "photo_inferred"));
assert(raw.materials.length >= 10);
assert(raw.images?.length >= 1 && raw.images.every(i => i.bufferView !== undefined && !i.uri));
assert(raw.meshes.some(m => m.primitives.length > 1),"Designed parts need separate portable material primitives");
assert(raw.materials.some(m => m.pbrMetallicRoughness?.metallicFactor > 0),"Metal frame appearance must export");
console.log("TADAIMA_DESIGNED_GLB_VERIFIED");
'''
            exported = subprocess.run(["node", "--input-type=module", "-e", script, str(output / "designed-furniture.glb")],
                                      capture_output=True, text=True, timeout=30, cwd=ROOT)
            self.assertEqual(exported.returncode, 0, exported.stdout + exported.stderr)
            self.assertIn("TADAIMA_DESIGNED_GLB_VERIFIED", exported.stdout)
