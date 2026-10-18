"""Pure binary-transport regressions; actual Cycles validation is in report.json."""

import json
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

from reconstruction.bake_indirect import (decode_own_rgba_png, glb_document,
                                           masked_gaussian_rgb, preserve_lightmap_rgba, rgba_png)
from reconstruction.denoise_lightmap import dilate_rgb_padding, verify_source


def fixture_glb(path, duplicate_atlas=False):
    document = {
        "asset": {"version": "2.0"}, "buffers": [{"byteLength": 12}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 4},
                        {"buffer": 0, "byteOffset": 4, "byteLength": 3},
                        {"buffer": 0, "byteOffset": 8, "byteLength": 4}],
        "images": [{"mimeType": "image/png", "bufferView": 1}],
        "textures": [{"source": 0}],
        "materials": [{"emissiveTexture": {"index": 0, "texCoord": 1}}],
    }
    if duplicate_atlas:
        document["images"].append({"mimeType": "image/png", "bufferView": 2})
        document["textures"].append({"source": 1})
        document["materials"].append({"emissiveTexture": {"index": 1}})
    payload = json.dumps(document).encode()
    payload += b" " * (-len(payload) % 4)
    binary = b"ABCDold\0WXYZ"
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, 28 + len(payload) + len(binary)) +
                     struct.pack("<II", len(payload), 0x4E4F534A) + payload +
                     struct.pack("<II", len(binary), 0x004E4942) + binary)


class IndirectBakeTransportTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("numpy"), "NumPy is bundled with Blender; unavailable in this Python")
    def test_gutter_extension_preserves_valid_rgb_and_ao_alpha(self):
        import numpy as np
        image = np.zeros((5, 5, 4), dtype=np.float32)
        image[:, :, 3] = np.arange(25).reshape((5, 5)) / 24
        image[2, 2, :3] = [1, 2, 3]
        alpha = image[:, :, 3].copy()
        dilate_rgb_padding(image.reshape(-1), 5, 5, 1)
        np.testing.assert_array_equal(image[2, 2, :3], [1, 2, 3])
        np.testing.assert_array_equal(image[2, 1, :3], [1, 2, 3])
        np.testing.assert_array_equal(image[1, 1, :3], 0)
        np.testing.assert_array_equal(image[:, :, 3], alpha)

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "NumPy is bundled with Blender; unavailable in this Python")
    def test_gutter_extension_never_wraps_across_atlas_edges(self):
        import numpy as np
        image = np.zeros((5, 5, 4), dtype=np.float32)
        image[2, 0, :3] = 1
        dilate_rgb_padding(image.reshape(-1), 5, 5, 1)
        np.testing.assert_array_equal(image[:, -1, :3], 0)

    def test_denoise_rejects_tampered_source_before_loading_blender(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "scene.glb").write_bytes(b"changed")
            report = {"profile": "cycles-diffuse-full-v1", "files": {"scene.glb": {"sha256": "0" * 64}}}
            (root / "report.json").write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, "artifact hash mismatch"):
                verify_source(root)

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "NumPy is bundled with Blender; unavailable in this Python")
    def test_masked_noise_filter_preserves_padding_alpha_and_constant_irradiance(self):
        import numpy as np
        image = np.zeros((9, 9, 4), dtype=np.float32)
        image[:, :, 3] = np.arange(81).reshape((9, 9)) / 80
        image[3:6, 3:6, :3] = [1, 2, 3]
        before = image.copy()
        masked_gaussian_rgb(image.reshape(-1), 9, 9, 2)
        np.testing.assert_allclose(image[:, :, :3], before[:, :, :3])
        np.testing.assert_array_equal(image[:, :, 3], before[:, :, 3])

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "NumPy is bundled with Blender; unavailable in this Python")
    def test_masked_noise_filter_reduces_sample_variance(self):
        import numpy as np
        image = np.ones((9, 9, 4), dtype=np.float32)
        for y in range(9):
            for x in range(9):
                image[y, x, :3] = 1 if (x + y) % 2 else 3
        variance_before = image[:, :, :3].var()
        masked_gaussian_rgb(image.reshape(-1), 9, 9, 2)
        self.assertLess(image[2:-2, 2:-2, :3].var(), variance_before * .01)

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "NumPy is bundled with Blender; unavailable in this Python")
    def test_masked_noise_filter_does_not_mix_islands_across_padding(self):
        import numpy as np
        image = np.zeros((3, 11, 4), dtype=np.float32)
        image[:, :3, :3] = 1
        image[:, 8:, :3] = 10
        masked_gaussian_rgb(image.reshape(-1), 11, 3, 2)
        np.testing.assert_allclose(image[:, :3, :3], 1)
        np.testing.assert_allclose(image[:, 8:, :3], 10)
        np.testing.assert_array_equal(image[:, 3:8, :3], 0)

    def test_png_encoder_preserves_exact_rgb_and_independent_ao_alpha(self):
        pixels = bytes([255, 128, 0, 0, 0, 1, 255, 255,
                        10, 20, 30, 70, 200, 190, 180, 4])
        encoded = rgba_png(2, 2, pixels)
        self.assertEqual(decode_own_rgba_png(encoded), (2, 2, pixels))
        self.assertEqual(encoded[24:26], bytes([8, 6]))

    def test_png_encoder_rejects_wrong_dimensions_and_data(self):
        for width, height, pixels in [(0, 2, b""), (2, 2, b"short")]:
            with self.assertRaises(ValueError):
                rgba_png(width, height, pixels)

    def test_png_decoder_rejects_corruption(self):
        encoded = bytearray(rgba_png(1, 1, b"\x10\x20\x30\x40"))
        encoded[20] ^= 1
        with self.assertRaisesRegex(ValueError, "checksum"):
            decode_own_rgba_png(encoded)

    def test_rgba_repack_preserves_geometry_views_and_single_texture(self):
        with tempfile.TemporaryDirectory() as directory:
            path, png = Path(directory) / "scene.glb", Path(directory) / "atlas.png"
            fixture_glb(path)
            # The repacker checks the PNG signature/IHDR color type. Pixel/CRC
            # decoding remains the image loader's responsibility.
            rgba = b"\x89PNG\r\n\x1a\n" + b"\0" * 17 + b"\x06" + b"test-rgba-pixels"
            png.write_bytes(rgba)
            preserve_lightmap_rgba(path, png)
            document = glb_document(path)
            self.assertEqual(len(document["images"]), 1)
            self.assertEqual(len(document["textures"]), 1)
            self.assertEqual(document["materials"][0]["emissiveTexture"]["texCoord"], 1)
            data = path.read_bytes()
            self.assertEqual(struct.unpack_from("<I", data, 8)[0], len(data))
            json_length = struct.unpack_from("<I", data, 12)[0]
            binary = data[28 + json_length:]
            views = document["bufferViews"]
            self.assertEqual(binary[views[0]["byteOffset"]:views[0]["byteOffset"] + 4], b"ABCD")
            self.assertEqual(binary[views[2]["byteOffset"]:views[2]["byteOffset"] + 4], b"WXYZ")
            start = views[1]["byteOffset"]
            self.assertEqual(binary[start:start + views[1]["byteLength"]], rgba)
            self.assertTrue(all(view["byteOffset"] % 4 == 0 for view in views))

    def test_rgb_png_refused_for_ao_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            path, png = Path(directory) / "scene.glb", Path(directory) / "atlas.png"
            fixture_glb(path)
            png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 17 + b"\x02")
            with self.assertRaisesRegex(RuntimeError, "RGBA PNG"):
                preserve_lightmap_rgba(path, png)

    def test_duplicate_atlases_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path, png = Path(directory) / "scene.glb", Path(directory) / "atlas.png"
            fixture_glb(path, duplicate_atlas=True)
            with self.assertRaisesRegex(RuntimeError, "duplicated"):
                preserve_lightmap_rgba(path, png)


if __name__ == "__main__":
    unittest.main()
