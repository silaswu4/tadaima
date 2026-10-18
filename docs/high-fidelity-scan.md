# Capturing the Original Room

The clean room mode uses the sensor-derived RoomPlan shell, furniture dimensions and placements, then models recognizable furniture forms and finishes from actual room photographs. Its GLB declares `captureRepresentation: "photo_informed_parametric"`. It produces a complete, editable room instead of presenting fragmented photo-projected LiDAR triangles as the finished room.

The raw ARKit surface mesh remains an optional observed reference. It can expose contours and help check alignment, but missing coverage, reflections and moving people can leave holes or unwanted photo content. The clean mode does not paste people, clothing, belongings, reflections or captured shadows onto room or furniture materials. Its forms, colors and repeating patterns are estimates informed by photos; they are not exact recovered furniture meshes or measured material properties.

## Capture

Use the native companion on a LiDAR-equipped iPhone, including iPhone 14 Pro. Transfer any previous scan before installing an update.

1. Leave **Capture real surface geometry** enabled and start the RoomPlan scan. Cover the perimeter and openings.
2. Tap **Continue to real surfaces**. The detail pass reuses the same ARSession without resetting its origin. Plane detection is disabled to avoid flattening furniture detail.
3. Move slowly around furniture and pause at different angles. Capture fronts, sides and accessible backs, including low and elevated views. Use **Capture photo** for important details. Triangle and photo counts indicate recorded data, not completeness.
4. Finish while tracking is ready. Review counts and photos, then choose **Share detailed scan + photos**. The timestamped ZIP contains layout, actual mesh and calibrated photos.

An old geometry-only scan cannot supply missing mesh or RGB. Photo-only bundles texture proxies without recovering their shape. The native preview remains a layout preview followed by the camera feed; Blender generates the textured reference after export.

## Build the Clean Room

Import the original bundle into a fresh private directory without automatically rendering a raw reference:

```bash
python3 -m reconstruction.roomplan \
  --input /private/scans/room.zip \
  --output /private/reconstructions/room-001
```

Prepare the provider-independent visual analysis handoff:

```bash
python3 -m reconstruction.visual_design prepare \
  --input /private/reconstructions/room-001/reconstruction.request.json \
  --photo-bundle /private/reconstructions/room-001/scan.input.zip \
  --output /private/reconstructions/room-001/visual-design.request.json
```

`prepare` validates the source archive, original photo bytes and exact geometry/item association. It writes a private, data-only analysis request and does not run inference or upload photos. The request references **all captured original photographs**, up to 32, with their hashes, evidence IDs, original saved-resolution local attachment paths, poses and calibration. It does not substitute the older eight-photo appearance subset. A contact sheet can help navigation, but the local Codex agent must inspect every actual source image before writing a `room-visual-design/1.0` profile matching `outputSchema`.

Copy the supplied identity and `inputSha256` bindings exactly. Each item UUID must appear once for a complete structured render. Cite actual photo evidence for every assigned item or surface; use `unresolved_proxy` with low confidence when correspondence or shape is unclear. The profile selects bounded templates, part colors, fabric patterns and finish parameters. It cannot change room geometry, item dimensions/poses, ownership, locks or identities, introduce remote assets, or execute code. Surface bindings may be partial; unassigned surfaces retain their defaults. Strict validation binds the profile to the normalized request and original photo IDs, evidence IDs and SHA-256 hashes. A changed request or mismatched source fails validation.

After the photo analysis produces `visual-design.profile.json`, build the clean room:

```bash
python3 -m reconstruction.cli build \
  --input /private/reconstructions/room-001/reconstruction.request.json \
  --photo-bundle /private/reconstructions/room-001/scan.input.zip \
  --design-profile /private/reconstructions/room-001/visual-design.profile.json \
  --output /private/reconstructions/room-001/clean \
  --preview --timeout 300 --blender /path/to/Blender
```

The keyless Codex handoff requires no model-provider key. Preparing it alone does not mean the photographs were analyzed. The completed sidecar records the actual producer and cited evidence, and the generated `visual-design.json` preserves the reviewable design choices and profile/source hashes.

In `/room`, use **Open room file** for `reconstruction.request.json` (or `clean/scene.json`), then **Open room model** for `clean/scene.glb`. The viewer checks project, job, revision, exact original/normalized request bytes, semantic IDs, furniture placement and measured envelopes. Furniture remains separately selectable and can explode and return. The interface labels its modeled forms and finishes as photo-informed estimates. Clean room-model imports retain a 64 MiB embedded-resource limit; the separate detailed-reference importer permits 128 MiB.

The clean output includes:

- `clean/scene.blend`: editable room and separate designed furniture meshes with packed material images.
- `clean/scene.glb`: portable complete room with PBR materials and embedded images.
- `clean/visual-design.json` and `clean/visual-design.input.json`: generated design summary and validated profile.
- `scan.input.zip`, `scan.input.json`, `mesh.input.json` when available, and `photos/`: private source evidence retained by the importer.

## Optional Observed Reference

To generate a raw surface reference from the same source, omit `--design-profile` and choose another fresh output directory:

```bash
python3 -m reconstruction.cli build \
  --input /private/reconstructions/room-001/reconstruction.request.json \
  --photo-bundle /private/reconstructions/room-001/scan.input.zip \
  --output /private/reconstructions/room-001/reference \
  --preview --timeout 300 --blender /path/to/Blender
```

