"""Sensor furniture provenance, orientation, legacy packets and hostile inputs."""
from copy import deepcopy
import json,math
from pathlib import Path
import unittest

from reconstruction.geometry import GeometryError,validate_request
from reconstruction.roomplan import RoomPlanError,import_scan,validate_scan
from reconstruction.tests.test_roomplan import packet,rotate_packet


def native_object(ident='captured-sofa', *, yaw=.6, y=.6):
    c,s=math.cos(yaw),math.sin(yaw)
    return {'id':ident,'category':'sofa','dimensions':[2,1.2,.8],
            'transform':[c,0,-s,0, 0,1,0,0, s,0,c,0, 2,y,2,1], 'confidence':'medium'}


def with_objects(*objects):
    scan=packet();scan['schemaVersion']='roomplan-scan/1.1';scan['objects']=list(objects)
    return scan


class CapturedFurnitureTests(unittest.TestCase):
    def test_old_packet_keeps_original_wire_shape(self):
        raw=packet()
        self.assertEqual(validate_scan(raw),raw)
        self.assertNotIn('items',import_scan(raw)['request'])
        self.assertNotIn('objects',validate_scan(raw))

    def test_new_packet_requires_objects_and_preserves_empty(self):
        raw=with_objects()
        self.assertEqual(validate_scan(raw),raw)
        self.assertEqual(import_scan(raw)['request']['items'],[])
        del raw['objects']
        with self.assertRaises(RoomPlanError):validate_scan(raw)
        raw=packet();raw['objects']=[]
        with self.assertRaises(RoomPlanError):validate_scan(raw)

    def test_pose_dimensions_and_provenance_are_separate_from_geometry(self):
        raw=with_objects(native_object())
        before=deepcopy(raw)
        result=import_scan(raw)
        item=result['request']['items'][0]
        self.assertEqual(raw,before)
        self.assertEqual(result['request']['geometry'],import_scan(packet())['request']['geometry'])
        self.assertEqual(item['dimensions'],[2,1.2,.8])
        self.assertEqual(item['position'],[2,0,2])
        self.assertAlmostEqual(item['rotationY'],.6)
        self.assertEqual(item['origin'],'existing_owned')
        self.assertTrue(item['locked'])
        self.assertIsNone(item['productId']);self.assertIsNone(item['assetUrl'])
        evidence=next(e for e in result['request']['evidence'] if e['id']==item['evidenceIds'][0])
        self.assertEqual(evidence['dimensionStatus'],'source_dimension')
        self.assertIsNone(evidence['confirmedByUserAt'])
        self.assertIn('medium',evidence['claim'])
        self.assertIn('bounding box',evidence['claim'])
        self.assertEqual(result['importedItemCount'],1)

    def test_elevated_objects_are_not_snapped_to_floor(self):
        raw=with_objects(native_object(y=2))
        for surface in raw['surfaces']:surface['transform'][13]+=3
        raw['objects'][0]['transform'][13]+=3
        item=import_scan(raw)['request']['items'][0]
        self.assertAlmostEqual(item['position'][1],1.4)

    def test_rotated_scene_keeps_object_in_same_frame_as_room(self):
        raw=with_objects(native_object(yaw=.2))
        # rotate_packet handles structural transforms; apply same transform to object.
        result=rotate_packet(raw,.7,tx=-7,tz=-9)
        m=result['objects'][0]['transform'];c,s=math.cos(.7),math.sin(.7)
        for k in (0,4,8):m[k],m[k+2]=c*m[k]-s*m[k+2],s*m[k]+c*m[k+2]
        m[12],m[14]=c*m[12]-s*m[14]-7,s*m[12]+c*m[14]-9
        item=import_scan(result)['request']['items'][0]
        self.assertAlmostEqual(item['rotationY'],.2-.7)
        self.assertAlmostEqual(item['position'][0],c*2-s*2-7)
        self.assertAlmostEqual(item['position'][2],s*2+c*2-9)

    def test_unsupported_tilt_is_explicitly_omitted_not_flattened(self):
        obj=native_object(yaw=0)
        c,s=math.cos(.2),math.sin(.2)
        obj['transform']=[1,0,0,0, 0,c,s,0, 0,-s,c,0, 2,1,2,1]
        result=import_scan(with_objects(obj))
        self.assertEqual(result['request']['items'],[])
        self.assertEqual(result['detectedObjectCount'],1)
        self.assertEqual(result['omittedObjects'][0]['id'],obj['id'])
        self.assertTrue(any('tilted pose' in w for w in result['warnings']))

    def test_unknown_source_confidence_stays_unknown(self):
        obj=native_object();obj.update(category='unknown',confidence='unknown')
        result=import_scan(with_objects(obj))
        self.assertEqual(result['request']['items'][0]['label'],'Detected object')
        self.assertTrue(any('unknown capture confidence' in w for w in result['warnings']))

    def test_bad_native_objects_rejected(self):
        for updates in ({'category':'merchant_sofa'}, {'category':[]}, {'confidence':{}},
                        {'dimensions':[1,0,1]}, {'dimensions':[1,float('nan'),1]},
                        {'dimensions':[1,1,True]}, {'dimensions':[1,1,101]}, {'id':'wall-0'},
                        {'id':'room-native'}, {'assetUrl':'https://remote/model.glb'}):
            with self.subTest(updates=updates),self.assertRaises(RoomPlanError):
                validate_scan(with_objects({**native_object(),**updates}))
        with self.assertRaises(RoomPlanError):validate_scan(with_objects(native_object(),native_object()))
        with self.assertRaises(RoomPlanError):validate_scan(with_objects(*[native_object(str(i)) for i in range(257)]))

    def test_canonical_items_are_bounded_cited_and_no_network(self):
        request=import_scan(with_objects(native_object()))['request']
        self.assertEqual(validate_request(request),request)
        item=request['items'][0]
        for updates in ({'id':request['geometry']['walls'][0]['id']}, {'roomId':'missing'},
                        {'assetUrl':'https://remote/model.glb'}, {'productId':'sku'},
                        {'origin':'proposed_purchase'}, {'dimensions':None}, {'dimensions':[1,0,1]},
                        {'position':[True,0,0]}, {'position':[0,float('inf'),0]},
                        {'rotationY':7}, {'locked':1}, {'evidenceIds':[]}, {'evidenceIds':['unknown']},
                        {'evidenceIds':item['evidenceIds']*2}):
            with self.subTest(updates=updates),self.assertRaises(GeometryError):
                validate_request({**request,'items':[{**item,**updates}]})
        with self.assertRaises(GeometryError):validate_request({**request,'items':[item,item]})

    def test_swift_emitted_fixture_matches_sensor_semantics(self):
        # Checked-in source fixture below is synthetic, not any user's room.
        raw=json.loads((Path(__file__).parents[1]/'fixtures/native-furniture.synthetic.json').read_text())
        result=import_scan(raw)
        sofa,table=result['request']['items']
        self.assertAlmostEqual(sofa['rotationY'],-math.pi/2)
        self.assertEqual(sofa['position'],[1,0,1.75])
        self.assertAlmostEqual(table['position'][1],.75)


if __name__=='__main__':unittest.main()
