"""Photo-to-scene binding, synthetic native archive; no registration accuracy claim."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import stat
import tempfile
import unittest

from reconstruction.geometry import validate_request
from reconstruction.roomplan import RoomPlanError, run
from reconstruction.roomplan.importer import _evidence_id
from reconstruction.roomplan.texture_source import prepare_texture_source
from reconstruction.tests.test_roomplan_photo_bundle import archive_bytes, fixture


class TextureSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manifest, self.files = fixture(3, floor=1.25)
        self.bundle = self.root / 'native.zip'
        self.bundle.write_bytes(archive_bytes(self.manifest, self.files))
        self.imported = self.root / 'imported'
        run(self.bundle, self.imported)
        self.request = json.loads((self.imported / 'reconstruction.request.json').read_text())
        self.output = self.root / 'photo-sources'

    def test_exact_scene_hash_private_original_photos_and_unmodified_request(self):
        before = deepcopy(self.request)
        path = prepare_texture_source(self.bundle, self.request, self.output)
        self.assertEqual(path, self.output / 'photo-input.json')
        self.assertEqual(self.request, before)
        source = json.loads(path.read_text())
        scene_bytes = (json.dumps(validate_request(self.request), sort_keys=True, indent=2,
                                 ensure_ascii=False, allow_nan=False) + '\n').encode()
        self.assertEqual(source['inputSha256'], hashlib.sha256(scene_bytes).hexdigest())
        self.assertEqual(set(source), {'schemaVersion', 'projectId', 'jobId', 'inputRevision',
                                     'inputSha256', 'sourceArchiveSha256', 'sourceToCanonicalTranslation', 'photos'})
        self.assertEqual(source['sourceArchiveSha256'], hashlib.sha256(self.bundle.read_bytes()).hexdigest())
        self.assertEqual(source['schemaVersion'], 'roomplan-texture-source/1.0')
        self.assertEqual(source['sourceToCanonicalTranslation'], [0, -1.25, 0])
        self.assertEqual(len(source['photos']), 3)
        for actual, original in zip(source['photos'], self.manifest['photos']):
            self.assertEqual({key: actual[key] for key in original}, original)
            self.assertEqual(actual['evidenceId'], _evidence_id(self.request['jobId'] + ':rgb:' + original['id']))
            self.assertEqual((self.output / actual['path']).read_bytes(), self.files[actual['path']])
        for path in [self.output, *self.output.rglob('*')]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)

    def test_identity_geometry_and_optional_items_are_bound_before_writing(self):
        requests = []
        for key, value in (('projectId', 'different-project'), ('jobId', 'different-job'), ('inputRevision', 4)):
            changed = deepcopy(self.request)
            changed[key] = value
            requests.append(changed)
        changed = deepcopy(self.request)
        changed['geometry']['rooms'][0]['height'] += 0.1
        requests.append(changed)
        changed = deepcopy(self.request)
        changed['items'] = []
        requests.append(changed)
        for changed in requests:
            with self.subTest(request=changed), self.assertRaises(RoomPlanError):
                prepare_texture_source(self.bundle, changed, self.output)
            self.assertFalse(self.output.exists())

    def test_absent_or_tampered_photo_evidence_is_rejected_before_writing(self):
        photo = self.manifest['photos'][0]
        ident = _evidence_id(self.request['jobId'] + ':rgb:' + photo['id'])
        for field, value in ((None, None), ('claim', 'photo SHA-256 ' + '0' * 64),
                             ('privateAssetId', 'other-photo'), ('observedAt', '2026-10-18T13:00:00Z')):
            changed = deepcopy(self.request)
            if field is None:
                changed['evidence'] = [entry for entry in changed['evidence'] if entry['id'] != ident]
            else:
                next(entry for entry in changed['evidence'] if entry['id'] == ident)[field] = value
            with self.subTest(field=field), self.assertRaises(RoomPlanError):
                prepare_texture_source(self.bundle, changed, self.output)
            self.assertFalse(self.output.exists())

    def test_appearance_changes_are_allowed_and_update_scene_binding_hash(self):
        changed = deepcopy(self.request)
        photo = self.manifest['photos'][0]
        ref = _evidence_id(changed['jobId'] + ':rgb:' + photo['id'])
        changed['appearance'] = {'schemaVersion': 'room-appearance/1.0', 'reviewRequired': True,
            'scope': 'captured_room', 'sources': [{'evidenceId': ref, 'sha256': photo['sha256']}],
            'surfaces': [{'entityId': changed['geometry']['rooms'][0]['id'], 'finish': 'carpet',
                'color': '#AABBCC', 'roughness': 0.9, 'tileMeters': 1, 'rotationDegrees': 0,
                'confidence': 'medium', 'evidenceIds': [ref]}], 'notes': []}
        path = prepare_texture_source(self.bundle, changed, self.output)
        source = json.loads(path.read_text())
        normalized = validate_request(changed)
        expected = (json.dumps(normalized, sort_keys=True, indent=2, ensure_ascii=False,
                               allow_nan=False) + '\n').encode()
        self.assertEqual(source['inputSha256'], hashlib.sha256(expected).hexdigest())
        self.assertEqual(changed['appearance']['surfaces'][0]['color'], '#AABBCC')

    def test_existing_directory_and_symlink_are_not_reused(self):
        self.output.mkdir()
        marker = self.output / 'keep.txt'
        marker.write_text('preserve')
        with self.assertRaises(RoomPlanError):
            prepare_texture_source(self.bundle, self.request, self.output)
        self.assertEqual(marker.read_text(), 'preserve')
        link = self.root / 'link'
        link.symlink_to(self.root / 'nonexistent')
        with self.assertRaises(RoomPlanError):
            prepare_texture_source(self.bundle, self.request, link)

    def test_archive_hash_validation_and_bounds_are_rechecked(self):
        changed = deepcopy(self.manifest)
        changed['photos'][0]['sha256'] = '0' * 64
        self.bundle.write_bytes(archive_bytes(changed, self.files))
        with self.assertRaises(RoomPlanError):
            prepare_texture_source(self.bundle, self.request, self.output)
        self.assertFalse(self.output.exists())
        path = self.manifest['photos'][0]['path']
        self.bundle.write_bytes(archive_bytes(self.manifest, {**self.files, path: b'x' * (2 * 1024 * 1024 + 1)}))
        with self.assertRaises(RoomPlanError):
            prepare_texture_source(self.bundle, self.request, self.output)
        self.assertFalse(self.output.exists())

    def test_captured_item_placement_binding(self):
        scan = json.loads(self.files['roomplan.json'])
        scan['schemaVersion'] = 'roomplan-scan/1.1'
        scan['objects'] = [{'id': 'native-sofa', 'category': 'sofa', 'confidence': 'high',
            'dimensions': [2, 1, .8], 'transform': [1,0,0,0,0,1,0,0,0,0,1,0,2,1.75,2,1]}]
        self.files['roomplan.json'] = json.dumps(scan).encode()
        self.manifest['scan']['sha256'] = hashlib.sha256(self.files['roomplan.json']).hexdigest()
        self.bundle.write_bytes(archive_bytes(self.manifest, self.files))
        imported = self.root / 'with-furniture'
        run(self.bundle, imported)
        request = json.loads((imported / 'reconstruction.request.json').read_text())
        self.assertEqual(len(request['items']), 1)
        changed = deepcopy(request)
        changed['items'][0]['position'][0] += 0.1
        with self.assertRaises(RoomPlanError):
            prepare_texture_source(self.bundle, changed, self.output)
        self.assertFalse(self.output.exists())
        prepare_texture_source(self.bundle, request, self.output)


if __name__ == '__main__':
    unittest.main()
