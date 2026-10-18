# Tadaima Scan: Native RoomPlan Companion

A minimal **iOS 17+ SwiftUI app** for a real RoomPlan scan on the team's iPhone 14 Pro. The app uses Apple's `RoomCaptureView`, built-in coaching and processed room preview. It shares normalized room surfaces and detected object proxies as JSON, optionally captures calibrated RGB photos in a single ZIP for appearance processing, and can share Apple's parametric USDZ. No measurements, account, provider keys, or upload service are required.

The native companion is the user-approved exception to the original web-only capture plan. The desktop/mobile shopping application remains in the main repository. This is one small capture app, not a second shopping frontend.

## Open and Run on the iPhone

1. Open [`TadaimaScan.xcodeproj`](TadaimaScan.xcodeproj) in Xcode. Select the **TadaimaScan** scheme.
2. Connect and unlock the iPhone 14 Pro. Trust the Mac, pair the device with Xcode, and enable Developer Mode on the phone if requested.
3. Under **Signing & Capabilities**, select your Apple development team. No team, certificate, provisioning profile, or Apple account is configured in this repository. Change `dev.tadaima.scan` to an available bundle identifier if your team needs a unique identifier.
4. Select the connected iPhone as the run destination, then Run. Allow the camera permission when prompted.
5. Leave **Save appearance photos** enabled, tap **Start room scan**, move slowly around one room, and follow Apple's guidance. Capture the full wall perimeter, openings, floor edges and upper wall edges. Include existing furniture from several visible angles. Pause briefly for automatic RGB photos, or tap **Capture photo** for a specific view. Tap **Finish & review** after covering the room.
6. Inspect the model and photo thumbnails, then name the room. Choose **Share scan + photos** to AirDrop/save one timestamped ZIP containing geometry, JPEGs and camera calibration. **Share scan JSON** and **Share USDZ** remain geometry-only options.
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

Photo capture samples the existing RoomPlan ARSession, preserving camera-to-world poses and rescaled lens calibration with raw sensor-orientation JPEGs. Up to 32 images are saved, at most 1600 pixels per dimension, 2 MiB each and 32 MiB combined. Automatic selection checks normal tracking, viewpoint change, coarse motion and luminance. Manual capture bypasses viewpoint novelty, while retaining tracking, stability and storage checks. No second camera session or ARSession delegate is installed.

The primary **Share scan + photos** button appears only when photos were saved. Finishing drains pending encoding; cancellation/rescan cannot attach late frames to a new scan. Photos remain private and are uploaded only if the user deliberately shares them elsewhere. Capturing RGB does not itself bake textures or recover exact furniture meshes. See [photo protocol, import, appearance handoff and limitations](../../../docs/native-photo-capture.md).

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
  reconstruction/ios/TadaimaScan/TadaimaScan/ScanPhotoArchive.swift \
  reconstruction/ios/TadaimaScan/Tests/PhotoArchiveTests.swift \
  -o /tmp/tadaima-photo-archive-tests
/tmp/tadaima-photo-archive-tests
```

The archive executable can emit a synthetic image bundle around the packet fixture:
`/tmp/tadaima-photo-archive-tests --scan /tmp/synthetic-roomplan.json --emit-bundle /tmp/synthetic-roomplan.zip`.
Import it with the normal RoomPlan CLI to exercise Swift ZIP output through Python. These images are generated test patterns, not phone photos. A fresh physical RGB scan remains necessary to verify on-device photographic results.

## Primary Sources

- [Apple: Create a 3D model with RoomCaptureView](https://developer.apple.com/documentation/roomplan/create-a-3d-model-of-an-interior-room-by-guiding-the-user-through-an-ar-experience)
- [Apple: Processed-result delegate callback](https://developer.apple.com/documentation/roomplan/roomcaptureviewdelegate/captureview(didpresent:error:))
- [Apple: polygonCorners use local plane coordinates](https://developer.apple.com/documentation/roomplan/capturedroom/surface/polygoncorners)
- [Apple: RoomPlan framework](https://developer.apple.com/documentation/roomplan)
- [Apple: CapturedRoom objects](https://developer.apple.com/documentation/roomplan/capturedroom/objects)
- [Apple: CapturedRoom.Object](https://developer.apple.com/documentation/roomplan/capturedroom/object)
- The installed Xcode 27 SDK `RoomPlan.swiftinterface` was also inspected for real signatures, iOS availability, confidence, native parent IDs, curve detection, export options and callback isolation.
