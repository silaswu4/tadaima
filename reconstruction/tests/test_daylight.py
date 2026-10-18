"""Independent geometry cases for the daylight direction and bounded rig."""

import copy
import json
from pathlib import Path
import unittest

from reconstruction.daylight import daylight_plan


class DaylightTests(unittest.TestCase):
    def setUp(self):
        self.geometry = json.loads((Path(__file__).parents[1] / "fixtures/living-room.request.json").read_text())["geometry"]

    def test_exterior_window_and_door(self):
        plan = daylight_plan(self.geometry)
        self.assertEqual(plan["mode"], "window_daylight")
        self.assertEqual(len(plan["windows"]), 1)
        light = plan["windows"][0]
        self.assertEqual(light["openingId"], "window")
        self.assertAlmostEqual(light["center"][0], 2.1)
        self.assertAlmostEqual(light["center"][1], 1.5)
        self.assertEqual(light["inward"], [0, 0, 1])
        self.assertLess(light["position"][2], -.06)
        self.assertEqual((light["width"], light["height"]), (1.4, 1.2))

    def test_reversed_wall_preserves_center_and_inward(self):
        expected = daylight_plan(self.geometry)["windows"][0]
        wall = self.geometry["walls"][0]
        wall["start"], wall["end"] = wall["end"], wall["start"]
        opening = self.geometry["openings"][1]
        opening["offset"] = 4.2 - opening["offset"] - opening["width"]
        actual = daylight_plan(self.geometry)["windows"][0]
        for field in ("center", "inward", "position"):
            for left, right in zip(actual[field], expected[field]):
                self.assertAlmostEqual(left, right)

    def test_shared_partition_is_not_exterior(self):
        self.geometry["rooms"].append({"id": "neighbor", "floorPolygon": [[0, -3], [4.2, -3], [4.2, 0], [0, 0]]})
        plan = daylight_plan(self.geometry)
        self.assertEqual(plan["mode"], "studio_fallback")
        self.assertEqual(plan["windows"], [])
        self.assertEqual(plan["skippedInteriorWindowIds"], ["window"])

    def test_concave_notch_faces_the_room_not_bbox_center(self):
        self.geometry["rooms"][0]["floorPolygon"] = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]
        self.geometry["walls"] = [{"id": "notch", "start": [1, 1], "end": [1, 4], "thickness": .12}]
        self.geometry["openings"] = [{"id": "notch-window", "wallId": "notch", "kind": "window", "offset": .5, "width": 1, "height": 1, "sillHeight": 1}]
        light = daylight_plan(self.geometry)["windows"][0]
        self.assertEqual(light["inward"], [-1, 0, 0])
        self.assertGreater(light["position"][0], 1.06)

    def test_bounded_largest_first_and_stable_ties(self):
        template = self.geometry["openings"][1]
        self.geometry["openings"] = [{**copy.deepcopy(template), "id": f"win-{index:02d}", "width": 1 if index else 2} for index in reversed(range(15))]
        plan = daylight_plan(self.geometry)
        self.assertEqual(len(plan["windows"]), 12)
        self.assertEqual(plan["windows"][0]["openingId"], "win-00")
        self.assertEqual(plan["omittedWindowIds"], ["win-12", "win-13", "win-14"])
        self.geometry["openings"].reverse()
        self.assertEqual(plan, daylight_plan(self.geometry))

    def test_no_window_and_invalid_limit(self):
        self.geometry["openings"] = []
        self.assertEqual(daylight_plan(self.geometry)["mode"], "studio_fallback")
        for limit in (0, 13, True, 1.5):
            with self.assertRaises(ValueError):
                daylight_plan(self.geometry, max_windows=limit)


# One real export exercises the compatibility-sensitive per-surface path:
# nonwood flooring must not require an oak albedo, and wood walls still must.
from reconstruction.pipeline import PipelineError, generate, resolve_blender
import subprocess
import tempfile

try:
    BLENDER = resolve_blender()
except PipelineError:
    BLENDER = None


@unittest.skipUnless(BLENDER, "Set BLENDER_BIN for appearance/lighting Blender verification")
class AppearanceBlenderTests(unittest.TestCase):
    def test_mixed_finishes_roundtrip_without_geometry_changes(self):
        root = Path(__file__).resolve().parents[2]
        request = json.loads((root / "reconstruction/fixtures/living-room.request.json").read_text())
        surfaces = []
        for entity_id, finish, color, roughness in (("living-room", "tile", "#c2c6cc", .65),
                                                   ("back", "wood", "#b8c2d4", .6),
                                                   ("right", "carpet", "#a7b8c9", .97),
                                                   ("front", "paint", "#e7e9ed", .82)):
            surfaces.append({"entityId": entity_id, "finish": finish, "color": color,
                             "roughness": roughness, "tileMeters": .7, "rotationDegrees": 31,
                             "confidence": "low", "evidenceIds": ["synthetic-reference"]})
        request["appearance"] = {"schemaVersion": "room-appearance/1.0", "reviewRequired": True,
                                 "scope": "unknown", "sources": [{"evidenceId": "synthetic-reference", "sha256": "a" * 64}],
                                 "surfaces": surfaces, "notes": ["Synthetic material test; no real photo claim."]}
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory / "input.json"
            source.write_text(json.dumps(request))
            output = directory / "artifact"
            manifest = generate(source, output, blender=BLENDER)
            self.assertEqual(manifest["statistics"]["triangleCount"], 144)
            self.assertEqual(manifest["lighting"]["mode"], "window_daylight")
            self.assertEqual(manifest["appearance"]["surfaces"][0]["finish"], "tile")
            for command in ([BLENDER, "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1",
                             "--python", str(root / "reconstruction/tests/inspect_blend.py"), "--", str(output)],
                            ["node", "reconstruction/verify-glb.mjs", str(output)]):
                result = subprocess.run(command, cwd=root, text=True, capture_output=True, timeout=120)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
