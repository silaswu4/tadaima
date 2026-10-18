"""Real Blender check of estimated room patterns and closed aperture details."""
import json
from pathlib import Path
import struct
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from reconstruction.designed_surfaces import room_design_materials, dress_opening

output = Path(sys.argv[sys.argv.index("--")+1])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
geometry = {"rooms":[{"id":"synthetic-room"}],"walls":[{"id":"synthetic-wall"},{"id":"fallback-wall"}]}
profile = {"surfaces":[
    {"entityId":"synthetic-room","finish":"carpet","color":"#9f8e74","secondaryColor":"#ded5bd",
     "pattern":"inset_dash","roughness":.94,"repeatMeters":4.,"rotationDegrees":23,"confidence":"high","evidenceIds":["synthetic-photo"]},
    {"entityId":"synthetic-wall","finish":"paint","color":"#e6d9b8","secondaryColor":"#e6d9b8",
     "pattern":"plain","roughness":.88,"repeatMeters":1,"rotationDegrees":0,"confidence":"medium","evidenceIds":["synthetic-photo"]}]}
bindings,summary=room_design_materials(geometry,profile)
assert set(bindings)=={"synthetic-room","synthetic-wall","fallback-wall"}
carpet,tile,rotation=bindings["synthetic-room"]
assert tile==4. and rotation==23
images=[n.image for n in carpet.node_tree.nodes if n.type=="TEX_IMAGE" and n.image.get("appearanceSource")]
assert len(images)==1 and list(images[0].size)==[1024,1024] and images[0].packed_file
assert images[0].colorspace_settings.name=="sRGB"
pixels=np.empty(len(images[0].pixels),dtype=np.float32);images[0].pixels.foreach_get(pixels)
rgba=pixels.reshape((1024,1024,4))
assert rgba[:,:,:3].max()-rgba[:,:,:3].min()>.1
assert rgba[160:864,200:824,:3].mean()-rgba[:80,:,:3].mean()>.12,"Beige inset must contrast with plain brown border"
assert rgba[160:864,200:824,:3].std()>.035,"Inset must retain visible fine dash/weave pattern"
assert np.all(rgba[:,:,3]==1)
assert any(n.type=="NORMAL_MAP" and abs(n.inputs["Strength"].default_value-.035)<1e-6 for n in carpet.node_tree.nodes)
assert carpet.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value>.9
assert bindings["fallback-wall"][0]["appearanceStatus"]=="styling_default"
other,_=room_design_materials(geometry,profile)
second=next(n.image for n in other["synthetic-room"][0].node_tree.nodes if n.type=="TEX_IMAGE" and n.image.get("appearanceSource"))
second_pixels=np.empty(len(second.pixels),dtype=np.float32);second.pixels.foreach_get(second_pixels)
assert np.array_equal(second_pixels,pixels),"Estimated weave must be deterministic"
assert summary["surfaces"][0]["evidenceIds"]==["synthetic-photo"]
all_details=[]
for index,kind in enumerate(["window","door"]):
    owner=bpy.data.objects.new("Synthetic_"+kind,None);bpy.context.scene.collection.objects.link(owner)
    owner["entityId"]="synthetic-"+kind;owner["role"]="opening"
    owner.location=(index*3,1.2,1.1);owner.scale=(.9,.06,1.1);owner.rotation_euler.z=.47
    before=(tuple(owner.location),tuple(owner.scale),tuple(owner.rotation_euler))
    opening={"id":owner["entityId"],"wallId":"synthetic-wall","kind":kind}
    details=dress_opening(opening,owner,.12,profile)
    assert len(details)==(7 if kind=="window" else 3)
    assert before==(tuple(owner.location),tuple(owner.scale),tuple(owner.rotation_euler))
    for detail in details:
        assert detail.parent==owner and "entityId" not in detail and "role" not in detail
        assert detail["ownerOpeningId"]==owner["entityId"]
        assert all(-1-1e-6<=value<=1+1e-6 for vertex in detail.data.vertices for value in vertex.co)
        bm=bmesh.new();bm.from_mesh(detail.data)
        assert all(e.is_manifold for e in bm.edges) and bm.calc_volume(signed=True)>0
        bm.free()
        all_details.append(detail)
    if kind=="window":
        glass=next(d for d in details if d["componentKind"]=="WindowGlass")
        shader=glass.data.materials[0].node_tree.nodes["Principled BSDF"]
        assert shader.inputs["Alpha"].default_value<.3 and shader.inputs["Transmission Weight"].default_value==0
        blind=next(d for d in details if d["componentKind"]=="PartialRollerBlind")
        assert min(v.co.z for v in blind.data.vertices)>0
    else:
        assert all(d["componentKind"].startswith("Frame") for d in details),"Door cannot invent an obstructing leaf"
# One floor quad demonstrates portable PBR pattern export with an ordinary UV map.
mesh=bpy.data.meshes.new("PatternProof");mesh.from_pydata([(0,0,0),(1,0,0),(1,1,0),(0,1,0)],[],[(0,1,2,3)]);mesh.update()
floor=bpy.data.objects.new("PatternProof",mesh);bpy.context.scene.collection.objects.link(floor);mesh.materials.append(carpet)
uv=mesh.uv_layers.new(name="UVMap")
for loop,point in zip(uv.data,[(0,0),(1,0),(1,1),(0,1)]):loop.uv=point
bpy.ops.wm.save_as_mainfile(filepath=str(output/"designed-surfaces.blend"))
bpy.ops.export_scene.gltf(filepath=str(output/"designed-surfaces.glb"),export_format="GLB",export_extras=True,
                          export_yup=True,export_materials="EXPORT",export_animations=False,export_cameras=False,export_lights=False)
body=(output/"designed-surfaces.glb").read_bytes();length=struct.unpack_from("<I",body,12)[0];gltf=json.loads(body[20:20+length])
assert all("bufferView" in image and "uri" not in image for image in gltf["images"])
assert any(m.get("pbrMetallicRoughness",{}).get("baseColorTexture") and m.get("normalTexture") for m in gltf["materials"])
assert any(m.get("alphaMode")=="BLEND" for m in gltf["materials"]),gltf["materials"]
assert "KHR_materials_transmission" not in gltf.get("extensionsUsed",[]),"Glass must use viewer-compatible alpha, not unallowlisted refraction"
assert "KHR_materials_ior" not in gltf.get("extensionsUsed",[]),"Alpha-only glass must not require a refraction extension"
assert len([n for n in gltf["nodes"] if n.get("extras",{}).get("ownerOpeningId")])==10
print("TADAIMA_DESIGNED_SURFACES_VERIFIED: deterministic packed weave, evidence, PBR, closed trim, parent bounds, transparent solid glass, partial blind, unobstructed door, embedded GLB")
