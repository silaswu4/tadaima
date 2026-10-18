"""Photo-informed clean room finishes and bounded aperture details for Blender.

Patterns are deterministic visual estimates from cited observations, not pasted
camera photographs, measured fibers, recovered albedo or manufacturer assets.
Geometry and semantic IDs remain owned by the canonical room/opening objects.
"""
from __future__ import annotations

import json
from pathlib import Path
import tempfile

import bpy
import numpy as np

from reconstruction.shading import linear_color, pbr_material, room_materials


def _encoded_color(value):
    return np.array([int(value[index:index + 2], 16) / 255 for index in (1, 3, 5)], dtype=np.float32)


def _carpet_pattern(name, spec):
    side = 1024 if spec["pattern"] == "inset_dash" else 256
    y, x = np.indices((side, side))
    # Short staggered light dashes in tightly spaced rows approximate the
    # observed brown/beige striated weave. Integer hashing is deterministic,
    # periodic at the tile boundary and independent of Blender's noise shaders.
    row = y // 4
    stagger = (row * 13 + row * row * 7) % 32
    phase = (x + stagger) % 32
    lengths = 6 + ((row * 17) % 15)
    if spec["pattern"] == "inset_dash":
        # A large beige carpet inset with thin brown linear flecks, surrounded
        # by a plain brown floor zone. Physical inset size is still estimated;
        # repeatMeters controls the whole tile rather than individual fibers.
        inset = (x >= round(side*.15)) & (x < round(side*.85)) & (y >= round(side*.1)) & (y < round(side*.9))
        inset_phase = (x + stagger) % 16
        inset_lengths = 3 + ((row * 17) % 7)
        fleck = ((y % 4) < 1) & (inset_phase < inset_lengths)
        mix = np.where(inset, np.where(fleck, .28, .88), 0.)
    elif spec["pattern"] == "dash":
        mix = np.where(((y % 4) < 2) & (phase < lengths), .88, .12)
    elif spec["pattern"] == "linear":
        mix = np.where((y % 8) < 3, .82, .18)
        mix += np.where(((x + row * 11) % 48) < 9, .08, -.03)
    else:
        mix = np.full((side, side), .12)
    mix = np.clip(mix, 0, 1)[..., None]
    base, secondary = _encoded_color(spec["color"]), _encoded_color(spec["secondaryColor"])
    rgb = base * (1 - mix) + secondary * mix
    weave = np.where((x + y) % 2 == 0, 1.018, .982)[..., None]
    rgba = np.ones((side, side, 4), dtype=np.float32)
    rgba[:, :, :3] = np.clip(rgb * weave, 0, 1)
    image = bpy.data.images.new(name + "_EstimatedWeave", width=side, height=side, alpha=True)
    image.colorspace_settings.name = "sRGB"
    image.pixels.foreach_set(rgba.ravel())
    image.update()
    image.file_format = "PNG"
    with tempfile.TemporaryDirectory(prefix="tadaima-estimated-weave-") as temporary:
        image.filepath_raw = str(Path(temporary) / "estimated-weave.png")
        image.save()
        body = Path(image.filepath_raw).read_bytes()
    image.filepath_raw = "//materials/" + name + "-estimated-weave.png"
    image.pack(data=body, data_len=len(body))
    image["appearanceSource"] = "photo_informed_pattern_estimate"
    image["pattern"] = spec["pattern"]
    return image


def room_design_materials(geometry, profile):
    """Return ordinary metric-UV material bindings for a validated design sidecar."""
    surfaces = profile.get("surfaces", [])
    pattern_texels = sum((1024 if spec["pattern"] == "inset_dash" else 256)**2
                         for spec in surfaces if spec["finish"] == "carpet")
    if pattern_texels > 32*1024*1024:
        raise ValueError("Estimated carpet textures exceed the 32-megapixel pattern budget")
    appearance = {"scope": "captured_room", "surfaces": [
        {**spec, "tileMeters": spec["repeatMeters"]} for spec in surfaces]}
    bindings, summary = room_materials(geometry, appearance)
    indexed = {spec["entityId"]: spec for spec in surfaces}
    for entry in summary["surfaces"]:
        spec = indexed.get(entry["entityId"])
        if spec is None:
            continue
        material, _, _ = bindings[entry["entityId"]]
        material["appearanceSource"] = "photo_informed_estimate"
        material["photoEvidenceIdsJson"] = json.dumps(spec["evidenceIds"], separators=(",", ":"))
        material["pattern"] = spec["pattern"]
        material["estimateConfidence"] = spec["confidence"]
        if spec["finish"] == "carpet":
            image = _carpet_pattern("Carpet_" + entry["entityId"], spec)
            node = material.node_tree.nodes.new("ShaderNodeTexImage")
            node.image, node.extension, node.interpolation = image, "REPEAT", "Linear"
            node.label = "Estimated dash/weave from cited room photos; not recovered textile pixels"
            shader = material.node_tree.nodes.get("Principled BSDF")
            shader.inputs["Base Color"].default_value = (1, 1, 1, 1)
            material.node_tree.links.new(node.outputs["Color"], shader.inputs["Base Color"])
            for normal in material.node_tree.nodes:
                if normal.type == "NORMAL_MAP":
                    normal.inputs["Strength"].default_value = .035
        entry.update({"color": spec["color"], "secondaryColor": spec["secondaryColor"],
                      "pattern": spec["pattern"], "confidence": spec["confidence"],
                      "appearanceSource": "photo_informed_estimate"})
    summary.update({"schemaVersion": "room-designed-surfaces/1.0", "mode": "photo_informed_clean_surfaces",
        "assumption": "Cited photos guide estimated colors, finish families and repeating patterns. Woven/dash textures are deterministic approximations, not recovered camera pixels or measured material maps; unknown surfaces retain styling defaults."})
    return bindings, summary


