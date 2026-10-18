# Spatial frontend · Silas

Owner: **Silas**. Build the browser-based 3D viewer and Quest 3S interaction layer. This is a frontend role; it does not own reconstruction or retailer research.

## Existing code

- [`components/AsciiHero.tsx`](components/AsciiHero.tsx): latest homepage hero configuration, visibility/playback handling, and ASCII renderer composition.
- [`components/AsciiField.tsx`](components/AsciiField.tsx): incoming WebGL2 ASCII rendering implementation, preserved without behavior changes.
- [`components/RoomHero.tsx`](components/RoomHero.tsx): earlier pencil-room client canvas, lazy scene import, selected-object labels, and loading fade; retained but no longer mounted on the homepage.
- [`room/scene.ts`](room/scene.ts): hardcoded room, GLB loading, fixed camera, raycasting, pencil rendering, and cleanup.
- [`room/parts.ts`](room/parts.ts): procedural furniture helpers.
- `public/models/` remains the shared Next.js static asset location for the existing furniture GLBs. Coordinate new assets here with the project lead and preserve provenance.

The current ASCII configuration references `/art/japan.mp4`. The incoming `.gitignore` excludes that third-party test footage, so it is absent from a fresh clone. Preserve the asset boundary and replace it with licensed material before shipping; do not commit the excluded test clip as part of scaffold work.

## Scope and first tasks

1. Preserve the latest ASCII homepage and the earlier Three.js viewer while moving toward a room viewer driven by [`RoomPlan`](../backend/contracts.ts).
2. Add stable object IDs and explicit selection events for Angelina's product panels.
3. Support placed transforms, locked-item affordances, and visible revision changes.
4. Keep mobile touch and accessible object-list integration usable without hover.
5. Add tested Quest 3S WebXR entry/exit, controller selection, and local alignment.
6. Benchmark scale and asset loading with Matthew's GLB outputs; label visual proxies honestly.

## Boundaries

Angelina owns screen layout, forms, product panels, capture UI, and basket review in `frontend/`. The project lead owns canonical state and shopping operations in `backend/`. Matthew owns capture processing, metric geometry proposals, and Blender exports in `reconstruction/`.

The existing scene uses demonstration model bounds. It is not an exact retailer dimension validator or a real room reconstruction. Shared plan coordinates do not provide automatic physical alignment in Quest.

Keep heavy renderer code lazy-loaded and browser-only. Use type-only shared contracts; do not import provider SDKs or backend implementations into the renderer. All application commands run from the root. See [team ownership](../docs/team-ownership.md) and [platform UX](../docs/platforms-and-ux.md).