With a detailed bundle, this renders `captureRepresentation: "observed_surface_mesh"`. Use **Open captured room** for `reference/scene.glb`. The reference hides the clean/planning scene; **Show editable layout** restores it and its previous furniture selection/explode state. Anchor chunks are not furniture instances, so selecting or exploding them is disabled.

`reference/scene.blend` preserves source topology, transforms and per-face classification, with hidden editable planning meshes. `reference/surface-reconstruction.json` records mesh/archive hashes, area-weighted coverage and the source photo index for every original triangle (`-1` means unobserved). Raw fragments are evidence for comparison, not a completed furniture world.

## Geometry and Appearance

The importer validates `roomplan-photo-bundle/1.1` and `roomplan-mesh/1.0`. Legacy photo bundle 1.0 still works. Vertices are anchor-local; transforms are column-major ARKit Y-up meters. The raw-reference worker applies the recorded floor translation once to cameras and anchor transforms, then converts to Blender axes. glTF exports back to Y-up meters. This coordinate conversion does not independently register the raw ARKit mesh/cameras to the final RoomPlan layout.

RoomPlan can refine or re-express its final geometry relative to raw tracked surfaces. A reviewed rigid registration candidate between RoomPlan and raw ARKit can therefore be necessary for per-item photo association. A shared session and floor translation alone do not establish horizontal translation, yaw, matching wall locations or camera alignment. Compare projected centers/corners, structural correspondences and multiple views before relying on an association. `reconstruction.visual_design prepare --registration /private/path/candidate.json` includes a strictly read candidate as **estimated context**, rejecting any supplied identity/request/mesh bindings that disagree with the scan; it does not apply that transform or certify it. Uncertain associations stay explicit in profile confidence and notes.

In raw-reference mode, the worker preserves triangle topology without smoothing, filling holes or generating substitute furniture. It scores up to three candidate photos per triangle using angle and projected resolution. Vertex projection, front-facing checks and centroid/inner-corner ray tests against the actual mesh reject unusable views. Accepted triangles receive calibrated photo UVs. Unobserved triangles retain a plain neutral material.

Photo materials export with `KHR_materials_unlit`, because camera RGB already includes room lighting and shadows. These images are not measured intrinsic albedo or calibrated material maps. Exposure changes, seams and tracking drift can remain visible.

Raw-reference limits: 128 anchors, 400,000 input vertices, 600,000 triangles, 96 MiB mesh JSON and 144 MiB detailed ZIP. Legacy photo-only bundle 1.0 keeps its 36 MiB ZIP limit. Photos: 32 images, 1600 pixels per dimension, 2 MiB each, 32 MiB total. Packed PNGs: at most 1024 pixels per dimension and 1 MiB per used photo. UV seams can expand GLB vertex counts; the viewer permits 1,800,000 exported vertices, 600,000 triangles and a 128 MiB GLB. Invalid/oversized data fails rather than silently truncating or decimating the scan.

The detailed limits were raised after a physical iPhone scan produced 72 anchors, 319,580 vertices and 579,341 triangles. This preserves the captured surface topology instead of reducing detail to fit the earlier budget. Input limits bound processing work; they do not certify completeness or physical accuracy.

## Quality and Verification

RoomPlan dimensions and poses remain sensor estimates rather than an independently verified survey. The clean mode preserves those estimates while using closed, beveled component meshes for recognizable furniture. Material families, colors, upholstery patterns, cushion layout and unseen details are inferred from cited photos. Unknown or misclassified detections can remain unresolved; neither a sensor category nor a nearby bounding box proves visual correspondence.

The raw reference captures visible surfaces, not a guaranteed exact copy. Thin legs, glass, mirrors, shiny finishes, small details and hidden backs can remain incomplete. Classification does not segment complete furniture instances. Exact object recovery would require additional capture, registration and reconstruction beyond these bounded templates.

```bash
BLENDER_BIN=/path/to/Blender python3 -m unittest reconstruction.tests.test_design_profile reconstruction.tests.test_visual_design reconstruction.tests.test_designed_furniture reconstruction.tests.test_designed_surfaces reconstruction.tests.test_surface_mesh -v
node --experimental-strip-types --test spatial/tests/test-textured-model.mjs spatial/tests/test-captured-model.mjs
node reconstruction/verify-glb.mjs /private/reconstructions/room-001/clean
```

Synthetic regressions check real Blender projection, non-box topology, transforms, floor normalization, occlusion, packed textures, unlit GLB export and reopening the portable Blender file. Host tests and iOS builds check SDK integration. Closed-form furniture tests additionally check manifold components, positive volume, non-box geometry, exact metric envelopes and multi-material export. Compare the generated room to actual source-photo views before judging original-room appearance quality; successful import/export alone does not establish that match.

Primary references: [Apple shared RoomPlan sessions](https://developer.apple.com/videos/play/wwdc2023/10192/), [reconstructed scene geometry](https://developer.apple.com/documentation/arkit/visualizing-and-interacting-with-a-reconstructed-scene), [session transitions](https://developer.apple.com/documentation/arkit/arsession/run(_:options:)), and [camera calibration](https://developer.apple.com/documentation/arkit/arcamera/intrinsics). See the [native scanner guide](../reconstruction/ios/TadaimaScan/README.md) for wire fields and native checks.
