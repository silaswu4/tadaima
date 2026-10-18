"""Native detected objects -> existing-owned, evidence-bound oriented box proxies."""
import math

CATEGORIES = {'storage', 'refrigerator', 'stove', 'bed', 'sink', 'washerDryer', 'toilet',
              'bathtub', 'oven', 'dishwasher', 'table', 'sofa', 'chair', 'fireplace',
              'television', 'stairs', 'unknown'}
LABELS = {'washerDryer': 'washer / dryer', 'unknown': 'object'}


def validate_objects(raw, seen):
    from .importer import _array, _object, _id, _vector, _transform, _fail
    objects = []
    for index, value in enumerate(_array(raw, 256, 'objects')):
        path = f'objects[{index}]'
        obj = _object(value, {'id', 'category', 'dimensions', 'transform', 'confidence'}, path)
        ident = _id(obj['id'], path + '.id')
        if ident in seen:
            _fail(path, 'duplicate room/surface/object identifier')
        seen.add(ident)
        if not isinstance(obj['category'], str) or obj['category'] not in CATEGORIES:
            _fail(path, 'unsupported object category')
        if obj['confidence'] not in ('low', 'medium', 'high', 'unknown'):
            _fail(path, 'unsupported object confidence')
        dimensions = _vector(obj['dimensions'], path + '.dimensions', .000001, 100)
        objects.append({'id': ident, 'category': obj['category'], 'dimensions': dimensions,
                        'transform': _transform(obj['transform'], path + '.transform', upright=False),
                        'confidence': obj['confidence']})
    return objects


def compile_objects(scan, floor_y, evidence, warnings):
    from .importer import _evidence_id, UPRIGHT_TOLERANCE
    items, omitted = [], []
    prefix = f"roomplan:{scan['projectId']}:{scan['jobId']}:"
    for obj in scan.get('objects', []):
        matrix, dims = obj['transform'], obj['dimensions']
        # Canonical PlacedItem supports yaw only. Retain unsupported poses in
        # scan.input.json and explicitly omit them rather than flattening them.
        if max(abs(matrix[4]), abs(matrix[5] - 1), abs(matrix[6]), abs(matrix[1]), abs(matrix[9])) > UPRIGHT_TOLERANCE:
            omitted.append({'id': obj['id'], 'reason': 'tilted object requires full rotation; yaw-only proxy omitted'})
            warnings.append(f"Object {obj['id']} has a tilted pose; source retained but no flattened furniture proxy was invented.")
            continue
        evidence_id = _evidence_id(prefix + 'object:' + obj['id'])
        category = LABELS.get(obj['category'], obj['category'])
        evidence.append({'id': evidence_id, 'sourceUrl': None, 'privateAssetId': prefix + 'object:' + obj['id'],
                         'observedAt': scan['capturedAt'], 'claim': (
                             f"Native RoomPlan detected {category}; confidence {obj['confidence']}. "
                             'Category, dimensions and pose are sensor estimates represented as an oriented bounding box, '
                             'not an exact furniture mesh, ownership verification, or merchant product match.'),
                         'dimensionStatus': 'source_dimension', 'confirmedByUserAt': None})
        items.append({'id': obj['id'], 'roomId': scan['roomId'], 'label': f'Detected {category}',
                      'origin': 'existing_owned', 'productId': None, 'assetUrl': None,
                      'position': [matrix[12], matrix[13] - floor_y - dims[1] / 2, matrix[14]],
                      'rotationY': math.atan2(-matrix[2], matrix[0]), 'dimensions': list(dims),
                      'locked': True, 'evidenceIds': [evidence_id]})
        if obj['confidence'] in ('low', 'unknown'):
            warnings.append(f"Object {obj['id']} has {obj['confidence']} capture confidence; review its size and placement.")
    return items, omitted
