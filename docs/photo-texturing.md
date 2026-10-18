# Automatic Captured-Photo Texturing

Generator `tadaima-shell/1.4.0` automatically projects calibrated scan photos onto the visible floors, walls and existing furniture proxies when rendering a native scan+photos ZIP. It uses actual captured RGB pixels without a model key or generated replacement imagery. Geometry, object IDs, sensor dimensions, placement, openings and editability remain unchanged.

## Use

Capture a new room with **Save appearance photos** enabled, pause at several viewpoints, then choose **Share scan + photos**. The old geometry-only scan cannot supply missing room photographs.

```bash
python3 -m reconstruction.roomplan \
  --input /private/path/room_<timestamp>_<scan-id>.zip \
  --output /private/path/textured-room-001 \
  --render --preview --blender /path/to/Blender
```

Photo projection runs automatically for this ZIP render path, with a 300-second Blender timeout. JSON-only inputs retain the previous material behavior. Importing without `--render` retains the photos and prepares the request; it does not launch Blender. The phone's native RoomPlan preview stays parametric; texturing happens in the reconstruction worker after export.

For another render of the unchanged imported geometry:

```bash
python3 -m reconstruction.cli build \
  --input /private/path/textured-room-001/reconstruction.request.json \
  --photo-bundle /private/path/textured-room-001/scan.input.zip \
  --output /private/path/textured-room-rerender-001 \
  --timeout 300 --preview
```

Open `/room`, choose **Open room file** for `reconstruction.request.json` or `scene.json`, then **Open textured model** for its generated `scene.glb`. Both files stay local to the browser. The GLB carries embedded textures and separate semantic furniture nodes, so selection and explode/return preserve the captured appearance. The viewer checks project/revision, semantic IDs, geometry bounds and transforms; it does not treat filenames as proof that two files match.

## Projection and Visibility

The original ZIP is validated again before rendering. Project/job/revision, canonical geometry, existing items and original SHA-bound photo evidence must match the request. A changed room or moved item requires a deliberate new registration path; the worker declines to reuse old camera poses automatically. Appearance estimates may change without changing geometry. A private staged sidecar binds the exact normalized `scene.json` SHA to the original source archive SHA and photo bytes. It is not a new public room schema.

The baker applies the recorded floor translation once to each native camera pose, then maps canonical `[x,y,z]` to Blender `[x,-z,y]`. It preserves raw sensor image orientation and uses the saved image's scaled intrinsic matrix. For a camera-space point in front of the camera, `u = fx*x/(-z)+cx` and `v = cy-fy*y/(-z)`.

Each mesh receives unique per-polygon UV islands. For each calibrated photograph, the worker rasterizes a scene-wide depth buffer including all room/furniture meshes, even walls hidden later for the preview cutaway. It rejects behind-camera, out-of-frame, back-facing, grazing and occluded samples. Near-camera triangles are clipped before depth rasterization. Among usable photos, projected resolution and face angle select the best source for each atlas texel. Bilinear sampling transfers real RGB pixels; it does not synthesize unseen detail.

Unobserved texels retain a plain material-color fallback. There is no claim of full coverage. Proxy-based depth testing cannot identify an occluder missing from the scan, or correct tracking drift, wrong furniture extents or inaccurate surface planes. Seams and misplaced details remain possible. No dense captured-depth alignment, segmentation, photogrammetric furniture mesh recovery, exposure matching or intrinsic-image de-lighting is implemented.

## Portable Artifacts and Coverage

- `scene.blend`: separate editable meshes, packed observed-color atlases and the existing preview lighting rig.
- `scene.glb`: embedded PNG base-color maps, stable entity metadata and independently selectable furniture. The viewer needs no private source file paths or texture server.
- `photo-textures/photo-atlas-*.png`: private generated atlases for inspection.
- `photo-texturing.json`: revision-bound report with source archive SHA, per-entity/per-face coverage, source photo/evidence IDs and atlas hashes. The main manifest includes the same summary and hashes this report.

The baker caps each atlas at 1024 pixels per side and all atlases at eight million texels. It processes one source photo at a time, using a depth-buffer maximum side of 640 pixels. The native input limits remain 32 photos, 1600 pixels per dimension, 2 MiB each and 32 MiB total. These bounds limit work and memory; texture detail is approximate and varies with mesh subdivision and viewpoint coverage.

Photo materials use a portable Principled base-color image with neutral roughness and no procedural normal map. The saved RGB already contains the room's original illumination and shadows. Adding Blender/browser lighting can therefore shade the image again; these maps are captured appearance, not measured albedo, roughness, normal maps or physically calibrated illumination. Furniture remains a detected size proxy with observed appearance on visible sides; its shape does not become an exact copy of the object.

Object metadata includes `appearanceStatus: photo_projected` when any texels were observed, `unobserved` otherwise, a numeric `photoTextureCoverage` and `photoEvidenceIdsJson`. Report statuses distinguish covered, partial and unobserved entities. Coverage includes all mesh faces, including exterior wall faces and furniture undersides that a normal indoor scan may never see. It is not a scan-quality score or a guarantee of visual correctness.

## Verification

```bash
BLENDER_BIN=/path/to/Blender python3 -m unittest \
  reconstruction.tests.test_photo_texturing_blender \
  reconstruction.tests.test_texture_source -v

node --experimental-strip-types --test spatial/tests/test-textured-model.mjs
```

The actual Blender regression renders synthetic calibrated JPEGs, projects them onto floor/wall/furniture targets and checks image orientation, midtone RGB preservation through PNG save/reload, floor normalization, hidden-mesh occlusion, multiple views, fallback surfaces, exact topology/transform preservation, packed images and embedded GLB resources. Boundary tests reject stale geometry/items, missing evidence and altered source bytes. Browser tests cover resource limits, project/revision and geometry binding, and textured furniture explode/return. These are synthetic checks; real phone-image quality and registration require a new photo-enabled scan.

Relevant primary APIs: [Apple camera calibration](https://developer.apple.com/documentation/arkit/arcamera/intrinsics), [Blender image data](https://docs.blender.org/api/current/bpy.types.Image.html), and [Blender glTF material export](https://docs.blender.org/manual/en/latest/addons/import_export/scene_gltf2.html). See [native photo capture](native-photo-capture.md) for source-image conventions and [native scan](native-scan.md) for RoomPlan geometry assumptions.
