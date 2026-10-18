# Tadaima Scan: Native RoomPlan Companion

A minimal **iOS 17+ SwiftUI app** for a real RoomPlan scan on the team's iPhone 14 Pro. The app uses Apple's `RoomCaptureView`, built-in coaching and processed room preview. It records the semantic room layout, then actual observed surfaces in a second ARKit LiDAR pass with calibrated RGB photos. A timestamped ZIP preserves layout, mesh and photos together. Geometry-only RoomPlan JSON and Apple's parametric USDZ remain available. No measurements, account, provider keys, or upload service are required.

The native companion is the user-approved exception to the original web-only capture plan. The desktop/mobile shopping application remains in the main repository. This is one small capture app, not a second shopping frontend.

## Open and Run on the iPhone

1. Open [`TadaimaScan.xcodeproj`](TadaimaScan.xcodeproj) in Xcode. Select the **TadaimaScan** scheme.
2. Connect and unlock the iPhone 14 Pro. Trust the Mac, pair the device with Xcode, and enable Developer Mode on the phone if requested.
3. Under **Signing & Capabilities**, select your Apple development team. No team, certificate, provisioning profile, or Apple account is configured in this repository. Change `dev.tadaima.scan` to an available bundle identifier if your team needs a unique identifier.
4. Select the connected iPhone as the run destination, then Run. Allow the camera permission when prompted.
5. Leave **Capture real surface geometry** enabled, tap **Start room scan**, and follow Apple's guidance to cover the full wall perimeter, openings, floor edges and upper wall edges. Tap **Continue to real surfaces**. The app processes the layout, then starts the detailed camera view in the same world coordinate system.
6. Walk slowly around furniture, including visible fronts, sides and backs. Watch the surface triangle counter, pause for automatic RGB photos, or tap **Capture photo** for a specific view. Tap **Finish surfaces & review** while tracking is ready. Inspect the photo thumbnails and counts, then name the room. Choose **Share detailed scan + photos** to save/AirDrop the timestamped ZIP. **Share scan JSON** and **Share USDZ** export the parametric layout and furniture proxies only. Turning detailed surfaces off restores the single-pass **Finish & review** / **Share scan + photos** flow.
7. **Scan again** discards the current scan/export references and starts a fresh scan identity. Nothing is uploaded automatically.

The runtime checks `RoomCaptureSession.isSupported`. Unsupported hardware and Simulator show an explanation instead of a fake scan. Camera denial has a Settings action. An active scan, permission request, post-processing operation, or export is invalidated when the app backgrounds; late callbacks cannot replace a new scan. A completed review stays available in memory until rescan or app termination. Export errors retain the current processed scan for an explicit retry.

## JSON Bridge

New exports use `roomplan-scan/1.1`. The packet contains:

- `projectId: "local-roomplan"`, a fresh safe `scan-<UUID>` job ID, revision zero, an ISO 8601 UTC capture timestamp, native room identifier and room label with its capture date/time.
- Device information from `UIDevice.model` and `systemVersion`; `model` is a general device class such as `iPhone`, not a claim that the exact model was independently verified.
- All native **walls, doors, windows and openings** with their identifiers, dimensions in meters, confidence and native parent identifier or explicit JSON `null`.
- Sixteen transform values in **column-major order**: columns 0, 1, 2, 3. Translation occupies indices 12, 13 and 14. Native ARKit coordinates remain right-handed and Y up. No extra rotation, scaling, wall-thickness offset or scene alignment is applied by the app.
- `polygonCorners` copied unchanged in **local surface-plane coordinates**, not transformed world positions. An empty native array stays empty. `isCurved` records `surface.curve != nil`; the current importer declines curved surfaces.
- A required `objects` array, including when no objects are detected. Each detection contains `{id, category, dimensions, transform, confidence}`. `dimensions` are native local **width, height, depth** in meters, and `transform` is the unchanged native object-center pose in the same 16-number column-major ARKit frame. Elevated centers remain elevated; no floor snapping, dimension adjustment, or room alignment is applied in the app.
- Explicit category names: `storage`, `refrigerator`, `stove`, `bed`, `sink`, `washerDryer`, `toilet`, `bathtub`, `oven`, `dishwasher`, `table`, `sofa`, `chair`, `fireplace`, `television`, and `stairs`. An unknown future SDK category maps to `unknown`. Confidence uses `low`, `medium`, `high`, or a future-case `unknown`.
- At most **256 objects**. A larger scan fails visibly and asks for a smaller room; detections are never silently truncated. JSON encoding rejects nonfinite surface and object values.

