# RoomPlan Photos and Appearance Evidence

**Clean room rendering:** a validated `room-visual-design/1.0` sidecar can turn the measured layout and photo-informed furniture/material choices into a complete editable PBR room (`photo_informed_parametric`). Raw surface fragments remain an optional reference. See [capturing and building the original room](high-fidelity-scan.md) for the keyless Codex handoff, clean build and viewer controls.

**Detailed scans:** the scanner now defaults to RoomPlan layout followed by a shared-session LiDAR surface pass. **Share detailed scan + photos** exports bundle 1.1 with hashed `mesh.json`; photo-only mode remains bundle 1.0. See [capturing the original room](high-fidelity-scan.md). Calibration conventions below apply to both versions; statements about missing dense geometry apply only to bundle 1.0.

The iPhone companion can now collect real RGB photos while RoomPlan captures metric room geometry and existing-object size proxies. Photos are sampled from **RoomPlan's existing ARSession**. There is no second camera session, ARSession delegate replacement, provider key, photo-library permission, or automatic upload.

## Capture and Share

1. Leave **Save appearance photos** enabled before starting a room scan. Turn it off for a geometry-only scan.
2. Move slowly around the room and pause facing the floor, walls, windows and each important piece of furniture. Include multiple angles and avoid glare. Automatic capture favors changed viewpoints with normal tracking and low camera motion.
3. Use **Capture photo** for a specific view. Manual capture still requires stable tracking, a steady camera and usable exposure; it does not bypass storage limits.
4. Check the saved-photo counter, finish the scan and review the photo thumbnails. If no photos were saved, the geometry exports remain available; there is no successful-looking empty photo bundle.
5. Choose **Share detailed scan + photos** when real surface capture is enabled, or **Share scan + photos** for photo-only mode. AirDrop/save the timestamped ZIP. **Share scan JSON** and **Share USDZ** remain available as geometry-only exports.

At most 32 JPEGs are retained, with a 1600-pixel maximum image dimension, 2 MiB per image and 32 MiB total image data. Encoding runs serially away from the main actor and retains at most one camera pixel buffer. The sampler checks pose novelty, coarse camera motion and sampled luminance. These checks reduce redundant/moving/dark views; they are not a guarantee of sharpness, complete coverage, accurate color or photogrammetric quality. The first automatic photo requires two tracked samples. A full scan is still necessary for structural coverage.

Finishing drains an in-flight JPEG before allowing export. Cancellation, rescan and background interruption invalidate the capture identity so late encoding results cannot enter a different scan. Completed photos remain in memory with the processed room until rescan/app termination; sharing creates the private disk archive. Files use complete iOS file protection, private permissions and backup exclusion. Transfer completed scans before installing an update, which can terminate the app and discard its in-memory result.

## Bundle Contract

`roomplan-photo-bundle/1.0` is a separate wrapper around the unchanged `roomplan-scan/1.1` geometry packet. ZIP entries are `manifest.json`, `roomplan.json` and declared `photos/photo-<UUID>.jpg` files. The native encoder uses uncompressed ZIP STORE; JPEGs are already compressed. Every photo and the exact geometry bytes are SHA-256 bound.

Photo-only bundle 1.0 remains limited to 36 MiB. Detailed bundle 1.1 adds exactly one declared `mesh.json` member with SHA-256 and byte length. It supports a 144 MiB ZIP, 96 MiB mesh JSON, 128 anchors, 400,000 input vertices and 600,000 original triangles. Photo limits remain 32 JPEGs and 32 MiB total. Exceeding a bound rejects the detailed export/import; faces and anchors are never silently truncated or decimated.

The manifest contains:

```json
{
  "schemaVersion": "roomplan-photo-bundle/1.0",
  "projectId": "local-roomplan",
  "jobId": "scan-<UUID>",
  "inputRevision": 0,
  "coordinateSystem": "arkit-gravity-y-up-metres",
  "imageConvention": "raw-sensor-top-left",
  "scan": {"path": "roomplan.json", "sha256": "<hex>"},
  "photos": [{
    "id": "photo-<UUID>",
    "path": "photos/photo-<UUID>.jpg",
    "sha256": "<hex>",
    "byteLength": 123456,
    "width": 1600,
    "height": 1200,
    "capturedAt": "2026-10-18T12:00:00Z",
    "arTimestamp": 123.45,
    "cameraToWorld": ["16 column-major numbers"],
    "intrinsics": ["9 column-major numbers"],
    "trackingState": "normal"
  }]
}
```

The placeholders above describe the schema; they are not an importable fixture. The native exporter supplies actual numeric matrices, UUIDs, timestamps, dimensions and hashes.

Camera-to-world transforms retain the source right-handed, Y-up ARKit frame in meters. Camera axes are +X right, +Y up, looking along -Z. Images retain the raw sensor orientation, without rotation, mirroring or EXIF orientation. They may look sideways when viewed directly from a portrait scan. Intrinsics refer to the **saved JPEG dimensions**, scaled from the source camera resolution; pixel coordinates start at the center of the top-left pixel. Matrices are column-major; a standard intrinsic matrix flattens as `[fx,0,0, 0,fy,0, cx,cy,1]`. Consumers must not rotate images without applying the corresponding calibration change.

For a camera-space point in front of the camera, top-left image coordinates are `u = fx*x/(-z)+cx`, `v = cy-fy*y/(-z)`. World points must first be transformed by the inverse camera-to-world pose. The room importer separately records its floor-normalization translation; apply that translation consistently to camera and room geometry exactly once. Saved source poses are never overwritten with normalized poses.

