# Native Room Scanning Companion

Decision: October 18, 2026. The user approved a lightweight native scanning companion after confirming an **iPhone 14 Pro**. This supersedes the earlier web-only capture restriction for this optional input. Design, shopping, desktop/mobile viewing and Quest remain web experiences. Address research and photo-only web capture remain available; no tape measurement is required.

## First milestone

Scan one room on the iPhone, inspect RoomPlan's preview, share a structured JSON export, and import it into the existing editable Blender/GLB worker. The initial bridge is local file transfer. It is not an authenticated cloud upload, paired web session or hosted job service.

The native source/project lives under [`reconstruction/ios/TadaimaScan/`](../reconstruction/ios/TadaimaScan/); the Python importer lives under [`reconstruction/roomplan/`](../reconstruction/roomplan/). This keeps the companion within the project lead's reconstruction area, with no new Next.js application or changes to Matthew's backend contracts.

## Why RoomPlan

Apple's native [RoomPlan framework](https://developer.apple.com/augmented-reality/roomplan/) combines camera/LiDAR observations with learned models, provides live scan guidance, and produces semantic room surfaces and object estimates. The [iPhone 14 Pro specifications](https://support.apple.com/en-us/111849) list a LiDAR Scanner. The app checks `RoomCaptureSession.isSupported` at runtime rather than relying solely on model names.

A Safari camera page cannot invoke this native framework as a browser API. The optional companion handles capture; the web product handles the remaining experience. The existing [photo-only web flow](../reconstruction/capture/README.md) estimates a room visually and remains useful on devices without LiDAR.

## User flow

1. Install the companion through Xcode on the demo phone.
2. Name the room and start scanning. Grant camera access when requested.
3. Walk around the room using RoomPlan's built-in guidance; include corners, walls, doors and windows.
4. Finish the scan and inspect the resulting room preview.
5. With **Save appearance photos** enabled, pause facing walls, floors and furniture during capture. Review the saved-photo counter/thumbnails, then choose **Share scan + photos** to transfer one timestamped ZIP containing geometry, JPEGs and camera calibration. Geometry-only JSON and optional reference USDZ remain available.
6. Import and validate the JSON, then generate the editable Blender scene and GLB.
7. Review the modeled room before relying on furniture clearances. Production upload and viewer handoff are separate integration work.

No user-entered room measurements or AI provider keys are required for this path. RoomPlan's sensor/model estimates still need review; they are not a survey certificate.

## Export contract

The companion now writes `roomplan-scan/1.1` (with legacy `1.0` import support), a deliberately small normalized packet rather than relying on Apple's internal Codable representation:

- `projectId`, `jobId`, `inputRevision`: local demo identity; not authorization.
- `capturedAt`, `roomId`, `roomLabel` and `device: {model, systemVersion}`.
- `surfaces`: walls, doors, windows and generic openings. Each retains its native identifier, category, dimensions, transform, confidence, optional parent ID, local polygon corners and `isCurved` flag.
- `objects`: native object identifiers, categories, confidence, dimensions and unchanged object-center transforms; exported separately from structural surfaces.
- Dimensions are meters. `transform` is a **16-number column-major matrix**, preserving the ARKit right-handed Y-up frame. Translation occupies indices 12–14.
- Surface local X represents horizontal width, local Y height, and local Z the plane normal under the supported importer convention. `polygonCorners` stay in local surface coordinates; they must not be transformed twice.

