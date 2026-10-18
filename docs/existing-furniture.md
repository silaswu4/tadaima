# Existing Furniture from Native Scans

Implemented October 18, 2026. Generator `tadaima-shell/1.3.0` preserves detected existing objects independently of walls, floors and openings. It does not claim exact object meshes, recovered textures, or merchant product identities.

## Capture and contract

The native companion exports `roomplan-scan/1.1`: the previous structural packet plus a required `objects` array. Each object carries a native UUID, category, confidence, positive local `[width,height,depth]` dimensions in meters, and the unchanged 16-number column-major object-center pose. The exporter maps Apple's supported categories explicitly, including common furniture, storage and fixed appliances. Unknown future categories stay unknown. The limit is 256 objects; overflow fails visibly rather than truncating the room inventory.

The importer continues to accept old `roomplan-scan/1.0` packets without an object field. Those files remain structural-only. New packets must supply `objects`, even when empty. Evidence and physical accuracy remain reviewable.

The importer adds optional `ReconstructionRequest.items` using the existing shared `PlacedItem` type. This bounded reconstruction input requires:

- A unique stable item ID, known room ID, label and nonempty existing `evidenceIds`.
- `origin: "existing_owned"`, `productId: null`, `assetUrl: null`. Native detections are treated as existing scene contents; ownership has not been independently verified.
- Finite `dimensions` of 0.000001–100 meters per axis; finite bottom-center `position` within ±10,000 meters; `rotationY` within ±2π radians; a boolean `locked`.
- At most 256 items. IDs must not collide with structural entity IDs. No merchant URLs, model URLs, purchases or executable instructions enter through this local import boundary.

The new optional `PlacedItem.evidenceIds` field preserves legacy fixture compatibility while allowing native dimensions and poses to retain citations. Captured-item input requires these citations even though they are optional on older application fixtures.

## Coordinate conversion

Object transforms stay in the same ARKit frame as the source walls. Only the recovered room-floor translation is applied. Native center `[tx,ty,tz]` becomes bottom-center `[tx,ty-floorY-height/2,tz]`; elevated items retain their elevation. The local X basis gives `rotationY = atan2(-m[2],m[0])`. Canonical Three.js +Y yaw maps to Blender +Z yaw under `[x,y,z] → [x,-z,y]`.

Scaled, sheared, reflected, nonfinite or invalid rigid transforms are rejected. A valid tilted object cannot be represented by the current yaw-only application type: it is explicitly omitted with its ID/reason in `omittedObjects`, while the original source remains available. Its pose is not silently flattened. Object category/confidence is recorded in the attached evidence; no capture creates a user-confirmation timestamp.

Imported objects default to `locked: true` to preserve their placement for planning. This is a data flag for future planning consumers, not proof that a live shopping/planning service is integrated.

## Blender and viewer

Blender creates one editable oriented box per item in `ExistingFurniture`, with role `existing_furniture`, dimensions, source evidence, lock state, and `sensor_proxy` metadata. Furniture remains separate from the structure and participates in bounds, camera framing, GLB export and statistics. Its neutral PBR material is a proxy, not a reconstruction of upholstery or wood grain.

The browser's **Open room file** reads the enriched request or generated `scene.json`. It validates furniture independently, creates separate proxy roots, and supports selection, dimension/source inspection, explode and return. Exploding changes display transforms only; locked canonical placement and dimensions remain intact. The UI calls these **Detected size proxies** and labels sensor uncertainty. No captured item is added to a shopping basket or assigned a product SKU.

## Recorded real scan recovery

The first physical phone capture used the older structural JSON exporter. The user subsequently AirDropped its native parametric USDZ. That archive contained 22 object cubes: 8 chair, 7 table, 5 sofa and 2 storage detections. These are model classifications requiring review, not a verified inventory of 22 distinct correctly classified furnishings.

For this one-time recovery, the archive's 12 wall UUIDs, dimensions and transforms were independently matched against the original JSON. Maximum paired wall difference was approximately `2.31e-7` across compared matrix/dimension values. The object cubes' native UUIDs, dimensions and poses were retained in a derived v1.1 packet, then processed through the normal validator, Blender generator and viewer. USDZ did not retain detection confidence, so recovered objects have `unknown` confidence. Its white parametric boxes contained no room-photo textures.

This is **not a general USDZ importer** and is not represented as a new physical v1.1 capture. Future app exports preserve object data directly and do not need this recovery step. Original exports, source hashes and the recovery report remain private local outputs, outside the repository/public directory.

The recovered scene contains 35 meshes / 620 triangles, including 22 furniture boxes. Actual Three.js loading and Khronos validation passed with zero errors, warnings, infos or hints. Blender independently reopened the file and verified transforms, dimensions, bounds, materials and apertures. Browser selection and explode/return were exercised with the actual recovered items.

## Verification

- 317 Python tests passed, including real Blender integration, furniture pose/evidence validation, native backward compatibility and mixed appearance cases. Fourteen unrelated service tests were skipped because their optional environment was unavailable.
- 63 Node tests passed, including item import, proxy transforms, explode/return, appearance and PNG decoding.
- Native Swift packet checks and an unsigned generic iOS build passed. A signed device build is prepared separately; compilation alone does not establish that a new v1.1 phone scan has been completed.
- Root lint and production build passed.

Primary API references: Apple's [detected objects](https://developer.apple.com/documentation/roomplan/capturedroom/objects) and [CapturedRoom.Object](https://developer.apple.com/documentation/roomplan/capturedroom/object). The installed Xcode SDK declarations were also checked for categories, confidence, dimensions and transform types.
