"""Synthetic JPEG headers and poses exercise bounds; no physical scan claim."""
from copy import deepcopy
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

from reconstruction.appearance import prepare_appearance, read_photos
from reconstruction.roomplan import RoomPlanError, import_scan, run
from reconstruction.roomplan.photo_bundle import read_photo_bundle, representative_photos
from reconstruction.tests.test_roomplan import packet


def fixture(count=1, floor=1.25):
    scan = packet(floor=floor)
    scan_bytes = json.dumps(scan).encode()
    photos, files = [], {}
    for i in range(count):
        ident = f"photo-00000000-0000-0000-0000-{i:012d}"
        # Deliberately synthetic SOF header, not a decoded or photographic image.
        body = b'\xff\xd8\xff\xc0\x00\x0b\x08' + struct.pack('>HH', 480, 640) + b'\x01\x01\x11\x00' + str(i).encode() + b'\xff\xd9'
        photos.append({"id": ident, "path": f"photos/{ident}.jpg", "sha256": hashlib.sha256(body).hexdigest(),
            "byteLength": len(body), "width": 640, "height": 480, "capturedAt": "2026-10-18T12:00:00.000Z",
            "arTimestamp": 100 + i, "cameraToWorld": [1,0,0,0,0,1,0,0,0,0,1,0,i,floor + 1.5,0,1],
            "intrinsics": [500,0,0,0,500,0,320,240,1], "trackingState": "normal"})
        files[photos[-1]["path"]] = body
    manifest = {"schemaVersion": "roomplan-photo-bundle/1.0", "projectId": scan["projectId"],
        "jobId": scan["jobId"], "inputRevision": scan["inputRevision"],
        "coordinateSystem": "arkit-gravity-y-up-metres", "imageConvention": "raw-sensor-top-left",
        "scan": {"path": "roomplan.json", "sha256": hashlib.sha256(scan_bytes).hexdigest()}, "photos": photos}
    return manifest, {"roomplan.json": scan_bytes, **files}


def archive_bytes(manifest, files, compression=zipfile.ZIP_STORED, extras=()):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression) as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        for name, body in files.items():
            archive.writestr(name, body)
        for name, body in extras:
            archive.writestr(name, body)
    return stream.getvalue()