Apple describes [dimensions](https://developer.apple.com/documentation/roomplan/capturedroom/surface/dimensions) as a bounding box, [transform](https://developer.apple.com/documentation/roomplan/capturedroom/surface/transform) as scene position/orientation, [polygonCorners](https://developer.apple.com/documentation/roomplan/capturedroom/surface/polygoncorners) as local plane coordinates, and [parentIdentifier](https://developer.apple.com/documentation/roomplan/capturedroom/surface/parentidentifier) as the containing surface—for example a window's wall.

The packet avoids device serial numbers, account identifiers, location coordinates and provider secrets. Room geometry is private spatial information; production storage/upload permissions still need implementation.

## Conversion policy and limits

The worker consumes the packet as untrusted data: bounded JSON, exact fields, safe IDs, finite dimensions, valid rigid transforms, supported surface geometry and consistent capture identity. It produces the existing `ReconstructionRequest`; it does not create a parallel application room type.

The first importer supports **one closed room on a flat floor**. It recovers a connected wall loop, checks bounded joins, attaches openings to their declared parent wall or an unambiguous geometric match, and validates the resulting room with the existing shell validator. It rejects unsupported curved/sloped/nonrectangular surfaces, ambiguous openings and incomplete/branched layouts rather than inventing a bounding-box apartment. Small geometry adjustments are recorded for review.

RoomPlan does **not** supply verified wall thickness or interior/exterior classification. An [Apple DTS explanation](https://developer.apple.com/forums/thread/837547) explicitly calls these estimated planar surfaces and cautions against assuming that classification is available. The importer's outward extrusion and default 0.12 m thickness are modeling conventions, not additional sensor measurements. Preserve this distinction in evidence, manifests and furniture-fit claims.

Source dimensions retain sensor-source provenance and RoomPlan confidence. Inferred thickness, joins, floor normalization and interpretation remain explicit. No scan automatically creates a user confirmation timestamp. A successful import is a reviewable draft.

Detected existing furniture is preserved as separate evidence-linked, locked size proxies in the viewer, Blender and GLB. It is not promoted to a catalog product or fused into structural meshes. Exact furniture shape and textures are not recovered. See [existing furniture](existing-furniture.md).

## Running and handing off

Use the native [README](../reconstruction/ios/TadaimaScan/README.md) for project opening, build and signing instructions, and the importer [README](../reconstruction/roomplan/README.md) for validation/render commands. Typical import:

```bash
export BLENDER_BIN="/Applications/Blender.app/Contents/MacOS/Blender"
python3 -m reconstruction.roomplan \
  --input /private/path/roomplan-scan.json \
  --output reconstruction/output/roomplan-demo-001 \
  --render --preview
```

A fresh output directory is required. Keep captures, previews and generated artifacts outside Git and public assets. The backend must replace local demo identities with authorized project/job/revision bindings before hosted ingestion.

## Recorded local verification

October 18, 2026:

- Xcode 27 compiled the app for generic iOS device and iOS Simulator with signing disabled, using Swift 6 strict concurrency and an iOS 17 minimum target.
- **275 Python tests passed** with Blender enabled, including 30 native importer tests.
- Executed Swift packet checks passed for column-major transforms, explicit null parents, local polygon corners, JSON round-trip, curved flags and rejection of nonfinite values.
- The Swift exporter emitted an explicitly synthetic four-wall room with a door and window. The actual Python importer accepted those bytes and generated an editable Blender 4.5.14 LTS scene and GLB.
- The GLB loaded through the actual Three.js loader and passed Khronos validation with zero errors or warnings. Blender independently reopened the saved scene and checked its editable entities, metric units, manifold meshes and aperture gaps.

These are compile and protocol/geometry checks, not a live RoomPlan capture or an accuracy benchmark. The available iPhone 14 Pro was disconnected during verification.

## Verification boundaries

Compilation can run locally with Xcode; it does not establish successful physical scanning. Simulator or unsupported-device screens must not pretend to be LiDAR captures. Synthetic transform fixtures can verify coordinate conversion, aperture placement and Blender editability, but cannot establish real-room accuracy.

Required device check: run on the iPhone 14 Pro, complete a real scan, export its JSON, import it, inspect the resulting model against the physical room, and exercise permission denial, cancellation, rescan and background interruption. The user may need to configure their Xcode signing team and trust the development build. A directly installed development build can be tested on an owned device through Xcode ([Apple setup](https://developer.apple.com/get-started/)); App Store release is not part of the first milestone.

## Subsequent physical-device verification

The user completed a real iPhone scan and shared its JSON and parametric USDZ. The structural JSON successfully generated the editable room and GLB. The paired USDZ allowed one-time recovery of 22 existing-object size proxies after all 12 structural wall UUIDs/transforms were matched to the JSON. This verifies the physical capture-to-reconstruction path and object recovery, not surveyed dimensional accuracy or exact textured furniture reconstruction. The new direct v1.1 object export has compile/protocol checks; a fresh v1.1 physical export remains a separate device test. Private exports and artifacts remain outside Git.

## Scan naming

The native review title, exported room label, and shared JSON/USDZ filenames now include the capture date/time. Filenames use the capture timezone’s numeric UTC offset and an eight-character scan-ID suffix, for example `living-room_2026-10-18_03-05-41-0700_ff42b20e.json`. The paired USDZ uses the same basename. Re-sharing a scan preserves its original capture time; `capturedAt` remains UTC in the packet. User-entered room names are sanitized only for filenames, and the underlying UUID job identity/private directory remains unchanged.

## RGB appearance capture

The optional photo path is now implemented in the companion and local importer. It saves bounded RGB keyframes from RoomPlan's ARSession, retains their native camera poses and scaled intrinsics, and exports a hash-bound `roomplan-photo-bundle/1.0` ZIP. The importer preserves all photo evidence and prepares up to eight images for the existing appearance pipeline. Capturing/importing photos does not automatically texture the Blender scene or reconstruct exact furniture meshes. See [the complete photo capture contract and verification boundaries](native-photo-capture.md).