Objects are semantic oriented size proxies for editable existing furniture and fixtures, not exact meshes, texture captures, verified retail products, or a guarantee that every object was recognized. The review screen reports both surface and object counts and labels that limitation. The geometry JSON does not include floor arrays, door open state, curve parameters, RGB frames, or a textured photogrammetry mesh. Optional RGB photos and camera calibration are carried separately in the photo ZIP, not inserted into the geometry packet. The optional native USDZ is a separate reference and is not the source for the editable Blender shell. Confidence and sensor dimensions do not establish survey accuracy or safe tight clearances.

Legacy `roomplan-scan/1.0` packets remain decodable without `objects` and retain the original structural-only encoding. Version 1.1 decoding requires the array so a missing field cannot silently turn furniture into an empty room. A scan exported by the old app has no recoverable object data in its JSON; re-export from an updated app's available processed scan or capture again. Updating/installing can discard the in-memory processed result, so transfer existing files first.

Import from the repository root using the [RoomPlan adapter](../../roomplan):

```bash
python3 -m reconstruction.roomplan \
  --input /private/roomplan.json \
  --output reconstruction/output/roomplan-demo-001 \
  --render --preview
```

The worker remains responsible for authorization/revision checks when integrated, bounded JSON validation, closed-loop recovery, supported geometry, evidence, editable Blender output, GLB export and human review. A successful phone export does not guarantee the current importer supports the captured room. Read [native scan integration](../../../docs/native-scan.md) for supported shapes and modeling assumptions.

## Local Files and Lifecycle

Exports are written under the app's private `Documents/Scans/scan-<UUID>/` directory with complete iOS file protection, private POSIX permissions and backup exclusion. The review title and exported room label include the capture date/time in the phone’s timezone at capture completion. JSON, USDZ and the photo ZIP share a filesystem-safe basename, for example `living-room_2026-10-18_03-05-41-0700_ff42b20e.json` and `.usdz`. The suffix identifies the scan when multiple captures share a timestamp. Re-sharing uses the original capture time rather than the share time; the wire `capturedAt` remains ISO 8601 UTC. The editable room-name field stays separate from the appended timestamp. Private UUID directory names and scan IDs remain unchanged. JSON is written atomically. USDZ export runs on a separate actor, and only a successful current-scan export can be shared. Rescanning invalidates stale callbacks and removes the previous scan's export directory on a best-effort basis. A file already copied through the share sheet is outside the app's control. Current files can remain in the sandbox after the app exits; uninstalling the app removes its sandbox. No shared directory or backend credentials are used.

`ScanCoordinator` bridges nonisolated SDK delegates to the main actor. Its only mutable cross-thread state is a lock-protected finalization gate. The app accepts `didPresent` only after the user requests completion and only for the current scan identity. Cancelled/error results and live interim room snapshots are not exported.

## Appearance Photos

The default capture has two sequential passes: RoomPlan first records the semantic layout, then a detailed ARKit pass records observed room and furniture surfaces. RoomPlan stops with `pauseARSession: false`; the detail preview reuses that ARSession and runs `.meshWithClassification` (or `.mesh` when classification is unsupported), with no reset and no plane flattening. The camera pose, mesh anchors and semantic room retain the original tracking coordinate system. Cancellation, backgrounding and completion pause explicitly; removing a preview view does not pause the shared session.

Walk around furniture and capture its visible sides during the detail pass. A live triangle counter reports observed geometry, not a completeness or accuracy score. Finish while tracking is normal. Finishing drains photo encoding, pauses tracking and copies the current mesh anchors to owned arrays away from the main actor. Invalid/oversized or empty meshes fail visibly, without truncation or a successful-looking detailed bundle. Repeated-index, zero-area and duplicate triangles are removed and their count is disclosed. Existing geometry-only JSON/USDZ export remains available.

Photo capture samples the existing ARSession during the detailed pass (or the RoomPlan pass when detailed surfaces are disabled), preserving camera-to-world poses and rescaled lens calibration with raw sensor-orientation JPEGs. Up to 32 images are saved, at most 1600 pixels per dimension, 2 MiB each and 32 MiB combined. Automatic selection checks normal tracking, viewpoint change, coarse motion and luminance. Manual capture bypasses viewpoint novelty, while retaining tracking, stability and storage checks. No second camera session or ARSession delegate is installed.

