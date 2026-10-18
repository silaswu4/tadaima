# Capturing the Original Room

Generator `tadaima-shell/1.5.0` preserves actual observed ARKit surfaces and projects calibrated camera photos onto them. RoomPlan remains the source for the editable layout and furniture size proxies. A scan is a reference of observed surfaces, not a complete set of reconstructed furniture objects.

## Capture

Use the native companion on a LiDAR-equipped iPhone, including iPhone 14 Pro. Transfer any previous scan before installing an update.

1. Leave **Capture real surface geometry** enabled and start the RoomPlan scan. Cover the perimeter and openings.
2. Tap **Continue to real surfaces**. The detail pass reuses the same ARSession without resetting its origin. Plane detection is disabled to avoid flattening furniture detail.
3. Move slowly around furniture and pause at different angles. Capture fronts, sides and accessible backs, including low and elevated views. Use **Capture photo** for important details. Triangle and photo counts indicate recorded data, not completeness.
4. Finish while tracking is ready. Review counts and photos, then choose **Share detailed scan + photos**. The timestamped ZIP contains layout, actual mesh and calibrated photos.

An old geometry-only scan cannot supply missing mesh or RGB. Photo-only bundles texture proxies without recovering their shape. The native preview remains a layout preview followed by the camera feed; Blender generates the textured reference after export.

## Reconstruct and View

From the repository root:

```bash
python3 -m reconstruction.roomplan --input /private/scans/room.zip --output /private/reconstructions/room-001 --render --preview --blender /path/to/Blender
```

In `/room`, choose **Open room file** with `reconstruction.request.json` (or `draft/scene.json`), then **Open captured room** with `draft/scene.glb`. Both stay local to the browser. The viewer verifies project, job, revision and the exact original or normalized request SHA-256.

The captured view hides the planning shell and furniture proxies. **Show editable layout** restores furniture selection and explode state. Mesh chunks are spatial anchors, not furniture instances, so selection/movement/explode are disabled for the reference.

- `draft/scene.blend`: original anchor-local topology, transforms and per-face ARKit classification; packed RGB textures; hidden editable RoomPlan planning meshes.
- `draft/scene.glb`: observed geometry with embedded photo textures; planning proxies excluded.
- `draft/surface-reconstruction.json`: mesh/archive hashes, area-weighted photo coverage and source photo index per original triangle (`-1` means unobserved).
- `mesh.input.json`, source archive and photos: private original data for repeatable processing.

## Geometry and Appearance

The importer validates `roomplan-photo-bundle/1.1` and `roomplan-mesh/1.0`. Legacy photo bundle 1.0 still works. Vertices are anchor-local; transforms are column-major ARKit Y-up meters. The worker applies the recorded floor translation once to cameras and anchor transforms, then converts to Blender axes. glTF exports back to Y-up meters.

The worker preserves triangle topology without smoothing, filling holes or generating substitute furniture. It scores up to three candidate photos per triangle using angle and projected resolution. Vertex projection, front-facing checks and centroid/inner-corner ray tests against the actual mesh reject unusable views. Accepted triangles receive calibrated photo UVs. Unobserved triangles retain a plain neutral material.

Photo materials export with `KHR_materials_unlit`, because camera RGB already includes room lighting and shadows. These images are not measured intrinsic albedo or calibrated material maps. Exposure changes, seams and tracking drift can remain visible.

Limits: 128 anchors, 200,000 input vertices, 300,000 triangles, 48 MiB mesh JSON and 96 MiB detailed ZIP. Photos: 32 images, 1600 pixels per dimension, 2 MiB each, 32 MiB total. Packed PNGs: at most 1024 pixels per dimension and 1 MiB per used photo. UV seams can expand GLB vertex counts; the viewer permits 900,000 exported vertices and 300,000 triangles. Invalid/oversized data fails rather than silently truncating the scan.

## Quality and Verification

This captures visible room and furniture surfaces, not a guaranteed exact copy. Thin legs, glass, mirrors, shiny finishes, small details and hidden backs can remain incomplete. Classification does not segment complete furniture instances. Independent high-fidelity furniture editing requires an additional segmentation/object reconstruction stage.

```bash
BLENDER_BIN=/path/to/Blender python3 -m unittest reconstruction.tests.test_surface_mesh reconstruction.tests.test_pipeline -v
node --experimental-strip-types --test spatial/tests/test-captured-model.mjs
node reconstruction/verify-glb.mjs /private/reconstructions/room-001/draft
```

Synthetic regressions check real Blender projection, non-box topology, transforms, floor normalization, occlusion, packed textures, unlit GLB export and reopening the portable Blender file. Host tests and iOS builds check SDK integration. A fresh physical two-pass scan is still required to establish original-room appearance quality.

Primary references: [Apple shared RoomPlan sessions](https://developer.apple.com/videos/play/wwdc2023/10192/), [reconstructed scene geometry](https://developer.apple.com/documentation/arkit/visualizing-and-interacting-with-a-reconstructed-scene), [session transitions](https://developer.apple.com/documentation/arkit/arsession/run(_:options:)), and [camera calibration](https://developer.apple.com/documentation/arkit/arcamera/intrinsics). See the [native scanner guide](../reconstruction/ios/TadaimaScan/README.md) for wire fields and native checks.
