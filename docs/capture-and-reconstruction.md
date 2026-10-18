# Capture and Reconstruction

Research consolidated: October 17, 2026. This document describes the proposed pipeline and its limitations. It does not certify a working scanner, reconstruction service, or device integration in the repository.

Implementation update: the downstream [validated geometry → editable Blender → GLB stage](../reconstruction/README.md) now works locally, with [primary-source research](../reconstruction/RESEARCH.md) and actual export/loader tests. It takes supplied geometry; neither address extraction nor photo-to-geometry processing is implemented by that stage.

The current product requirement is **web only**, with two entry points: an address and unit number, or guided capture in an iPhone browser. Both must converge on a user-confirmed, dimensioned room model. Neither entry point guarantees an accurate reconstruction of an arbitrary apartment.

The earlier root `HANDOFF.md` mentions Apple's room scan. That describes an earlier concept: native Apple RoomPlan is outside the current web-only scope. Existing RoomPlan output could be an optional future import without making a native application part of the core flow.

## Shared outcome

Both entry points should produce the same structured room description:

- Room boundaries and wall dimensions in meters.
- Openings, including doors and windows, attached to the correct wall.
- Fixed obstacles such as columns, kitchen cabinets, and radiators.
- Existing movable furniture, distinguished from permanent geometry.
- Reference photographs and the evidence behind dimensions.
- A visible distinction between measured, source-provided, inferred, and user-confirmed values.

This structured description is the authority for placement and fit checks. A reconstructed mesh is a useful visual reference, but its appearance alone is insufficient evidence of dimensions. The user confirms uncertain geometry before recommendations depend on it.

For the hackathon, prioritize one shopping room with a few verified dimensions. An address may provide a whole-unit outline, but detailing and furnishing the entire unit is a later milestone. No end-to-end reconstruction benchmark has been completed on team hardware.

## Option 1: Find my apartment

### User flow

1. Enter the address and unit number, or paste an existing listing URL.
2. Search accessible property pages, floor-plan brochures, listings, and virtual tours.
3. Present candidate plans with their source and whether they match the exact unit, an apartment type, or only the building.
4. Ask the user to select the correct layout, including whether it is mirrored.
5. Extract the plan's dimensions and ask for missing measurements or photographs.
6. Show a simple editable floor-plan preview before generating the 3D scene.

The useful promise is “we will try to find your layout.” An address is an identifier for research, not a source of hidden dimensional data.

### Search and evidence policy

Prefer an exact-unit source from the property manager or an accessible listing. A building's “B2” floor plan may describe several apartments with different orientations, windows, closets, or renovations. Apartments.com distinguishes unit-level content from model-level content, which reinforces the need to preserve that distinction in our own evidence. See its [unit-level content FAQ](https://propertyhelp.apartments.com/article/1019-unit-level-content-faqs).

Use these evidence scopes or equivalent fields in the shared schema:

| Scope | Meaning | Required handling |
| --- | --- | --- |
| `exact_unit` | The source explicitly identifies the requested unit | Confirm the layout and source date with the user |
| `apartment_type` | The source identifies a reusable layout or model | Require unit match and mirror/orientation confirmation |
| `building_generic` | The source is associated with the building only | Treat as a candidate, not the user's floor plan |
| `unknown` | The source relationship is unclear | Do not use as confirmed dimensional evidence |

Preserve the source URL, access time, image or document reference, and extracted labels. Search-result snippets should lead to inspection of the underlying source; they should not become dimensional facts. Do not silently merge incompatible plans or use a photograph from one unit to validate a plan from another.

There is no verified universal address-to-floor-plan API for this project. Zillow's [rentals feed integration](https://www.zillowgroup.com/developers/api/rentals/rentals-feed-integrations/) is a publisher integration with approval and onboarding, not an instant outbound lookup service for arbitrary apartments. Do not make it a critical dependency.

### Scale and confirmation