Floor normalization is a coordinate convention, not proof of RoomPlan/raw ARKit registration. The final RoomPlan layout can require a separate rigid registration candidate before associating projected photos with individual items. Check candidate alignment against multiple views, projected extents and room structure; do not infer correct horizontal position or yaw from a shared ARSession or vertical floor translation alone. The visual-design handoff can carry a reviewed candidate as estimated context without applying or certifying it.

The packet records normal tracking at capture, not proof that all images align perfectly with the final RoomPlan model. Tracking drift, relocalization, estimated surface planes, occlusion and reflective objects can affect later projection. Photo-only bundle 1.0 does not include dense depth or a surface mesh. Detailed bundle 1.1 adds raw observed triangles, which can be textured after import. Neither version includes lighting calibration, measured reflectance or guaranteed object segmentation.

## Import and Appearance Handoff

```bash
python3 -m reconstruction.roomplan \
  --input /private/path/living-room_<timestamp>_<scan-id>.zip \
  --output /private/path/room-with-photos-001
```

Import validates the bounded ZIP, member paths, duplicate entries, hashes, identity, camera metadata and actual JPEG dimensions before accepting image evidence. It preserves the original archive, unchanged geometry JSON, full photo manifest and JPEGs privately. `photo-registration.json` records the source frame and floor-normalization translation. `appearance.photos.json` selects up to eight varied photo references for the existing appearance worker; all captured photos remain available for future projection and object crops.

Prepare the existing provider-independent appearance proposal with the imported files:

```bash
python3 -m reconstruction.appearance \
  --input /private/path/room-with-photos-001/reconstruction.request.json \
  --photos /private/path/room-with-photos-001/appearance.photos.json \
  --output /private/path/appearance-proposal.json
```

The appearance-analysis command prepares material-family evidence from the older subset of up to eight photos. For the complete clean-room flow, use the all-source visual-design handoff instead:

```bash
python3 -m reconstruction.visual_design prepare \
  --input /private/path/room-with-photos-001/reconstruction.request.json \
  --photo-bundle /private/path/room-with-photos-001/scan.input.zip \
  --output /private/path/room-with-photos-001/visual-design.request.json
```

This prepares every original image attachment, up to 32, with exact photo hashes, IDs and evidence references for local Codex inspection. No provider key is required and the command does not perform inference, call a model or upload images. Inspect the actual full source images; thumbnails/contact sheets are navigational aids. The agent writes a `room-visual-design/1.0` sidecar using the supplied output schema and exact identity/request hash. Every furniture item needs a binding, each assigned surface/item needs real cited evidence, and uncertain correspondences must be recorded. The strict profile rejects changed request identity/geometry, unknown items, bad photo hashes and unsupported style values.

Build with `python3 -m reconstruction.cli build --input <request.json> --photo-bundle <scan.input.zip> --design-profile <profile.json> --output <fresh-directory> --preview`. The profile preserves measured room geometry and furniture dimensions/poses while selecting photo-informed closed furniture parts, colors and finish patterns. Clean materials do not project people, belongings, reflections, clothing or captured shadows into the world. They are PBR estimates under unknown lighting, not recovered albedo/BRDFs or exact object meshes. Open its `scene.glb` using **Open room model** after opening the matching JSON in `/room`.

Without a design profile, a detailed bundle renders an optional raw observed-surface reference; use **Open captured room** for that GLB. Photo-only bundles project visible RGB onto the existing shell and bounding-box proxies. Those projection paths may retain source lighting or unwanted image content and do not produce the complete clean world. See [automatic photo texturing](photo-texturing.md) for their projection/occlusion mechanics and [clean room workflow](high-fidelity-scan.md) for the recommended photo-informed build.

## Verification and Sources

Synthetic protocol fixtures exercise actual Swift ZIP output through the Python importer. Camera math tests check pose changes and intrinsic scaling; importer tests check archive safety, identity binding, image dimensions and evidence preservation. Signed iOS compilation checks the real SDK and Swift 6 concurrency. These checks do not replace a fresh physical scan with saved RGB images.

Primary API references: [RoomCaptureSession.arSession](https://developer.apple.com/documentation/roomplan/roomcapturesession/arsession), [ARFrame.capturedImage](https://developer.apple.com/documentation/arkit/arframe/capturedimage), [ARCamera.intrinsics](https://developer.apple.com/documentation/arkit/arcamera/intrinsics). The installed Xcode SDK headers document full-range bi-planar YCbCr camera buffers, camera-to-world transforms, pixel calibration and image resolution.

### Initial Photo-Bundle Verification — October 18, 2026

- The signed iOS device build passed with Swift 6 strict concurrency; the updated companion was installed and launched on the paired physical iPhone 14 Pro.
- All 78 relevant Python tests passed with Blender enabled, including native photo bundle ingestion, existing RoomPlan geometry, appearance handoff and web bundle regression checks.
- Swift packet, photo-camera math and ZIP encoder executable checks passed, including malformed data and total-size rejection.
- A Swift-encoded synthetic room and two generated test JPEGs were exported as a ZIP, imported by the Python CLI, and generated an editable Blender scene and GLB. The appearance CLI successfully prepared a hash-bound analysis packet from the imported images.
- Blender independently reopened the saved scene. Three.js loaded the GLB, and Khronos validation reported zero errors, warnings, infos or hints.

The synthetic JPEGs are test patterns. The generated scene still uses the existing procedural material defaults; this integration check does not claim that those patterns were projected onto the scene. These initial protocol checks precede the later physical detailed scan and do not establish clean-room appearance quality. The physical detailed scan and expanded raw-mesh limits are recorded in [the high-fidelity scan guide](high-fidelity-scan.md).