class PhotoBundleTests(unittest.TestCase):
    def read(self, manifest=None, files=None, body=None):
        if manifest is None:
            manifest, files = fixture()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'scan.zip'
            path.write_bytes(body if body is not None else archive_bytes(manifest, files))
            return read_photo_bundle(path)

    def test_stored_and_deflated_archive_preserve_originals(self):
        manifest, files = fixture()
        for compression in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            body = archive_bytes(manifest, files, compression)
            result = self.read(body=body)
            self.assertEqual(result['manifest'], manifest)
            self.assertEqual(result['scanBytes'], files['roomplan.json'])
            self.assertEqual(result['archiveBytes'], body)
            self.assertEqual(result['files'][manifest['photos'][0]['path']], files[manifest['photos'][0]['path']])

    def test_manifest_identity_hashes_dimensions_and_calibration_fail_closed(self):
        cases = [("jobId", "other-job"), ("inputRevision", True), ("schemaVersion", "bad"),
                 ("coordinateSystem", "unknown"), ("imageConvention", "upright")]
        for key, value in cases:
            manifest, files = fixture()
            manifest[key] = value
            with self.subTest(key=key), self.assertRaises(RoomPlanError):
                self.read(manifest, files)
        cases = [("sha256", "0" * 64), ("byteLength", 2), ("width", 800), ("height", 1601),
                 ("trackingState", "limited"), ("arTimestamp", float('nan')), ("arTimestamp", 0),
                 ("capturedAt", "2026-10-18T12:00:00-07:00"), ("capturedAt", "2026-10-18"),
                 ("intrinsics", [500,0,0,0,500,0,800,240,1]),
                 ("intrinsics", [500,0,0,0,500,0,320,240,0]),
                 ("intrinsics", [500,0,0,0,500,1,320,240,1]),
                 ("cameraToWorld", [2,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),
                 ("cameraToWorld", [-1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),
                 ("cameraToWorld", [1,0,0,0,0,1,0,0,0,0,1,0,0,float('inf'),0,1])]
        for key, value in cases:
            manifest, files = fixture()
            manifest['photos'][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(RoomPlanError):
                self.read(manifest, files)
        manifest, files = fixture()
        manifest['scan']['sha256'] = '0' * 64
        with self.assertRaisesRegex(RoomPlanError, 'scan SHA'):
            self.read(manifest, files)

    def test_unsafe_duplicate_undeclared_symlink_and_encrypted_entries_rejected(self):
        manifest, files = fixture()
        for name in ('../outside', '/absolute', 'photos/../../escape.jpg', 'photos\\escape.jpg', 'unlisted.json'):
            with self.subTest(name=name), self.assertRaises(RoomPlanError):
                self.read(body=archive_bytes(manifest, files, extras=[(name, b'bad')]))
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            body = archive_bytes(manifest, files, extras=[('roomplan.json', files['roomplan.json'])])
        with self.assertRaises(RoomPlanError):
            self.read(body=body)
        source = archive_bytes(manifest, files)
        for flag in ('symlink', 'encrypted'):
            body = bytearray(source)
            central = body.index(b'PK\x01\x02')
            if flag == 'symlink':
                struct.pack_into('<I', body, central + 38, (stat.S_IFLNK | 0o777) << 16)
            else:
                struct.pack_into('<H', body, central + 8, 1)
                struct.pack_into('<H', body, 6, 1)
            with self.subTest(flag=flag), self.assertRaises(RoomPlanError):
                self.read(body=bytes(body))

    def test_crc_corruption_truncation_prefix_and_trailing_payload_rejected(self):
        manifest, files = fixture()
        body = archive_bytes(manifest, files)
        damaged = bytearray(body)
        offset = damaged.index(b'\xff\xd8\xff')
        damaged[offset + 1] ^= 1
        for value in (bytes(damaged), body[:-10], b'executable' + body, body + b'hidden'):
            with self.subTest(length=len(value)), self.assertRaises(RoomPlanError):
                self.read(body=value)

    def test_empty_duplicate_photo_and_non_jpeg_are_rejected(self):
        manifest, files = fixture()
        manifest['photos'] = []
        with self.assertRaises(RoomPlanError):
            self.read(manifest, files)
        manifest, files = fixture(2)
        manifest['photos'][1]['sha256'] = manifest['photos'][0]['sha256']
        with self.assertRaises(RoomPlanError):
            self.read(manifest, files)
        manifest, files = fixture()
        photo = manifest['photos'][0]
        for data in (b'not jpeg', files[photo['path']][:-2]):
            changed = deepcopy(manifest)
            changed['photos'][0].update(sha256=hashlib.sha256(data).hexdigest(), byteLength=len(data))
            with self.assertRaises(RoomPlanError):
                self.read(changed, {**files, photo['path']: data})

    def test_count_and_entry_size_limits(self):
        manifest, files = fixture(33)
        with self.assertRaises(RoomPlanError):
            self.read(manifest, files)
        manifest, files = fixture()
        path = manifest['photos'][0]['path']
        with self.assertRaises(RoomPlanError):
            self.read(manifest, {**files, path: b'x' * (2 * 1024 * 1024 + 1)})

    def test_invalid_bundle_and_authorization_fail_before_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = Path(temporary) / 'scan.zip', Path(temporary) / 'out'
            source.write_bytes(b'bad')
            with self.assertRaises(RoomPlanError):
                run(source, output)
            self.assertFalse(output.exists())
            manifest, files = fixture()
            source.write_bytes(archive_bytes(manifest, files))
            with self.assertRaises(RoomPlanError):
                run(source, output, expected_job='unauthorized')
            self.assertFalse(output.exists())

    def test_private_import_preserves_geometry_poses_and_appearance_handoff(self):
        manifest, files = fixture(12)
        raw_scan = json.loads(files['roomplan.json'])
        expected_geometry = import_scan(raw_scan)['request']['geometry']
        body = archive_bytes(manifest, files)
        with tempfile.TemporaryDirectory() as temporary:
            source, output = Path(temporary) / 'scan.zip', Path(temporary) / 'out'
            source.write_bytes(body)
            dossier = run(source, output, expected_job=manifest['jobId'])
            self.assertEqual(dossier['status'], 'needs_review')
            self.assertEqual(dossier['photoCount'], 12)
            self.assertEqual(dossier['appearancePhotoCount'], 8)
            self.assertEqual((output / 'scan.input.zip').read_bytes(), body)
            self.assertEqual((output / 'scan.input.json').read_bytes(), files['roomplan.json'])
            self.assertEqual(json.loads((output / 'photos.manifest.json').read_bytes()), manifest)
            request = json.loads((output / 'reconstruction.request.json').read_text())
            self.assertEqual(request['geometry'], expected_geometry)
            photos = read_photos(output / 'appearance.photos.json')
            prepared = prepare_appearance(request, photos)
            self.assertEqual(len(prepared['photos']), 8)
            self.assertTrue(all(p['scope'] == 'captured_room' for p in photos))
            registration = json.loads((output / 'photo-registration.json').read_text())
            self.assertEqual(registration['sourceToCanonicalTranslation'], [0, -1.25, 0])
            for actual, expected in zip(registration['photos'], manifest['photos']):
                self.assertEqual(actual['cameraToWorld'], expected['cameraToWorld'])
                self.assertEqual(actual['intrinsics'], expected['intrinsics'])
                evidence = next(e for e in request['evidence'] if e['id'] == actual['evidenceId'])
                self.assertIsNone(evidence['dimensionStatus'])
                self.assertIn(expected['sha256'], evidence['claim'])
            self.assertTrue(any('do not automatically' in warning for warning in dossier['warnings']))
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((output / 'photos').stat().st_mode), 0o700)
            for path in output.rglob('*'):
                if path.is_file():
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_duplicate_json_keys_nonfinite_scan_and_corrupt_deflate_rejected(self):
        manifest, files = fixture()
        invalid_scan = json.loads(files['roomplan.json'])
        invalid_scan['surfaces'][0]['transform'][12] = float('nan')
        for scan_bytes in (b'{"schemaVersion":1,"schemaVersion":2}', json.dumps(invalid_scan).encode()):
            changed = deepcopy(manifest)
            changed['scan']['sha256'] = hashlib.sha256(scan_bytes).hexdigest()
            with self.assertRaises(RoomPlanError):
                self.read(changed, {**files, 'roomplan.json': scan_bytes})
        body = bytearray(archive_bytes(manifest, files, zipfile.ZIP_DEFLATED))
        name_length, extra_length = struct.unpack('<HH', body[26:30])
        body[30 + name_length + extra_length] ^= 0xff
        with self.assertRaises(RoomPlanError):
            self.read(body=bytes(body))

    def test_pose_diversity_selection_is_bounded_and_deterministic(self):
        photos = fixture(32)[0]['photos']
        selected = representative_photos(photos)
        self.assertEqual(len(selected), 8)
        self.assertEqual(selected, representative_photos(photos))
        self.assertIn(photos[0], selected)
        self.assertIn(photos[-1], selected)


if __name__ == '__main__':
    unittest.main()
