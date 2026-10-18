# Spatial frontend · Silas

Owner: **Silas**. Build the browser-based 3D viewer and Quest 3S interaction layer. This is a frontend role; it does not own reconstruction or retailer research.

## What is here

There are two RoomPlan renderers in this folder for now: the pencil-style plan viewer at `/spatial` (selection, placement previews, revisions, Quest) and the PBR furniture workspace at `/room` (explode, lighting, photo finishes). Both take the shared `RoomPlan` and stable item IDs. Folding them into one renderer is an open decision between Silas and Stephen.

| File | What it does |
| --- | --- |
| [`components/RoomViewer.tsx`](components/RoomViewer.tsx) | The plan viewer to import. Renders a `RoomPlan`, controlled selection, drag and keyboard placement previews, size card and dimension labels, headset entry. |
| [`components/RoomInventory.tsx`](components/RoomInventory.tsx) | `RoomInventory`, the same pieces as an accessible list, and `PlanIssues`, the geometry and evidence gaps. Neither needs the canvas or hover. |
| [`components/ViewerLab.tsx`](components/ViewerLab.tsx) | Development bench at `/spatial`. Stands in for the product screens and the backend so the whole flow can be tried. |
| [`room/viewer.ts`](room/viewer.ts) | The three.js engine behind `RoomViewer`: plan to scene, picking, cutaway walls, revision ghosts, WebXR session, controller selection, floor alignment. Lazy loaded. |
| [`room/plan.ts`](room/plan.ts) | Pure helpers with no three.js: `validatePlan`, `diffPlans`, `dimensionSource`, footprint and polygon math. |
| [`room/benchmark.ts`](room/benchmark.ts) | Fetch, parse, triangle, texture and scale checks for GLB files. |
| [`room/pencil.ts`](room/pencil.ts), [`room/labels.ts`](room/labels.ts) | Pencil drawing materials, and canvas text for panels inside the headset. |
| [`fixtures/demoRoom.ts`](fixtures/demoRoom.ts) | Synthetic two-revision `RoomPlan`. Interim, until `backend/` publishes the shared fixture. |
| [`components/FurnitureWorkspace.tsx`](components/FurnitureWorkspace.tsx) | Responsive furniture workspace at `/room`, with explode/return, camera reset, selectable inventory, loading/error states, and model dimensions. See [Furniture explode workspace](#furniture-explode-workspace). |
| [`room/workspace-scene.ts`](room/workspace-scene.ts) | Lazy Three.js cutaway renderer for `/room`: GLB loading with Meshopt, orbit/pan/zoom, raycast selection, camera framing, reduced motion, GPU cleanup. `createFurnitureWorkspace(canvas, callbacks, options)` accepts an optional `RoomPlan` and snapshots it. |
| [`room/lighting.ts`](room/lighting.ts), [`room/window-daylight.ts`](room/window-daylight.ts), [`room/photo-reference.ts`](room/photo-reference.ts) | PBR surfaces, local image-based lighting, window-derived daylight, and photo-reference finishes for `/room`. |
| [`room/explode.ts`](room/explode.ts) | Size-aware inventory layout and reversible explode animation keyed by stable item IDs. |
| [`room/import-room.ts`](room/import-room.ts), [`room/workspace-fixture.ts`](room/workspace-fixture.ts) | Local reconstruction JSON import and the nine-piece demonstration plan for `/room`. |
| [`components/AsciiHero.tsx`](components/AsciiHero.tsx), [`components/AsciiField.tsx`](components/AsciiField.tsx) | Current homepage hero. Unchanged. |
| [`components/RoomHero.tsx`](components/RoomHero.tsx), [`room/scene.ts`](room/scene.ts), [`room/parts.ts`](room/parts.ts) | Earlier pencil-room hero. Retained unchanged; the plan viewer copies its look rather than editing it. |

The current ASCII configuration references `/art/japan.mp4`. The `.gitignore` excludes that third-party test footage, so it is absent from a fresh clone. Replace it with licensed material before shipping.

## Using the viewer (for Angelina)

```tsx
import dynamic from "next/dynamic";
// RoomViewer already lazy loads three.js; this keeps even its shell off the first paint
const RoomViewer = dynamic(() => import("@/spatial/components/RoomViewer").then((m) => m.RoomViewer), { ssr: false });

<RoomViewer
  plan={plan}                      // the accepted RoomPlan
  previousPlan={prior}             // optional; draws what changed since that revision
  showChanges
  selectedItemId={selectedId}      // you own selection state
  onSelectItem={setSelectedId}     // canvas clicks, taps and controller triggers; null clears
  onProposePlacement={submitMove}  // optional; omit for a read-only view
  onItemStates={setItemStates}     // optional; model, sized stand-in, or marker per item
  className="h-full w-full"
/>
<RoomInventory plan={plan} selectedItemId={selectedId} onSelectItem={setSelectedId} itemStates={itemStates} />
```

- Selection is by stable item ID only. Selecting from a list swings the camera to the piece; selecting on the canvas does not.
- A drag, arrow keys (Shift for 1 cm steps), or Q and E (15 degree turns) create a local preview. The preview never changes the plan. "Propose move" or Enter calls `onProposePlacement({ itemId, baseRevision, position, rotationY, insideRoom })`. The preview clears when a new revision arrives or the user discards it.
- Locked items cannot be previewed. They show a padlock and a dashed footprint.
- `insideRoom` is the viewer's own footprint check against the room outline, using the best known size. It is a hint, not a validator; `null` means no size is known.
- Sizes always come from the plan: product dimensions first, then the item record. A model's own bounds are shown only when no size is known, and are labeled "Model bounds". If a drawn model disagrees with the listed size by more than 10 percent, the card says so.
- Items with no `assetUrl` but a known size draw as a dashed, sized stand-in. Items with neither draw as a marker. A model that fails to load falls back the same way and is reported as failed.

## Proposed shared contract changes (for Matthew)

Nothing in `backend/contracts.ts` was changed. These came up while building against it:

1. **Asset orientation.** `PlacedItem` has no way to say which local axis of a GLB is its front or width. Two of the bundled models run their long side along local z, so a listing width lands on the wrong axis unless the fixture swaps it. Proposal: an asset record (or `PlacedItem.asset`) with `frontAxis: "+z" | "-z" | "+x" | "-x"` and a `widthAxis`, plus `units` for unit conversion. The viewer would apply that rotation before the plan transform.
2. **Placement proposal.** The viewer emits `{ itemId, baseRevision, position, rotationY }` today. Matthew's mutation should take the same fields plus `projectId` and `requestId`, and reject a stale `baseRevision`.
3. **Seats.** The demo constraint is seating for four, but `PlacedItem` has no seat count, so neither the viewer nor validators can check it. Proposal: `functional: { seats?: number }`.
4. **Evidence on owned items.** `PlacedItem.dimensions` has no evidence IDs, so an owned sofa's size can never be shown as measured. Proposal: `dimensionEvidenceIds: string[]`.

## Quest 3S

What exists: feature-detected "View in headset" and "Passthrough" entry, which appear only when `navigator.xr.isSessionSupported` says yes. Then:

- A `local-floor` session at real scale. The room starts centered on the wearer.
- Controller trigger selects a piece by ray. Selection goes back through `onSelectItem`, so the flat-screen state stays in step.
- In-headset size card above the selected piece, and a hint panel on the left controller.
- Grip starts a two-point floor alignment. Mark the floor where the room's first corner is (shown as an orange post), then a point along the first wall. This sets yaw and position at 1:1 scale, for this session only. Nothing is saved or synced, and "Reset alignment" undoes it.
- Passthrough hides the virtual walls and floor fill, keeping the grid and furniture.

How it was checked: in desktop Chrome with Meta's IWER emulator (Quest 3 profile), injected only into the test browser. Entry, controller selection, the alignment math (the sofa moved to the predicted spot), passthrough entry, and exit all behaved as intended. **It has not been run on a real Quest 3S yet.** Readability at arm's length, controller feel, performance, and the browser build all need a headset session.

To test on the headset: enable developer mode, connect USB, run `adb reverse tcp:3000 tcp:3000`, then open `http://localhost:3000/spatial` in the Quest browser while `npm run dev` is running. Localhost counts as a secure context, so WebXR works without a certificate. Run the asset check on that page in the headset browser for real load numbers.

## Asset check

On `/spatial`, "Check this plan's models" fetches each GLB uncached and reports bytes, fetch and parse time, triangles, meshes, materials, textures, bounds, and a scale verdict against the plan's size. The verdicts are: matches within 10 percent, differs, likely exported in cm or mm, or implausible. "Check one model" takes any URL plus an optional expected size in centimeters, for the project lead's Blender output.

Measured on a MacBook in desktop Chrome (not Quest): the six bundled models are 165 to 416 KB and 2.5k to 19.9k triangles, each parsing in under 10 ms. After the fixture sizes were corrected to match the models, the three models with listed sizes in revision 2 (sofa, lounge chair, display shelves) all read 100 percent per axis.

## Checks

```bash
node --test spatial/room/*.test.mjs   # plan viewer: validation, diffs, footprints, scale verdicts (Node 24+)
node --experimental-strip-types --test spatial/tests/test-room-appearance.mjs spatial/tests/test-explode.mjs   # /room workspace
npm run lint
npm run build
```

## Boundaries

Angelina owns screen layout, forms, product panels, capture UI, and basket review in `frontend/`. Matthew owns canonical state and shopping operations in `backend/`. The project lead owns capture processing, metric geometry proposals, and Blender exports in `reconstruction/`.

`app/spatial/page.tsx` is a thin route that mounts the lab. It lives in `app/`, which Matthew coordinates, so it needs his okay before merge, or it can be dropped.

The viewer never writes the plan, researches products, or prices anything. Shared plan coordinates do not align with a physical room on their own; the headset alignment is local to one session.

Keep heavy renderer code lazy-loaded and browser-only. Use type-only shared contracts; do not import provider SDKs or backend implementations into the renderer. See [team ownership](../docs/team-ownership.md) and [platform UX](../docs/platforms-and-ux.md).

## Furniture explode workspace

Open `/room`, choose **Explode furniture**, select a model or an item in the inventory, and choose **Return furniture** to restore the room. Drag to orbit, scroll/pinch to zoom, and right-drag/two-finger drag to pan. Selecting a settled inventory piece frames it for closer inspection, which also helps on narrow screens; **Reset view** restores the current mode's overview. The list supports keyboard selection without interacting with the canvas. Selection persists across modes. Reduced motion places objects immediately.

The shell stays together while each furnishing moves to a temporary inventory position. Explode is presentation state, not a revision or placement command: no canonical plan coordinates, purchase state, or Blender file are changed. Model dimensions are local model bounds and explicitly unverified against retailer sizes. Missing furniture assets display a labeled box proxy rather than a silent empty scene. Null assets outside the known demo rug/lamp also use proxies.

The renderer takes validated, meter-based, Y-up geometry and independent furniture instances. It creates floor polygons and walls with door/window apertures; front-facing boundary walls and interior partitions fade for the cutaway. Local reconstruction files can be imported; there is no hosted plan-loading integration or placement editor on this route yet. A single flattened GLB cannot be exploded into semantic furniture automatically: the importer must supply separate item IDs, transforms, and assets. Quest/WebXR entry is not implemented by this change, and mobile browser emulation is not physical iPhone verification.

All seven existing GLBs require Meshopt decoding and embedded WebP support. Their combined download is approximately 1.52 MB / 47,371 triangles, but decoded textures use substantially more memory. The workspace caps mobile pixel ratio at 1.5 and uses a single shadow-casting directional light without the pencil viewer's postprocessing. It disposes controls, observers, animation frames, geometry, materials, textures, environment render targets, and late-arriving assets on unmount.

### PBR appearance and lighting

The workspace uses AgX tone mapping, a local 1K HDRI prefiltered once through Three.js PMREM, a low-intensity hemisphere fill, and filtered PCF shadows. The shadow camera covers both the assembled room and the exploded inventory, so pieces retain contact shadows during transitions. This Three.js version removed `PCFSoftShadowMap`; the implementation uses supported `PCFShadowMap` with a non-default filter radius. No external asset service is required at runtime.

CC0 oak base-color, roughness, and OpenGL normal maps and a plaster normal map are served from [`public/materials/room/`](../public/materials/room/). Floor UVs repeat every 1.2 meters in both directions, matching the source material's physical tile; wall plaster repeats every meter with subtle normal strength. Base color is decoded as sRGB; roughness and normal maps remain linear data. Room resizing changes the number of repeats rather than stretching the material. Existing furniture keeps its merchant/model materials and textures. Asset sources, physical scale, licensing, and checksums are recorded in [`sources.json`](../public/materials/room/sources.json).

If an appearance texture cannot load, its material remains a plain PBR surface. If the HDRI fails, a generated `RoomEnvironment` supplies reflection lighting instead. Furniture assets still follow their separate labeled-proxy behavior. These fallbacks keep the workspace inspectable; they do not establish that every requested asset loaded. There is no live reconstruction of the captured room's real materials or light sources.

The HDRI is a generic studio lighting environment, and PCF shadow filtering approximates softness. This browser renderer does not reproduce Blender Cycles light bounces, path tracing, baked lightmaps, or measured real-room illumination. It favors an interactive desktop/mobile view over offline-render parity; physical iPhone and Quest performance still need device testing.

Run the focused behavior checks from the repository root:

```bash
node --experimental-strip-types spatial/tests/test-explode.mjs
npm run lint
npm run build
```

The 13 layout/controller checks cover variable sizes, pivots, rotated/scaled roots, transformed parents, non-overlap, deterministic ordering, exact restoration, rapid reversals, reduced motion, immutable bounds/input, and disposal. Browser checks should additionally cover actual asset loading, canvas/list selection, camera controls, narrow-screen framing, and navigation/unmount.

Navigation regression check: explode the room, select a piece, follow **Capture a room**, then go back. Both the inventory mode and selection must reappear in the renderer as well as the controls. Next.js Activity preserves React state but cleans up effects, so the asynchronous scene initialization explicitly reapplies the latest committed view state.

## Photo finishes and window daylight

The workspace accepts optional shared `RoomAppearance` estimates per floor/wall, including tint, roughness, physical texture scale and UV rotation. The default photo reference styles sample geometry using an inspected building gallery image and explicitly labels its unverified unit attribution. Toggle Photo reference finishes to compare styling defaults. Open room file reads a bounded local reconstruction request/scene JSON without uploading it. Optional captured `items` are preserved as existing-owned, evidence-linked size proxies; old shell-only files still import with an empty inventory. Each imported item needs positive width/height/depth, bottom-center position, Y yaw, a known room and nonempty source evidence. Product/asset URLs and proposed purchases are rejected at this boundary.

`window-daylight.ts` derives exterior-window centers and inward normals via polygon probes, including concave rooms and shared partitions. Sized RectAreaLights supply PBR illumination; one window-aligned directional proxy supplies approximate shadows. No established windows means a disclosed studio fallback. This is not measured illumination, solar positioning or realtime indirect illumination. See [photo appearance](../docs/photo-appearance.md) for input/provenance and rendering limits.

Run `node --experimental-strip-types --test spatial/tests/test-room-appearance.mjs spatial/tests/test-explode.mjs` for the pure window/import/UV and furniture behavior checks.


### Captured existing furniture

Native reconstruction requests can include independent captured furniture instances in `items`. These use the same canonical `PlacedItem` transforms as other furniture: meters, Y-up, position at bottom-center, width/height/depth in local axes and Y rotation in radians. Imported size proxies preserve those extents, including nonzero yaw and elevated bottoms; they do not claim an exact mesh, fabric, product identity or retailer dimension. The selected-item panel shows source claims, the sensor estimate disclosure and whether placement is locked for planning. Existing-owned items have no product association and do not enter a shopping basket.

Locked placement remains canonical; inventory explode is a reversible presentation transform and returns each detected item to its original position and orientation. Source evidence and the original request are not changed. An empty `items` array remains a usable room shell, and older request files without `items` remain supported.

Run `node --experimental-strip-types --test spatial/tests/test-captured-furniture.mjs spatial/tests/test-room-appearance.mjs spatial/tests/test-explode.mjs` for import limits/provenance, unsafe-link rejection, rotated/elevated proxy bounds and locked-item explode/restore checks.


### Local photo-textured reconstruction models

At `/room`, choose **Open room file** for the reconstruction JSON, then **Open room model** for its generated `scene.glb`. The model is read in the browser without uploading files. **Remove room model** restores the procedural preview, and importing another JSON clears the previous model. A mismatched or unsupported GLB reports an error and keeps the procedural room usable.

The importer accepts one static GLB up to 64 MiB with embedded PNG/JPEG images, no resource URLs (including data URLs), bounded image dimensions/decoded pixel count, and supported material extensions. Before replacing the preview, it checks the exported project ID and input revision, every floor/wall/opening/furniture semantic ID and role, wall/opening/furniture transforms, actual floor/wall/furniture extents, finite vertices and at least one `photo_projected` entity. This binds the model to the opened project/revision and geometry. The viewer does not check the job ID (the shared plan does not retain it), independently verify a photo’s identity, or establish visibility.

Captured furniture keeps independent canonical roots and can still be selected, exploded and returned exactly. Projected photos describe appearance on the captured size proxy, not a recovered detailed furniture mesh. Unseen faces retain the reconstruction worker’s fallback material; lighting remains the viewer’s approximation.

Run the focused resource/import/placement regressions:

```bash
node --experimental-strip-types --test spatial/tests/test-textured-model.mjs spatial/tests/test-captured-furniture.mjs spatial/tests/test-explode.mjs spatial/tests/test-room-appearance.mjs
```


### Observed surface reference

For scans that include ARKit surface geometry and photos, open the matching reconstruction JSON with **Open room file**, then use **Open captured room** for its detailed `scene.glb`. This is a separate view of the sensor's actual partial surface mesh, including furniture contours; it does not replace the editable layout with falsely detailed furniture assets. **Show editable layout** restores the procedural or photo-projected planning scene, previous selection and explode state. **Show captured room** returns to the reference. Inventory selection and explode are disabled in the reference because scan chunks are not individual furniture objects.

The initial camera uses the first captured camera pose when available; otherwise it is placed inside the room at eye level, avoiding a ceiling blocking the overview. Reset returns to that view. Photo-bearing surfaces render unlit and double-sided because RGB images already include captured lighting. Unobserved regions remain fallback surfaces; holes and rough geometry reflect missing sensor coverage. This is not a watertight replica, an individually segmented furniture model, or measured reflectance.

The browser binds the GLB's scene extras `captureRepresentation: "observed_surface_mesh"`, `projectId`, text `inputRevision`, `jobId`, and `sourceRequestSha256` or `inputSha256` to the exact opened JSON bytes. Only semantic `captured_surface` nodes with unique `mesh-<lowercase UUID>` IDs are accepted; a node may own multiple material primitive meshes. Geometry must be finite and rigidly transformed, with bounded triangle indices and no unidentified meshes. Captured imports allow a 128 MiB GLB with up to 4 MiB JSON and 16 million total accessor elements; the editable photo-only model retains its 64 MiB limit. Both require embedded PNG/JPEG images, at most 64 million decoded image pixels, and no URLs. Captured geometry has total 1.8 million exported vertex / 600k triangle budgets (up to three UV-seam vertices per source triangle). Nothing is uploaded. Opening a new reconstruction JSON clears both local models.

```bash
node --experimental-strip-types --test spatial/tests/test-captured-model.mjs spatial/tests/test-textured-model.mjs spatial/tests/test-captured-furniture.mjs spatial/tests/test-explode.mjs spatial/tests/test-room-appearance.mjs
```


### Clean photo-informed room models

**Open room model** also accepts a complete structured GLB with scene `captureRepresentation: "photo_informed_parametric"`. This mode retains the full measured shell and stable furniture IDs, poses and metric envelopes while replacing boxes with modeled furniture forms and photo-informed PBR finishes. Furniture remains independently selectable and supports reversible explode/return. The optional raw surface reference remains available through **Open captured room**.

Structured models bind their project, revision, job and `sourceRequestSha256` or `inputSha256` to the exact opened reconstruction JSON. The importer keeps all floor/wall/opening geometry checks and furniture local-envelope checks. Each furniture semantic root must declare `representation: "photo_informed_parametric"`, `appearanceStatus: "photo_inferred"`, and `proxyGeometry: "photo_informed_parts"`; an optional `visualLabel` (up to 200 characters) appears in the inventory. Multiple material primitive meshes may live beneath one semantic item root. Standard PBR materials and the local 64 MiB embedded-resource limits still apply.

This explicitly identified mode does not require a `photo_projected` surface: its forms and finishes are estimates informed by photos, rather than direct pixel projection or exact object reconstruction. Legacy photo-textured models retain their projection requirement. The interface labels the structured model and explains the uncertainty instead of describing it as an exact furniture scan or a bounding box.

### First-person shopping and Quest in the PBR room

`/room` now supports **Walk inside** for the same imported clean room model: WASD/arrows, mouse lock or drag-look, 1.6 m eye height, collision against measured walls and furniture, and touch movement buttons. Escape releases mouse look so product controls remain usable. E selects at the crosshair; clicking a free floor spot in overview also selects a shopping location. Overview and explode remain separate presentation modes.

The local shopping adapter reuses Matthew's real retailer catalog and shared placement/plan rules. Products preview at their listed dimensions using approximate category models; explicit confirmation adds a separate proposed item and local preview basket. Removing a preview purchase preserves all scanned items. Catalog prices/stock are saved observations, shipping/tax remain unknown, and no live research, server plan registration, checkout or purchase is implied. Purchases survive Next.js Activity navigation within the open tab; a full reload resets the local basket.

**Enter VR** uses the same PBR scene in WebXR `local-floor`, with full walls and an inferred ceiling. Trigger selects an item or shopping location, left-stick aim/release teleports to clear floor, right stick snap-turns, and grip repositions the shopping panel. Headset cards support preview and separate placement confirmation. Teleport destinations use room/furniture collision checks; physical tracked movement still follows the headset's guardian. No passthrough alignment is claimed.

See [Quest setup](../docs/quest-setup.md) for USB localhost forwarding and the private development-only capture bridge. Mac file imports do not appear on the Quest automatically. The bridge serves only the configured JSON/GLB with a temporary token, is loopback-only, and refuses production requests. Photos and generated scans remain outside Git/public assets. The token may be retained only in that browser tab's session storage to restore the local scan after reload; Back to demo/manual room import clears it.

Run the complete spatial suite with `npm run test:spatial`. It runs existing Three.js ESM fixtures with native Node type stripping, and backend-alias/JSON/XR tests through `tsx` separately. Running every file through `tsx` creates different ESM/CJS Three.js constructor identities and invalidates `instanceof` fixture checks; do not misdiagnose that harness mismatch as a model failure. Run `npm test`, `npx tsc --noEmit`, `npm run lint` and `npm run build` as well. This repository enables Next.js cache components, so new route handlers must avoid incompatible `runtime`/`dynamic` segment exports; the private handler uses request headers and no-store responses.

Automated XR tests cover synthetic controller rays, tracking loss, teleport cancellation, snap turns, HUD bounds, entry/exit/reentry/disposal races and camera restoration. They do not establish Quest frame rate, controller feel or comfort; those remain physical-device checks.

### Indoor lighting in the main room flow

The photo-informed scanned room at `/rooms/[roomId]` supports actual Cycles lightmaps as well as the `indoor-lighting.ts` runtime fallback. `baked-indirect.ts` restores a tagged secondary-UV atlas from the derived GLB's emissive transport into diffuse lighting. Full diffuse bakes replace runtime diffuse once, preserving live PBR specular/reflections and modest dynamic contact shadows. Moved/rotated/exploded pieces revert to runtime shading instead of carrying their original baked illumination. Original artifacts and source binding remain intact. See [Blender lighting workflow](../docs/blender-lighting.md) for baking, denoising and model upgrades.

Desktop uses one 2048px PCF shadow map. Mobile and immersive VR use one 1024px map and hide the area fills; VR explicitly applies this budget even with a large viewport or fine pointer. XR framebuffer scale is 0.85 with foveation 0.6, configured before session entry. There are no point-light shadow cubes, screen-space effects or stereo postprocessing passes.

`shadow-cache.ts` updates the depth map only when visible caster transforms, geometry or visibility change, or when the light/frustum is invalidated. Walking and head motion reuse it; furniture movement, placement, async model loading, storage, undo, cutaway changes and explode refresh it. Explode expands the shadow frustum to include the inventory and restores it on return. The cache is intended for this static-mesh room pipeline, not animated skeletal or morph-target assets.

The spatial suite includes lighting-budget, XR profile restore, shadow-frustum and cache invalidation regressions. Physical Quest frame rate still needs device verification. API references: [Three.js shadow caching](https://threejs.org/docs/pages/LightShadow.html), [WebXR resolution and foveation](https://threejs.org/docs/pages/WebXRManager.html).

Semantic `WindowGlass` panes use inexpensive alpha PBR with no transmission render pass. The glass is excluded from opaque lightmaps and depth/shadow writing; actual modeled blinds remain opaque. A transparent pane does not supply an exterior reconstruction: the current backdrop remains a presentation environment.
