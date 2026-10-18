"""Native photo handoff → complete clean-room design → portable Blender/GLB.

Native packet/JPEG headers and authored style bindings are synthetic. This
integration proves identities, preserved metric geometry and actual exported
materials/forms; it makes no physical scan or automatic vision-quality claim.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from reconstruction.appearance import request_sha256
from reconstruction.geometry import GeometryError
from reconstruction.pipeline import PipelineError,generate,resolve_blender
from reconstruction.roomplan import run
from reconstruction.roomplan.importer import _evidence_id
from reconstruction.tests.test_roomplan_photo_bundle import fixture,archive_bytes

ROOT=Path(__file__).resolve().parents[2]
try:
    BLENDER=resolve_blender()
except PipelineError:
    BLENDER=None


@unittest.skipUnless(BLENDER,"Set BLENDER_BIN for clean-room design pipeline verification")
class VisualDesignPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name)
        manifest,files=fixture(2,floor=1.25)
        scan=json.loads(files["roomplan.json"])
        scan["schemaVersion"]="roomplan-scan/1.1"
        scan["objects"]=[
            {"id":"synthetic-chair","category":"chair","confidence":"high","dimensions":[.58,.85,.6],
             "transform":[1,0,0,0,0,1,0,0,0,0,1,0,1.2,1.25+.85/2+.18,1.2,1]},
            {"id":"synthetic-sofa","category":"sofa","confidence":"high","dimensions":[1.8,.9,.82],
             "transform":[0,0,-1,0,0,1,0,0,1,0,0,0,3.6,1.25+.9/2,2.7,1]},
            {"id":"synthetic-table","category":"table","confidence":"high","dimensions":[1.1,.42,.64],
             "transform":[1,0,0,0,0,1,0,0,0,0,1,0,2.3,1.25+.42/2,2.2,1]}]
        files["roomplan.json"]=json.dumps(scan).encode()
        manifest["scan"]["sha256"]=hashlib.sha256(files["roomplan.json"]).hexdigest()
        self.bundle=self.root/"scan.zip";self.bundle.write_bytes(archive_bytes(manifest,files))
        self.imported=self.root/"imported";run(self.bundle,self.imported)
        self.input=self.imported/"reconstruction.request.json"
        self.request=json.loads(self.input.read_text())
        sources=[{"photoId":photo["id"],"sha256":photo["sha256"],
                  "evidenceId":_evidence_id(self.request["jobId"]+":rgb:"+photo["id"])} for photo in manifest["photos"]]
        evidence=[sources[0]["evidenceId"]]
        surfaces=[]
        for entity in [*self.request["geometry"]["rooms"],*self.request["geometry"]["walls"]]:
            floor=entity["id"] in {room["id"] for room in self.request["geometry"]["rooms"]}
            surfaces.append({"entityId":entity["id"],"finish":"carpet" if floor else "paint",
                "color":"#9f8e74" if floor else "#e6d9b8","secondaryColor":"#ded5bd" if floor else "#e6d9b8",
                "pattern":"inset_dash" if floor else "plain","roughness":.94 if floor else .88,
                "repeatMeters":4 if floor else 1,"rotationDegrees":0,"confidence":"medium","evidenceIds":evidence})
        models={"synthetic-chair":"loop_arm_plywood_chair","synthetic-sofa":"box_arm_sofa","synthetic-table":"rect_table"}
        items=[{"itemId":item["id"],"label":"Synthetic photo-informed "+models[item["id"]],"model":models[item["id"]],
            "primaryColor":"#b97f42" if item["id"]=="synthetic-chair" else "#4d352a" if item["id"]=="synthetic-sofa" else "#ece6dc",
            "secondaryColor":"#d8cbb7","frameColor":"#aeb4b5","accentColor":"#cbb688","pattern":"plain",
            "seatCount":2 if item["id"]=="synthetic-sofa" else 1,"confidence":"medium","evidenceIds":evidence,
            "notes":"Synthetic integration style; not actual recovered furniture."} for item in self.request["items"]]
        self.profile={"schemaVersion":"room-visual-design/1.0","producer":"Synthetic keyless style integration fixture",
            **{key:self.request[key] for key in ("projectId","jobId","inputRevision")},"inputSha256":request_sha256(self.request),
            "sources":sources,"surfaces":surfaces,"items":items,"notes":["Synthetic fixture, not a physical room claim."]}
        self.profile_path=self.root/"design.json";self.profile_path.write_text(json.dumps(self.profile))

    def test_clean_mode_preserves_measurements_and_passes_independent_artifact_verifiers(self):
        output=self.root/"clean"
        manifest=generate(self.input,output,blender=BLENDER,photo_bundle=self.bundle,design_profile=self.profile_path,timeout=180)
        self.assertEqual(manifest["captureRepresentation"],"photo_informed_parametric")
        self.assertEqual(manifest["renderProfile"],"photo-informed-room-v1")
        self.assertEqual(manifest["visualDesign"]["items"],self.profile["items"])
        self.assertEqual(json.loads((output/"scene.json").read_text())["geometry"],self.request["geometry"])
        self.assertEqual(json.loads((output/"scene.json").read_text())["items"],self.request["items"])
        self.assertFalse((output/"photo-sources").exists(),"Private temporary photos must be removed after packing")
        blend=subprocess.run([BLENDER,"--background","--factory-startup","--disable-autoexec","--python-exit-code","1",
            "--python",str(ROOT/"reconstruction/tests/inspect_blend.py"),"--",str(output)],capture_output=True,text=True,timeout=120)
        self.assertEqual(blend.returncode,0,blend.stdout+blend.stderr)
        self.assertIn("TADAIMA_BLEND_VERIFIED",blend.stdout)
        glb=subprocess.run(["node",str(ROOT/"reconstruction/verify-glb.mjs"),str(output)],capture_output=True,text=True,timeout=60,cwd=ROOT)
        self.assertEqual(glb.returncode,0,glb.stdout+glb.stderr)
        report=json.loads(glb.stdout)
        self.assertTrue(report["valid"])
        self.assertGreater(report["loaderDecodedImageCount"],0)

    def test_incomplete_clean_furniture_profile_fails_before_blender(self):
        self.profile["items"].pop()
        self.profile_path.write_text(json.dumps(self.profile))
        output=self.root/"incomplete"
        with patch("reconstruction.pipeline.subprocess.run") as process,self.assertRaises(GeometryError):
            generate(self.input,output,blender=BLENDER,photo_bundle=self.bundle,design_profile=self.profile_path)
        process.assert_not_called()
        self.assertFalse(output.exists())


if __name__=="__main__":
    unittest.main()