- Explicit dimension annotations are stronger evidence than visual proportions.
- A known wall can establish scale for an undistorted, consistently scaled plan. It cannot fix perspective distortion or independently verify every room.
- Total square footage does not uniquely determine wall lengths, room proportions, or usable area.
- Listing photographs can help identify windows, finishes, and fixtures. They do not reliably establish absolute scale on their own.
- Missing, contradictory, or stale dimensions should trigger a targeted user correction, not invented precision.

When no credible plan is found, retain the address as private project metadata and offer guided capture or manual room dimensions. Do not block the whole product on successful public-property research.

## Option 2: Capture my space on iPhone web

### What the browser can realistically do

The dependable baseline is a guided camera capture using browser media APIs over HTTPS. Capture can collect photographs or video for server-side processing. It should feature-detect supported recording formats and handle camera permissions, orientation changes, interruptions, and upload retries. WebKit documents Safari's [MediaRecorder support](https://webkit.org/blog/11353/mediarecorder-api/); actual codec and device behavior must still be tested.

Ordinary camera frames are not a synchronized stream of AR camera poses, LiDAR depth, semantic walls, or tracked metric coordinates. The interface should say “capture your room” or “guided scan” and describe what is being collected. It must not imply that an animation of moving lines demonstrates a measured wall scan.

