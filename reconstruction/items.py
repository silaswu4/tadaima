"""Bounded canonical existing-item proxies, never merchant assets or products."""
import math


def validate_items(raw, geometry, evidence):
    from reconstruction.geometry import (_object, _list, _id, _text, _number, _refs, _fail)
    rooms = {room['id'] for room in geometry['rooms']}
    ids = {item['id'] for group in ('rooms', 'walls', 'openings') for item in geometry[group]}
    known = {entry['id'] for entry in evidence}
    items = []
    for index, value in enumerate(_list(raw, 'items', 256)):
        path = f'items[{index}]'
        obj = _object(value, path, {'id', 'roomId', 'label', 'origin', 'productId', 'assetUrl',
                                  'position', 'rotationY', 'dimensions', 'locked', 'evidenceIds'})
        ident = _id(obj['id'], path + '.id')
        room_id = _id(obj['roomId'], path + '.roomId')
        if ident in ids or room_id not in rooms:
            _fail(path, 'duplicate entity ID or unknown room')
        ids.add(ident)
        if obj['origin'] != 'existing_owned' or obj['productId'] is not None or obj['assetUrl'] is not None:
            _fail(path, 'captured proxies must be existing_owned without a merchant product or remote asset')
        if not isinstance(obj['locked'], bool):
            _fail(path, 'locked must be boolean')
        position = [_number(component, path + '.position', -10000, 10000)
                    for component in _list(obj['position'], path + '.position', 3, 3)]
        dimensions = [_number(component, path + '.dimensions', .000001, 100)
                      for component in _list(obj['dimensions'], path + '.dimensions', 3, 3)]
        refs = _refs(obj['evidenceIds'], path + '.evidenceIds', known)
        if not refs:
            _fail(path, 'captured items require source evidence')
        items.append({'id': ident, 'roomId': room_id, 'label': _text(obj['label'], path + '.label'),
                      'origin': 'existing_owned', 'productId': None, 'assetUrl': None,
                      'position': position, 'rotationY': _number(obj['rotationY'], path + '.rotationY', -2 * math.pi, 2 * math.pi),
                      'dimensions': dimensions, 'locked': obj['locked'], 'evidenceIds': refs})
    return items
