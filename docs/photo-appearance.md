# Photo-derived finishes and window daylight

Implemented October 18, 2026. Generator `tadaima-shell/1.2.0`, render profile `pbr-window-daylight-v2`.

## What changes

A validated reconstruction request and its actual room photographs can now produce a separate, reviewable appearance estimate. It binds finishes to existing room-floor and wall IDs without changing any geometry, dimensions, door/window positions, or furniture. The same optional `RoomAppearance` contract is consumed by Blender and the browser workspace.

The current public living-room reference visibly has warm taupe paint and muted dark wood-look planks. Codex inspected the downloaded JPEG, verified its SHA-256, and prepared the reference profile. This is a **building gallery photograph, not a verified photograph of unit 314**. The default `/room` presentation applies those finishes to sample geometry/furniture. The **Photo reference finishes** toggle compares them with the earlier styling defaults. The reference photograph is linked in the UI.

Use **Open room file** to select an enriched `reconstruction.request.json` or generated `scene.json`. It stays local in the browser, accepts up to 2 MiB, and renders the supplied geometry and optional appearance. Imported files contain no furniture; the existing nine-piece collection remains a separate demo. The browser checks bounded structure, finite geometry, polygons, opening bounds, citations and finish values; it does not repeat every Python topology check or verify source photo bytes that are absent from the JSON. No hosted job/upload integration has been added.

## Appearance contract

`backend/contracts.ts` defines optional `RoomPlan.appearance`; `reconstruction/contracts.ts` accepts the identical optional field. Old inputs remain valid. When present, the profile requires:

- `schemaVersion: "room-appearance/1.0"`, `reviewRequired: true`.
- `scope`: `captured_room`, `exact_unit`, `building_reference`, or `unknown`. Source attribution is an upstream assertion, not physical verification.
- `sources`: at most eight existing evidence IDs and actual photo SHA-256 hashes. Every listed source must be cited by a surface.
- `surfaces`: unique room IDs for floors or wall IDs, `finish` (`wood`, `paint`, `tile`, `carpet`), sRGB `color`, roughness 0.04–1, texture repeat 0.1–10 meters, UV rotation −360–360 degrees, visual confidence and photo evidence IDs.
- `notes`: uncertainties and omitted surfaces. Surfaces omitted from the estimate retain explicit styling defaults.

Wood uses the existing licensed oak albedo/roughness/normal maps with a linear-space tint; its color is a multiplier over that proxy, not an absolute recovered albedo. Paint/tile/carpet use plain colors and subtle proxy micro-normals; no tile grout, carpet fibers, original flooring texture, SKU or paint brand is claimed. The Blender worker bakes tint/roughness into packed PNGs so GLB viewers do not need Blender-specific shader nodes. UV scale/rotation is applied to mesh UVs. Images remain portable inside `.blend` and `.glb`.

A wall binding currently styles the complete wall mesh, including both faces. Do not assign an observed interior finish to a shared wall if the unseen opposite face requires independent treatment. Per-face finishes, ceilings, trim, glazing and blinds remain outside this shell implementation.

## Local and hosted analysis

`reconstruction/appearance.py` accepts 1–8 JPEG/PNG attachments, each at most 8 MiB and at most 32 MiB together. It verifies actual bytes against supplied hashes before sending them to a provider, independently validates the finish proposal, and derives scope from the cited photos. A model cannot upgrade building-reference photos to exact-unit evidence. Geometry and source scopes never come from the finish proposal.

Both address and capture pipelines accept optional `appearance_provider` / `appearance_file`. Their CLIs expose `--infer-appearance` / `--appearance-file`; no analysis call happens unless explicitly selected. Geometry must exist first. Missing photos or empty surface proposals remain reviewable. Address selection excludes floor plans, unsupported media, conflicting/different-layout assignments, and duplicate image bytes. Capture uses private photo evidence from its validated bundle.

For an existing request, put a private `photos.json` beside its image directory:

```json
{
  "photos": [{
    "id": "photo-a",
    "evidenceId": "existing-photo-evidence-id",
    "sha256": "64-lowercase-hex-characters",
    "mediaType": "image/jpeg",
    "scope": "captured_room",
    "path": "photos/photo-a.jpg"
  }]
}
```

`evidenceId` must already identify that photograph in the request evidence. Paths must stay inside the manifest directory, including resolved symlinks. Use fresh output filenames:

```bash
# Prepare a no-key packet for Codex to inspect alongside the actual photographs.
python3 -m reconstruction.appearance \
  --input private/job/reconstruction.request.json \
  --photos private/job/photos.json \
  --output private/job/appearance.inference.request.json

# Apply a data-only, hash-bound handoff after inspecting those actual photos.
python3 -m reconstruction.appearance \
  --input private/job/reconstruction.request.json \
  --photos private/job/photos.json \
  --proposal-file private/job/appearance.handoff.json \
  --output private/job/appearance.request.json

python3 -m reconstruction.cli build \
  --input private/job/appearance.request.json \
  --output private/job/appearance-draft --preview
```

The handoff envelope is `{schemaVersion:"appearance-handoff/1.0", producer, projectId, jobId, inputRevision, inputSha256, photoSha256, proposal}`. Copy identity/hash values from the prepared packet; `proposal` contains only `surfaces` and `notes` matching its output schema. `inputSha256` hashes sorted compact UTF-8 normalized request JSON, including any existing appearance. All photo IDs and hashes must match the attachments. Do not hash pretty-printed source bytes or copy the render manifest's differently encoded input hash.

A fresh address run creates new evidence timestamps, so prewritten appearance handoffs should be applied to the **saved request** through the standalone command. Explicit pipeline inference writes an appearance inference packet and the validated geometry request before calling the provider; failed/stale handoffs leave those inputs available for recovery.

For hosted inference, supply `--model <vision-capable-model>` instead of `--proposal-file` and set `OPENAI_API_KEY`. The existing Responses adapter sends actual image bytes with a strict schema. Hosted model quality and paid API execution have not been tested with credentials for this change; the tested live evidence path used Codex visual inspection and the same file validation/rendering boundary.

## Window-driven lighting

Blender derives aperture centers, widths, heights and inward normals from canonical `kind:"window"` openings and their walls. Polygon probes at each opening classify exterior versus shared-partition windows, including reversed endpoints and concave rooms. The area emitter sits just beyond the exterior wall face, faces inward, and matches the opening dimensions. Energy scales with aperture area as a presentation policy. Up to 12 windows are selected by descending area and stable ID. Ordinary doors are excluded; glass doors require a future explicit glazing classification rather than assuming every doorway emits daylight.

This replaces the fixed diagonal sun with soft cloudy window daylight. The saved Cycles scene includes indirect bounces, a subdued packed environment, and editable rectangular sources. The manifest records window IDs, source positions, direction, size, omitted/interior/unclassified IDs and fallback mode. A room with no established exterior windows uses an explicitly labeled studio fallback.

The browser uses window-sized `RectAreaLight` sources (up to eight desktop/four mobile) and a dominant-window-aligned directional shadow approximation. Three.js rectangular area lights do not cast shadows; the proxy supplies a plausible downward angle rather than a recovered sun direction. Real-time lights can leak across partitions and do not reproduce Cycles indirect illumination. See the [official Three.js light documentation](https://threejs.org/docs/pages/RectAreaLight.html). Renderer, environment and exposure differences also mean the web preview and Cycles render are not pixel-identical.

Compass heading, sun position/time, weather, glazing transmission, exposure and measured illuminance are unknown. Uncalibrated photos do not establish exact material reflectance. The saved scene is a cutaway with no ceiling; its lighting is a useful visual approximation rather than an illumination simulation of a closed apartment.

## Verification

- 306 Python tests passed with Blender enabled, including three existing export/reopen cases, a mixed-finish case, hash/scope/revision checks and daylight orientation cases.
- 33 Node tests passed: appearance/import/window geometry, explode behavior and PNG decoding.
- Root lint and production build passed during implementation.
- The photo-reference fixture exports five meshes / 144 triangles, four packed 1024² PNG maps, and a 5,885,228-byte GLB. Reopened Blender verifies camera fit, packed maps, aperture preservation, emitter position/size/orientation and UVs. Khronos validation reports zero errors/warnings/infos/hints.
- Tinted oak pixels were independently checked against linear-space multiplication to within half an 8-bit quantization step.
- The public unit-314 candidate still has **no verified window openings**. Its optional tentative living-floor estimate does not manufacture windows or extend finishes to unobserved rooms. Use current room photos or a scan to establish that geometry before claiming window-grounded lighting for the actual unit.

The reproducible [`photo-reference.request.json`](../reconstruction/fixtures/photo-reference.request.json) combines inspected gallery finishes with explicitly synthetic geometry; it contains citations, not the third-party image bytes.
