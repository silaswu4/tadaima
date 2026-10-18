"""Synthetic archive fixtures; no camera images or real measurements are used."""

import copy
import hashlib
import io
import json
from pathlib import Path
import stat
import struct
import tempfile
import unittest
import warnings
import zipfile
from unittest.mock import patch

from reconstruction.capture.bundle import BundleError, read_bundle


NOW = "2026-10-18T04:00:00Z"


def jpeg(width=640, height=480, payload=b"synthetic-test-only"):
    # Header-valid byte fixture for the sniffer, deliberately not a decoded photo.
    return (b"\xff\xd8\xff\xc0\x00\x11\x08" + struct.pack(">HH", height, width)
            + b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00" + payload + b"\xff\xd9")


def fixture(images=None, walls=None):
    images = [jpeg()] if images is None else images
    walls = ["a"] * len(images) if walls is None else walls
    photos = []
    files = {}
    for index, (body, wall) in enumerate(zip(images, walls)):
        ident = f"photo-{index}"
        name = f"photos/{ident}.jpg"
        photos.append({"id": ident, "fileName": name, "sha256": hashlib.sha256(body).hexdigest(),
            "mediaType": "image/jpeg", "width": 640, "height": 480, "wall": wall,
            "capturedAt": NOW, "quality": {"meanLuminance": 100, "edgeEnergy": 10}})
        files[name] = body
    manifest = {"schemaVersion": "mobile-capture/1.0", "jobId": "capture-test",
        "projectId": "synthetic-project", "inputRevision": 3, "capturedAt": NOW,
        "captureMode": "guided_photos", "room": {"id": "room-test", "label": "Synthetic room",
            "shape": "rectangle", "clearWidth": None, "clearDepth": None, "height": None,
            "wallThickness": None, "confirmedRectangularAt": None}, "photos": photos, "openings": []}
    return manifest, files


def archive_bytes(manifest, files, *, compression=zipfile.ZIP_STORED, manifest_bytes=None,
                  extras=None, photo_infos=None):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=compression) as archive:
        archive.writestr("capture.json", json.dumps(manifest).encode() if manifest_bytes is None else manifest_bytes)
        for name, data in files.items():
            archive.writestr(photo_infos.get(name, name) if photo_infos else name, data)
        for name, data in extras or []:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                archive.writestr(name, data)
    return output.getvalue()


class CaptureBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "capture.zip"

    def read(self, body):
        self.path.write_bytes(body)
        return read_bundle(self.path)

    def test_stored_client_zip_and_actual_photo_hashes(self):
        manifest, files = fixture([jpeg(payload=b"a"), jpeg(payload=b"b"), jpeg(payload=b"c"), jpeg(payload=b"d")],
                                  ["a", "b", "c", "d"])
        result = self.read(archive_bytes(manifest, files))
        self.assertEqual(result["files"], files)
        self.assertEqual(result["manifest"], manifest)
        self.assertFalse(any("Missing labeled" in warning for warning in result["warnings"]))
        self.assertIn("do not verify camera use", result["warnings"][-1])
        self.assertEqual(list(Path(self.temporary.name).iterdir()), [self.path])

    def test_bounded_deflated_zip_is_supported(self):
        manifest, files = fixture()
        result = self.read(archive_bytes(manifest, files, compression=zipfile.ZIP_DEFLATED))
        self.assertEqual(result["files"], files)

    def test_directory_limits_apply_before_zipfile_allocates_entries(self):
        manifest, files = fixture()
        body = archive_bytes(manifest, files, extras=[(f"extra-{index}", b"") for index in range(2000)])
        for forge_count in (False, True):
            candidate = bytearray(body)
            if forge_count:
                end = candidate.rfind(b"PK\x05\x06")
                struct.pack_into("<HH", candidate, end + 8, 2, 2)
            with self.subTest(forge_count=forge_count), patch(
                "reconstruction.capture.bundle.zipfile.ZipFile",
                side_effect=AssertionError("Unbounded directory parser called"),
            ), self.assertRaises(BundleError):
                self.read(bytes(candidate))

    def test_no_photos_is_valid_manual_bundle_with_coverage_warning(self):
        manifest, files = fixture([])
        manifest["captureMode"] = "manual"
        result = self.read(archive_bytes(manifest, files))
        self.assertEqual(result["files"], {})
        self.assertTrue(any("A, B, C, D" in warning for warning in result["warnings"]))

    def test_duplicate_images_warn_despite_four_distinct_wall_labels(self):
        manifest, files = fixture([jpeg()] * 4, ["a", "b", "c", "d"])
        result = self.read(archive_bytes(manifest, files))
        self.assertEqual(sum("duplicates another image" in warning for warning in result["warnings"]), 3)
        self.assertTrue(any("do not prove wall coverage" in warning for warning in result["warnings"]))

    def test_missing_wall_labels_warn(self):
        manifest, files = fixture()
        result = self.read(archive_bytes(manifest, files))
        self.assertTrue(any("B, C, D" in warning for warning in result["warnings"]))

    def test_hash_mismatch_is_rejected(self):
        manifest, files = fixture()
        manifest["photos"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(BundleError, "SHA-256"):
            self.read(archive_bytes(manifest, files))

    def test_jpeg_dimensions_must_match_metadata(self):
        manifest, files = fixture([jpeg(width=800)])
        with self.assertRaisesRegex(BundleError, "dimensions do not match"):
            self.read(archive_bytes(manifest, files))

    def test_actual_dimension_limits_and_header_are_checked(self):
        for data in (jpeg(width=100), jpeg(width=5000), b"not a jpeg",
                     b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + struct.pack(">II", 640, 480) + b"\x00" * 9):
            manifest, files = fixture([data])
            with self.subTest(prefix=repr(data[:10])), self.assertRaises(BundleError):
                self.read(archive_bytes(manifest, files))

    def test_path_traversal_backslashes_dot_segments_and_extras_rejected(self):
        manifest, files = fixture()
        for name in ("../outside.jpg", "/tmp/out.jpg", "photos/../outside.jpg", "photos\\photo.jpg",
                     "photos/./photo.jpg", "photos/", "executable.py", "capture.json/child"):
            with self.subTest(name=name), self.assertRaises(BundleError):
                self.read(archive_bytes(manifest, files, extras=[(name, b"data")]))

    def test_duplicate_archive_names_rejected(self):
        manifest, files = fixture()
        for name, body in (("capture.json", b"{}"), ("photos/photo-0.jpg", jpeg())):
            with self.subTest(name=name), self.assertRaisesRegex(BundleError, "duplicate"):
                self.read(archive_bytes(manifest, files, extras=[(name, body)]))

    def test_missing_and_unlisted_photos_rejected(self):
        manifest, files = fixture()
        cases = ({}, {**files, "photos/unlisted.jpg": jpeg()})
        for entries in cases:
            with self.subTest(files=list(entries)), self.assertRaisesRegex(BundleError, "differ from"):
                self.read(archive_bytes(manifest, entries))

    def test_symlink_and_nonregular_entry_rejected(self):
        manifest, files = fixture()
        for mode in (stat.S_IFLNK, stat.S_IFIFO, stat.S_IFDIR):
            info = zipfile.ZipInfo("photos/photo-0.jpg")
            info.create_system = 3
            info.external_attr = (mode | 0o644) << 16
            with self.subTest(mode=mode), self.assertRaisesRegex(BundleError, "nonregular"):
                self.read(archive_bytes(manifest, files, photo_infos={info.filename: info}))

    def test_encrypted_central_flag_rejected(self):
        manifest, files = fixture()
        body = bytearray(archive_bytes(manifest, files))
        central = body.index(b"PK\x01\x02")
        struct.pack_into("<H", body, central + 8, 1)
        with self.assertRaisesRegex(BundleError, "Encrypted"):
            self.read(body)

    def test_forged_local_encryption_flag_rejected(self):
        manifest, files = fixture()
        body = bytearray(archive_bytes(manifest, files))
        struct.pack_into("<H", body, 6, 1)
        with self.assertRaisesRegex(BundleError, "headers disagree"):
            self.read(body)

    def test_forged_local_size_rejected(self):
        manifest, files = fixture()
        body = bytearray(archive_bytes(manifest, files))
        struct.pack_into("<I", body, 22, 1)
        with self.assertRaisesRegex(BundleError, "sizes or CRC disagree"):
            self.read(body)

    def test_crc_corruption_rejected(self):
        manifest, files = fixture()
        body = bytearray(archive_bytes(manifest, files))
        position = body.index(next(iter(files.values())))
        body[position + 8] ^= 1
        with self.assertRaises(BundleError):
            self.read(body)

    def test_truncation_nonzip_prefix_and_trailing_payload_rejected(self):
        manifest, files = fixture()
        body = archive_bytes(manifest, files)
        for invalid in (body[:-1], body[:-30], b"not a zip", b"prefix" + body, body + b"trailing"):
            with self.subTest(size=len(invalid)), self.assertRaises(BundleError):
                self.read(invalid)

    def test_json_duplicate_keys_and_nonfinite_values_rejected(self):
        manifest, files = fixture()
        for invalid in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}', b'{"x":1e999}', b"\xff", b"not-json"):
            with self.subTest(json=invalid), self.assertRaises(BundleError):
                self.read(archive_bytes(manifest, files, manifest_bytes=invalid))

    def test_manifest_schema_validation_is_not_skipped(self):
        manifest, files = fixture()
        manifest["inputRevision"] = True
        with self.assertRaisesRegex(BundleError, "manifest is invalid"):
            self.read(archive_bytes(manifest, files))

    def test_manifest_byte_limit(self):
        manifest, files = fixture()
        with self.assertRaisesRegex(BundleError, "declared byte limit"):
            self.read(archive_bytes(manifest, files, manifest_bytes=b" " * (256 * 1024 + 1)))

    def test_photo_byte_limit(self):
        manifest, files = fixture([b"x" * (4 * 1024 * 1024 + 1)])
        with self.assertRaisesRegex(BundleError, "declared byte limit"):
            self.read(archive_bytes(manifest, files))

    def test_total_declared_photo_limit(self):
        manifest, files = fixture([b"x" * (4 * 1024 * 1024)] * 7)
        with self.assertRaisesRegex(BundleError, "24 MiB"):
            self.read(archive_bytes(manifest, files))

    def test_oversized_compressed_upload_is_bounded_before_parsing(self):
        manifest, files = fixture()
        with patch("reconstruction.capture.bundle.MAX_ZIP_BYTES", 20):
            with self.assertRaisesRegex(BundleError, "32 MiB"):
                self.read(archive_bytes(manifest, files))

    def test_too_many_entries(self):
        manifest, files = fixture([jpeg()] * 17)
        with self.assertRaisesRegex(BundleError, "at most 16"):
            self.read(archive_bytes(manifest, files))

    def test_zip_bomb_ratio_rejected(self):
        manifest, files = fixture([jpeg(payload=b"0" * (2 * 1024 * 1024))])
        with self.assertRaisesRegex(BundleError, "compression ratio"):
            self.read(archive_bytes(manifest, files, compression=zipfile.ZIP_DEFLATED))

    def test_central_size_forgery_cannot_bypass_real_crc(self):
        manifest, files = fixture()
        body = bytearray(archive_bytes(manifest, files))
        first = body.index(b"PK\x01\x02")
        central = body.index(b"PK\x01\x02", first + 4)
        struct.pack_into("<I", body, central + 24, 1)
        with self.assertRaises(BundleError):
            self.read(body)


if __name__ == "__main__":
    unittest.main()