The research did not establish standard iPhone Safari WebXR immersive AR as an available baseline. A [WebKit issue](https://bugs.webkit.org/show_bug.cgi?id=309550) records the distinction between visionOS support and iPhone support. Do not generalize a Vision Pro capability to iPhone Safari.

Apple's [RoomPlan](https://developer.apple.com/augmented-reality/roomplan/) is a native framework using supported device capabilities, including LiDAR. A normal iPhone web page cannot call it as if it were a JavaScript room-scanning API. Apple's [multiroom structure workflow](https://developer.apple.com/documentation/roomplan/scanning-the-rooms-of-a-single-structure) is useful reference material for future imports, not a browser implementation plan.

### Recommended capture sequence

1. Explain that images will be uploaded and processed, then request rear-camera access.
2. Ask the user to choose one room and identify a known dimension, ideally a measured wall or opening.
3. Guide the user through overlapping views of corners, doorways, windows, and fixed obstacles. Encourage translated viewpoints; rotating in place provides limited geometric information.
4. Capture an overview plus views along each wall. Avoid rapid movement, changing exposure, mirrors, and heavy motion blur where possible.
5. Reject or request replacement for clearly blurred, dark, duplicated, or incomplete frames.
6. Upload resumably and show actual stages: uploading, processing, extracting layout, awaiting confirmation, generating scene.
7. Show the proposed floor plan with uncertain measurements marked. Ask only for corrections that materially affect the result.
8. Generate the editable shell, then enable furniture planning.

Starting with roughly 16–32 sharp, overlapping frames is an evaluation idea, not a proven capture specification or a latency promise. The correct count depends on room size, overlap, reconstruction method, and compute. Measure it before making it product copy.

If the user denies camera permission, offer file upload and manual dimensions. If a recording is interrupted, retain successfully captured material and allow continuation. The non-camera path must remain usable.

### Why an attractive reconstruction may still be wrong

Classical multi-view reconstruction has scale ambiguity unless metric information is supplied. Learned metric models estimate scale using training priors and available inputs, but prediction is not a substitute for checking the measurements that determine whether a product fits.

Blank walls, repeated textures, reflective surfaces, moving people, and low-overlap images are difficult inputs. A dense reconstruction can also bake the existing sofa into the room mesh. Moving or deleting that sofa then exposes holes or duplicated geometry. Keep the reference scan separate from the editable room shell and movable product objects.

For multiple rooms, connecting doorway views and shared coordinates matter. Independently reconstructed rooms cannot simply be arranged next to one another and labeled an accurate apartment. Whole-unit capture should follow successful single-room reconstruction and explicit alignment validation.

## Reconstruction candidates and license gates

No model or hosted provider is selected or benchmarked by this document. Evaluate candidates behind a replaceable backend adapter.

| Candidate | Useful capability | Important limitation or gate |
| --- | --- | --- |
| [MapAnything](https://github.com/facebookresearch/map-anything) | Multi-view reconstruction with geometry, camera information, and optional additional inputs; exports can support downstream scene processing | Distinguish Apache-licensed code and the `facebook/map-anything-apache` checkpoint from other checkpoint terms. Verify the exact weights and dependencies before use. Dense geometry is not a clean semantic room model. |
| [VGGT](https://github.com/facebookresearch/vggt) | Multi-view camera and geometry estimation | Original and commercial checkpoint variants have different terms. Verify the selected `VGGT-1B-Commercial` artifacts and current license; do not assume code licensing covers all weights. |
| [COLMAP](https://github.com/colmap/colmap) | Established structure-from-motion and multi-view reconstruction | Requires appropriate overlap and visual texture; scale must be established. Check dependency licenses in addition to its own code license. |
| [Plan2Scene](https://github.com/3dlg-hcvc/plan2scene) | Research pipeline combining floor plans and photographs into textured residential scenes | Requires structured inputs and multiple processing stages. It is not a turnkey address lookup or Blender integration. |
| [CubiCasa5K](https://github.com/CubiCasa/CubiCasa5k) | Floor-plan analysis research and annotated data | The reference implementation uses an old Python/PyTorch stack. Adopting it during a short hackathon adds setup risk; dataset, code, and model terms must be checked separately. |

A practical first version can use vision-assisted extraction plus explicit user dimensions to produce a procedural shell. That is sufficient to test the shopping experience while reconstruction quality improves independently.

Each candidate needs a recorded result for: exact artifact and license, input requirements, compute availability, cold-start time, processing latency, metric error against measured walls, failure behavior, and output compatibility. Until measured, these remain open questions.

## Structured geometry before Blender

Use a validated scene schema rather than asking a model to invent an unrestricted Blender script for each request. Proposed geometry concepts include:

- Room floor polygons and room relationships.
- Wall endpoints, height, and thickness.
- Openings with a parent wall, offset, width, height, and sill height where applicable.
- Door swing or clearance information when known.
- Fixed fixtures and movable objects with separate identities.
- Dimension provenance and user confirmations.

These are requirements for the canonical data model, not an already implemented API contract. Keep field names aligned with the shared architecture and schema documents when implementation begins.

Before scene generation, validate polygon closure, self-intersections, units, positive dimensions, overlapping rooms, wall/opening relationships, and contradictory adjacency. A user confirmation should not erase provenance: retain the original evidence and the correction.

Use meters consistently. The browser/glTF convention is right-handed and Y-up; Blender uses a different native up axis. Let the export/import transform handle the conversion, and test a known one-meter object rather than applying undocumented scale factors. See the [glTF coordinate and unit specification](https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/Specification.adoc#34-coordinate-system-and-units).

## Blender and asset pipeline

Run Blender on a backend worker. The phone and headset render the result; they do not run Blender.

1. Validate and persist the structured geometry revision.
2. Run a trusted deterministic scene generator with bounded inputs.
3. Create named, editable floor, wall, opening, and fixture objects.
4. Assign basic materials from confirmed or inferred visual evidence.
5. Save the source geometry and an editable `.blend` file.
6. Export an optimized GLB for web rendering.
7. Validate dimensions, object identities, loading, and placement in the shared viewer.

Blender's [Python mesh API](https://docs.blender.org/api/current/bpy.types.Mesh.html) and [pipeline capabilities](https://www.blender.org/features/pipeline/) support procedural generation. These capabilities do not establish that our own generator exists or has been tested.

Use stable IDs to connect rendered objects to room elements and products. Record export transforms, bounding dimensions, and asset provenance. Keep large intermediate reconstructions outside the source repository. Use disposable worker directories, job timeouts, and resource limits; untrusted uploads and generated geometry should not become unrestricted executable code.

Product assets need the same dimensional discipline. A real retailer model is preferable when available and permitted. A visual proxy is acceptable for the demo when explicitly labeled and sized from verified product dimensions. Never shrink a sofa to satisfy a clearance check. A visually similar proxy cannot verify cushion depth, material appearance, or exact delivery packaging.

## Rendering and spatial capability boundaries

| Surface | Baseline | Progressive enhancement | Must not be assumed |
| --- | --- | --- | --- |
| Desktop browser | Editable orbit/overview room viewer and shopping UI | Voice and richer controls | Access to a headset's room mesh |
| iPhone browser | Guided capture, uploads, touch viewer, plan editing, shopping | Supported model viewing or other tested browser capabilities | Native RoomPlan, LiDAR room semantics, standard iPhone WebXR immersive AR |
| Quest 3S browser | Shared web app, with WebXR entered after support checks | Immersive room inspection, controller selection, supported scene understanding | Universal camera access, automatic metric alignment with the cloud model, phone-equivalent capture |

[Meta's Chairs Etc. sample](https://developers.meta.com/vr/documentation/web/web-sample-chairs-etc/) is a useful reference for furniture placement and interaction. It is not proof that our full workflow works on Quest 3S.

Meta's camera documentation and older assumptions have changed over time. [Browser 40.1 release notes](https://developers.meta.com/vr/downloads/package/browser/40.1/?view=full_width) and a separate [camera permission investigation](https://developers.meta.com/vr/support/investigations/1557993751977106/) are reasons to test the actual installed browser, permissions, and device. Do not make headset camera capture a dependency of the first demo.

The shared plan stores room coordinates; each immersive device needs its own placement/alignment transform. A room appearing in two browsers does not establish shared physical anchors. Calibrate explicitly and retain a non-immersive fallback.

Apple Quick Look and USDZ can be a future single-object viewing handoff. They do not provide the full custom DOM, voice, and shopping controls inside the native viewer, nor return a semantic room scan to the web page. See [Apple's Quick Look examples](https://developer.apple.com/quick-look-gallery/) and [model-viewer's AR modes](https://modelviewer.dev/examples/augmentedreality/index.html).

Cross-browser tracking systems such as [8th Wall](https://github.com/8thwall/8thwall) and [Zappar Instant World Tracking](https://docs.zap.works/universal-ar/threejs/tracking/instant-world-tracking/) may support other interactions. Tracking an anchor does not itself recover a dimensioned semantic apartment. 8th Wall's open-source code and SLAM binary have distinct licensing considerations, and Zappar's tracking setup includes scale assumptions. Neither is selected as a critical dependency.

## Acceptance gates and fallbacks

The following are proposed checks, not completed test results:

| Gate | Evidence required | Fallback |
| --- | --- | --- |
| Exact address match | Inspectable source and user-confirmed unit/type/orientation | Guided capture or manual dimensions |
| Metric room scale | Comparison with known wall/opening measurements | Ask for the missing measurement; mark fit unverified |
| Clean editable shell | Furniture can move without tearing the room reference mesh | Procedural shell with reference photos |
| Mobile capture | Actual team iPhone records/uploads through interruption and denied permissions | Photo upload or manual room creation |
| Reconstruction | Measured accuracy and latency on available compute | Preverified demo room, clearly disclosed |
| Web asset | GLB loads at the intended scale and reasonable device performance | Simpler materials and lower-complexity assets |
| Quest session | Actual Quest 3S enters and exits XR; selection and alignment work | Desktop/mobile viewer |
| Delivery fit | Available package and access-path measurements support the conclusion | Show “delivery fit not verified” separately from room fit |

The goal is to make uncertainty correctable. It is better to request one wall measurement than to present a convincing but unsupported claim that everything fits.