The primary **Share detailed scan + photos** button appears when both detailed geometry and photos were saved. If detailed geometry failed but RGB photos survived, **Share photos + layout (no detailed mesh)** exports those photos and the RoomPlan layout as a legacy version 1.0 photo ZIP. This preserves appearance evidence without claiming detailed furniture shapes. The original capture warning remains visible across JSON/USDZ or photo export retries. Turning detailed surfaces off preserves the original **Share scan + photos** mode. Finishing drains pending encoding; cancellation/rescan cannot attach late frames to a new scan. Photos remain private and are uploaded only if the user deliberately shares them elsewhere. The first phone preview is parametric and the second pass shows the camera feed. A detailed ZIP contains the actual observed scene mesh for reconstruction; the semantic furniture boxes remain separate approximations. Texture projection uses calibrated photos of visible surfaces. Hidden backs, thin legs, reflective surfaces and small details may remain missing. Mesh chunks are spatial regions, not independently segmented furniture objects; no exact-copy or complete-object claim is made. See [automatic photo texturing](../../../docs/photo-texturing.md). See [photo protocol, import, appearance handoff and limitations](../../../docs/native-photo-capture.md).

## Build and Verification

The committed Xcode project is generated deterministically without XcodeGen or package dependencies. If the source file list changes, regenerate it:

```bash
python3 reconstruction/ios/TadaimaScan/generate_project.py
```

Run these from the repository root. Use derived-data paths outside the checkout:

```bash
xcodebuild -quiet \
  -project reconstruction/ios/TadaimaScan/TadaimaScan.xcodeproj \
  -scheme TadaimaScan -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/tadaima-scan-simulator \
  CODE_SIGNING_ALLOWED=NO build

xcodebuild -quiet \
  -project reconstruction/ios/TadaimaScan/TadaimaScan.xcodeproj \
  -scheme TadaimaScan -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/tadaima-scan-device \
  CODE_SIGNING_ALLOWED=NO build

swiftc -swift-version 6 \
  reconstruction/ios/TadaimaScan/TadaimaScan/RoomPlanPacket.swift \
  reconstruction/ios/TadaimaScan/Tests/PacketMappingTests.swift \
  -o /tmp/tadaima-packet-tests

/tmp/tadaima-packet-tests
/tmp/tadaima-packet-tests --emit-fixture /tmp/synthetic-roomplan.json
```

The pure Swift executable verifies column-major rotation/translation ordering, local polygon coordinates, explicit `null` parent IDs, the curve flag, legacy JSON round-trip, required version 1.1 object data, the object-count bound, and nonfinite surface/object rejection. Its optional version 1.1 fixture is explicitly synthetic: four 4.2 × 3.5 × 2.7 m walls, a door, a window, a rotated sofa, and an elevated table. It exercises the same encoder/transform helper for cross-language importer tests; it is not a simulated RoomPlan result or proof of physical scanning.

**Recorded October 18, 2026:** both unsigned generic Simulator and generic iOS builds passed with Xcode 27.0 / iOS 27 SDK / Swift 6 strict concurrency. Pure Swift mapping tests passed on the Mac. Unsigned compilation does not install on a phone. Physical scanning, device-specific permission recovery, real built-in preview, on-device USDZ export, signing, and share-sheet transfer require the connected LiDAR phone and remain unverified until performed.

Photo-specific host checks:

```bash
swiftc -swift-version 6 \
  reconstruction/ios/TadaimaScan/TadaimaScan/ScanPhotoCapture.swift \
  reconstruction/ios/TadaimaScan/Tests/PhotoCaptureMathTests.swift \
  -o /tmp/tadaima-photo-math-tests
/tmp/tadaima-photo-math-tests

swiftc -swift-version 6 \
  reconstruction/ios/TadaimaScan/TadaimaScan/ScanPhotoPacket.swift \
  reconstruction/ios/TadaimaScan/TadaimaScan/ScanMeshPacket.swift \
  reconstruction/ios/TadaimaScan/TadaimaScan/ScanPhotoArchive.swift \
  reconstruction/ios/TadaimaScan/Tests/PhotoArchiveTests.swift \
  -o /tmp/tadaima-photo-archive-tests
/tmp/tadaima-photo-archive-tests
```