def _opening_material(name, color, *, metallic=0, roughness=.55, glass=False):
    material = pbr_material(name, (*linear_color(color), 1), roughness_value=roughness)
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Metallic"].default_value = metallic
    if glass:
        # Keep this portable to the viewer's allowlisted core PBR path. Camera
        # scans do not measure refraction; alpha conveys the observed glazing.
        shader.inputs["Transmission Weight"].default_value = 0
        shader.inputs["IOR"].default_value = 1.5
        shader.inputs["Alpha"].default_value = .22
        material.diffuse_color = (*linear_color(color), .22)
        if hasattr(material, "surface_render_method"):
            material.surface_render_method = "DITHERED"
    material["appearanceSource"] = "photo_informed_estimate"
    return material


def _box_child(owner, name, lower, upper, material):
    # Fixed outward-wound closed topology; all coordinates remain inside the
    # opening EMPTY's normalized envelope before its metric parent scale.
    x0,y0,z0 = lower
    x1,y1,z1 = upper
    if not all(-1 <= lo < hi <= 1 for lo,hi in zip(lower,upper)):
        raise ValueError("Opening detail must remain within the owner envelope")
    vertices = [(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0),
                (x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)]
    faces = [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)]
    mesh = bpy.data.meshes.new(owner.name + "_" + name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(mesh.name, mesh)
    collection = owner.users_collection[0] if owner.users_collection else bpy.context.scene.collection
    collection.objects.link(obj)
    obj.parent = owner
    mesh.materials.append(material)
    obj["ownerOpeningId"] = owner.get("entityId", owner.name)
    obj["componentKind"] = name
    obj["appearanceStatus"] = "photo_inferred"
    obj["representation"] = "photo_informed_opening_detail"
    if "photoEvidenceIdsJson" in material:
        obj["photoEvidenceIdsJson"] = material["photoEvidenceIdsJson"]
    return obj


def dress_opening(opening, opening_obj, thickness, profile):
    """Return bounded child meshes; caller includes children in export selection.

    The parent already encodes half width/thickness/height and the canonical
    pose. Children intentionally have no semantic role/entityId of their own.
    A door/open passage gets reveal trim only; no guessed door leaf blocks it.
    """
    if not 0 < thickness <= 10:
        raise ValueError("Opening wall thickness must be positive and bounded")
    window = opening["kind"] == "window"
    frame = _opening_material("OpeningFrame_" + opening["id"], "#aeb4b5" if window else "#ece8dc",
                              metallic=.65 if window else 0, roughness=.32 if window else .7)
    frame["estimateConfidence"] = "medium"
    specs = [spec for spec in profile.get("surfaces", []) if spec["entityId"] == opening["wallId"]]
    if specs:
        frame["photoEvidenceIdsJson"] = json.dumps(specs[0]["evidenceIds"], separators=(",", ":"))
    details = [_box_child(opening_obj,"FrameLeft",(-1,-.55,-1),(-.925,.55,1),frame),
               _box_child(opening_obj,"FrameRight",(.925,-.55,-1),(1,.55,1),frame),
               _box_child(opening_obj,"FrameTop",(-.925,-.55,.925),(.925,.55,1),frame)]
    if window:
        details.append(_box_child(opening_obj,"FrameSill",(-.925,-.55,-1),(.925,.55,-.925),frame))
        glass = _opening_material("OpeningGlass_" + opening["id"], "#7d929c", roughness=.08, glass=True)
        blind = _opening_material("OpeningRollerBlind_" + opening["id"], "#e4dfd2", roughness=.92)
        if specs:
            for material in (glass,blind):
                material["photoEvidenceIdsJson"] = json.dumps(specs[0]["evidenceIds"], separators=(",", ":"))
        details.append(_box_child(opening_obj,"WindowGlass",(-.923,-.018,-.923),(.923,.018,.923),glass))
        details.append(_box_child(opening_obj,"PartialRollerBlind",(-.91,-.43,.015),(.91,-.35,.91),blind))
        details.append(_box_child(opening_obj,"RollerBlindHeader",(-.91,-.47,.84),(.91,-.31,.915),blind))
    return details
