# Tadaima Scan: Native RoomPlan Companion

A minimal **iOS 17+ SwiftUI app** for a real RoomPlan scan on the team's iPhone 14 Pro. The app uses Apple's `RoomCaptureView`, built-in coaching and processed room preview. It shares a normalized structural JSON file for the existing reconstruction worker and optionally shares Apple's parametric USDZ. No measurements, account, provider keys, or upload service are required.

The native companion is the user-approved exception to the original web-only capture plan. The desktop/mobile shopping application remains in the main repository. This is one small capture app, not a second shopping frontend.

## Open and Run on the iPhone

1. Open [`TadaimaScan.xcodeproj`](TadaimaScan.xcodeproj) in Xcode. Select the **TadaimaScan** scheme.
2. Connect and unlock the iPhone 14 Pro. Trust the Mac, pair the device with Xcode, and enable Developer Mode on the phone if requested.
3. Under **Signing & Capabilities**, select your Apple development team. No team, certificate, provisioning profile, or Apple account is configured in this repository. Change `dev.tadaima.scan` to an available bundle identifier if your team needs a unique identifier.
4. Select the connected iPhone as the run destination, then Run. Allow the camera permission when prompted.
5. Tap **Start room scan**, move slowly around one room, and follow Apple's guidance. Capture the full wall perimeter, openings, floor edges and upper wall edges. Tap **Finish & review** after covering the room.
6. Review the built-in processed model. Name the room, then choose **Share scan JSON**. AirDrop or save `roomplan.json` for local worker import. **Share USDZ** creates a separate optional native reference model.
7. **Scan again** discards the current scan/export references and starts a fresh scan identity. Nothing is uploaded automatically.

The runtime checks `RoomCaptureSession.isSupported`. Unsupported hardware and Simulator show an explanation instead of a fake scan. Camera denial has a Settings action. An active scan, permission request, post-processing operation, or export is invalidated when the app backgrounds; late callbacks cannot replace a new scan. A completed review stays available in memory until rescan or app termination. Export errors retain the current processed scan for an explicit retry.

## JSON Bridge

The `roomplan-scan/1.0` packet contains:

- `projectId: "local-roomplan"`, a fresh safe `scan-<UUID>` job ID, revision zero, an ISO 8601 UTC capture timestamp, native room identifier and user-entered room label.
- Device information from `UIDevice.model` and `systemVersion`; `model` is a general device class such as `iPhone`, not a claim that the exact model was independently verified.
- All native **walls, doors, windows and openings** with their identifiers, dimensions in meters, confidence and native parent identifier or explicit JSON `null`.
- Sixteen transform values in **column-major order**: columns 0, 1, 2, 3. Translation occupies indices 12, 13 and 14. Native ARKit coordinates remain right-handed and Y up. No extra rotation, scaling, wall-thickness offset or scene alignment is applied by the app.
- `polygonCorners` copied unchanged in **local surface-plane coordinates**, not transformed world positions. An empty native array stays empty. `isCurved` records `surface.curve != nil`; the current importer declines curved surfaces.

The packet describes structural surfaces. It does not include floor arrays, objects/furniture, door open state, curve parameters, raw sensor frames, or a textured photogrammetry mesh. The optional native USDZ is a separate reference and is not the source for the editable Blender shell. Confidence and sensor dimensions do not establish survey accuracy or safe tight clearances.

Import from the repository root using the [RoomPlan adapter](../../roomplan):

```bash
python3 -m reconstruction.roomplan \
  --input /private/roomplan.json \
  --output reconstruction/output/roomplan-demo-001 \
  --render --preview
```

The worker remains responsible for authorization/revision checks when integrated, bounded JSON validation, closed-loop recovery, supported geometry, evidence, editable Blender output, GLB export and human review. A successful phone export does not guarantee the current importer supports the captured room. Read [native scan integration](../../../docs/native-scan.md) for supported shapes and modeling assumptions.

## Local Files and Lifecycle

Exports are written under the app's private `Documents/Scans/scan-<UUID>/` directory with complete iOS file protection, private POSIX permissions and backup exclusion. JSON is written atomically. USDZ export runs on a separate actor, and only a successful current-scan export can be shared. Rescanning invalidates stale callbacks and removes the previous scan's export directory on a best-effort basis. A file already copied through the share sheet is outside the app's control. Current files can remain in the sandbox after the app exits; uninstalling the app removes its sandbox. No shared directory or backend credentials are used.

`ScanCoordinator` bridges nonisolated SDK delegates to the main actor. Its only mutable cross-thread state is a lock-protected finalization gate. The app accepts `didPresent` only after the user requests completion and only for the current scan identity. Cancelled/error results and live interim room snapshots are not exported.

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

The pure Swift executable verifies column-major rotation/translation ordering, local polygon coordinates, explicit `null` parent IDs, the curve flag, JSON round-trip and nonfinite-value rejection. Its optional fixture is explicitly synthetic: four 4.2 × 3.5 × 2.7 m walls, a door and a window. It exercises the same encoder/transform helper for cross-language importer tests; it is not a simulated RoomPlan result or proof of physical scanning.

**Recorded October 18, 2026:** both unsigned generic Simulator and generic iOS builds passed with Xcode 27.0 / iOS 27 SDK / Swift 6 strict concurrency. Pure Swift mapping tests passed on the Mac. Unsigned compilation does not install on a phone. Physical scanning, device-specific permission recovery, real built-in preview, on-device USDZ export, signing, and share-sheet transfer require the connected LiDAR phone and remain unverified until performed.

## Primary Sources

- [Apple: Create a 3D model with RoomCaptureView](https://developer.apple.com/documentation/roomplan/create-a-3d-model-of-an-interior-room-by-guiding-the-user-through-an-ar-experience)
- [Apple: Processed-result delegate callback](https://developer.apple.com/documentation/roomplan/roomcaptureviewdelegate/captureview(didpresent:error:))
- [Apple: polygonCorners use local plane coordinates](https://developer.apple.com/documentation/roomplan/capturedroom/surface/polygoncorners)
- [Apple: RoomPlan framework](https://developer.apple.com/documentation/roomplan)
- The installed Xcode 27 SDK `RoomPlan.swiftinterface` was also inspected for real signatures, iOS availability, confidence, native parent IDs, curve detection, export options and callback isolation.