The archive executable can emit a synthetic image bundle around the packet fixture:
`/tmp/tadaima-photo-archive-tests --scan /tmp/synthetic-roomplan.json --emit-bundle /tmp/synthetic-roomplan.zip`.
Import it with the normal RoomPlan CLI to exercise Swift ZIP output through Python. These images are generated test patterns, not phone photos. A fresh physical RGB scan remains necessary to verify on-device photographic results.

## Detailed Surface Bundle

The geometry packet remains `roomplan-scan/1.1`. A detailed bundle uses `roomplan-photo-bundle/1.1`, retaining all photo-bundle 1.0 fields and adding `mesh: {path: "mesh.json", sha256, byteLength}`. A bundle without a mesh remains version 1.0 with no mesh key. Detailed ZIP STORE archives are limited to 144 MiB; legacy photo-only archives remain limited to 36 MiB.

`mesh.json` is `roomplan-mesh/1.0` with exactly `schemaVersion`, `projectId`, `jobId`, `inputRevision`, `coordinateSystem: "arkit-gravity-y-up-metres"`, `captureMethod: "arkit-scene-reconstruction"`, and `anchors`. Each anchor has a lower-case `mesh-<UUID>` ID, column-major rigid local-to-world `transform`, anchor-local meter `vertices` as Float triples, triangle `faces` as index triples, and one integer classification per triangle (0–7, unknown = 0). Original world coordinates are retained; any floor normalization must occur once in the importer for both mesh and cameras.

A recovered physical scan contained 72 anchors, 319,580 vertices and 579,341 triangles, exceeding the previous geometry cap. The current bounded envelope supports that observed room without truncating it. Limits: 128 anchors, 400,000 total vertices, 600,000 total triangles, 96 MiB mesh JSON. Buffer copying honors source offsets/strides and 16-/32-bit triangle indices, using unaligned scalar reads. Nonfinite vertices, invalid indices, duplicate triangles, non-rigid transforms and oversized data are rejected. Face classifications do not identify complete furniture instances.

Host checks:

```bash
swiftc -swift-version 6 \
  reconstruction/ios/TadaimaScan/TadaimaScan/ScanMeshPacket.swift \
  reconstruction/ios/TadaimaScan/Tests/MeshPacketTests.swift \
  -o /tmp/tadaima-mesh-tests
/tmp/tadaima-mesh-tests
```

The archive test executable accepts `--with-mesh` alongside `--scan` and `--emit-bundle` to emit a **synthetic** detailed bundle for cross-language tests. Host tests and iOS compilation do not establish physical capture quality. A fresh physical two-pass scan is required; existing RoomPlan boxes cannot recover missing surface geometry. The signed update was installed and launched on the paired iPhone 14 Pro after the previous scan was confirmed saved. Physical detailed scanning remains unverified until a new capture is imported.

## Primary Sources

- [Apple: Create a 3D model with RoomCaptureView](https://developer.apple.com/documentation/roomplan/create-a-3d-model-of-an-interior-room-by-guiding-the-user-through-an-ar-experience)
- [Apple: Processed-result delegate callback](https://developer.apple.com/documentation/roomplan/roomcaptureviewdelegate/captureview(didpresent:error:))
- [Apple: polygonCorners use local plane coordinates](https://developer.apple.com/documentation/roomplan/capturedroom/surface/polygoncorners)
- [Apple: RoomPlan framework](https://developer.apple.com/documentation/roomplan)
- [Apple: CapturedRoom objects](https://developer.apple.com/documentation/roomplan/capturedroom/objects)
- [Apple: CapturedRoom.Object](https://developer.apple.com/documentation/roomplan/capturedroom/object)
- The installed Xcode 27 SDK `RoomPlan.swiftinterface` was also inspected for real signatures, iOS availability, confidence, native parent IDs, curve detection, export options and callback isolation.

- [Apple: Reconstructed scene meshes](https://developer.apple.com/documentation/arkit/visualizing-and-interacting-with-a-reconstructed-scene)
- [Apple: Session configuration transitions](https://developer.apple.com/documentation/arkit/arsession/run(_:options:))
- [Apple: Shared RoomPlan sessions](https://developer.apple.com/documentation/roomplan/structurebuilder/capturedstructure(from:))
