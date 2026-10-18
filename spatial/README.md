# Spatial frontend · Silas

Owner: **Silas**. Build the browser-based 3D viewer and Quest 3S interaction layer. This is a frontend role; it does not own reconstruction or retailer research.

## Existing code

- [`components/FurnitureWorkspace.tsx`](components/FurnitureWorkspace.tsx): responsive furniture workspace at `/room`, with explode/return, camera reset, selectable inventory, loading/error states, and model dimensions. The ASCII homepage and old pencil viewer are preserved.
- [`room/workspace-scene.ts`](room/workspace-scene.ts): lazy Three.js cutaway renderer, GLB loading with Meshopt, orbit/pan/zoom, raycast selection, camera framing, reduced motion, and GPU cleanup. `createFurnitureWorkspace(canvas, callbacks, options)` accepts an optional canonical `RoomPlan`; it snapshots input rather than changing shared state.
- [`room/workspace-fixture.ts`](room/workspace-fixture.ts): explicit nine-piece demonstration plan using seven existing GLBs plus a procedural rug and lamp. The route currently mounts this sample, not an uploaded scan or address reconstruction.
- [`room/explode.ts`](room/explode.ts): reusable size-aware inventory layout and reversible object animation. Stable item IDs map to independent loaded object roots; furniture keeps its original size and orientation. Inventory boxes sit beyond the room's +X boundary without overlapping. Return restores original local position, quaternion, and scale exactly, including after interrupted transitions.
- [`components/AsciiHero.tsx`](components/AsciiHero.tsx): latest homepage hero configuration, visibility/playback handling, and ASCII renderer composition.
- [`components/AsciiField.tsx`](components/AsciiField.tsx): incoming WebGL2 ASCII rendering implementation, preserved without behavior changes.
- [`components/RoomHero.tsx`](components/RoomHero.tsx): earlier pencil-room client canvas, lazy scene import, selected-object labels, and loading fade; retained but no longer mounted on the homepage.
- [`room/scene.ts`](room/scene.ts): hardcoded room, GLB loading, fixed camera, raycasting, pencil rendering, and cleanup.
- [`room/parts.ts`](room/parts.ts): procedural furniture helpers.
- `public/models/` remains the shared Next.js static asset location for the existing furniture GLBs. Coordinate new assets here with Matthew for integration and the project lead for generated artifacts; preserve provenance.

The current ASCII configuration references `/art/japan.mp4`. The incoming `.gitignore` excludes that third-party test footage, so it is absent from a fresh clone. Preserve the asset boundary and replace it with licensed material before shipping; do not commit the excluded test clip as part of scaffold work.

## Scope and first tasks

1. Preserve the latest ASCII homepage and the earlier Three.js viewer while moving toward a room viewer driven by [`RoomPlan`](../backend/contracts.ts).
2. Add stable object IDs and explicit selection events for Angelina's product panels.
3. Support placed transforms, locked-item affordances, and visible revision changes.
4. Keep mobile touch and accessible object-list integration usable without hover.
5. Add tested Quest 3S WebXR entry/exit, controller selection, and local alignment.
6. Benchmark scale and asset loading with the project lead's GLB outputs; label visual proxies honestly.

## Boundaries

Angelina owns screen layout, forms, product panels, capture UI, and basket review in `frontend/`. Matthew owns canonical state and shopping operations in `backend/`. The project lead owns capture processing, metric geometry proposals, and Blender exports in `reconstruction/`.

The existing scene uses demonstration model bounds. It is not an exact retailer dimension validator or a real room reconstruction. Shared plan coordinates do not provide automatic physical alignment in Quest.

Keep heavy renderer code lazy-loaded and browser-only. Use type-only shared contracts; do not import provider SDKs or backend implementations into the renderer. All application commands run from the root. See [team ownership](../docs/team-ownership.md) and [platform UX](../docs/platforms-and-ux.md).

## Furniture explode workspace

Open `/room`, choose **Explode furniture**, select a model or an item in the inventory, and choose **Return furniture** to restore the room. Drag to orbit, scroll/pinch to zoom, and right-drag/two-finger drag to pan. Selecting a settled inventory piece frames it for closer inspection, which also helps on narrow screens; **Reset view** restores the current mode's overview. The list supports keyboard selection without interacting with the canvas. Selection persists across modes. Reduced motion places objects immediately.

The shell stays together while each furnishing moves to a temporary inventory position. Explode is presentation state, not a revision or placement command: no canonical plan coordinates, purchase state, or Blender file are changed. Model dimensions are local model bounds and explicitly unverified against retailer sizes. Missing furniture assets display a labeled box proxy rather than a silent empty scene. Null assets outside the known demo rug/lamp also use proxies.

The renderer takes validated, meter-based, Y-up geometry and independent furniture instances. It creates floor polygons and walls with door/window apertures; front-facing boundary walls and interior partitions fade for the cutaway. There is no live plan loading UI or placement editor on this route yet. A single flattened GLB cannot be exploded into semantic furniture automatically: the importer must supply separate item IDs, transforms, and assets. Quest/WebXR entry is not implemented by this change, and mobile browser emulation is not physical iPhone verification.

All seven existing GLBs require Meshopt decoding and embedded WebP support. Their combined download is approximately 1.52 MB / 47,371 triangles, but decoded textures use substantially more memory. The workspace uses standard lighting/shadows without the pencil viewer's postprocessing and caps mobile pixel ratio at 1.5. It disposes controls, observers, animation frames, geometry, materials, textures, and late-arriving assets on unmount.

Run the focused behavior checks from the repository root:

```bash
node --experimental-strip-types spatial/tests/test-explode.mjs
npm run lint
npm run build
```

The 13 layout/controller checks cover variable sizes, pivots, rotated/scaled roots, transformed parents, non-overlap, deterministic ordering, exact restoration, rapid reversals, reduced motion, immutable bounds/input, and disposal. Browser checks should additionally cover actual asset loading, canvas/list selection, camera controls, narrow-screen framing, and navigation/unmount.

Navigation regression check: explode the room, select a piece, follow **Capture a room**, then go back. Both the inventory mode and selection must reappear in the renderer as well as the controls. Next.js Activity preserves React state but cleans up effects, so the asynchronous scene initialization explicitly reapplies the latest committed view state.
