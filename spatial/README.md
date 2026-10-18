# Spatial frontend · Silas

Owner: **Silas**. Build the browser-based 3D viewer and Quest 3S interaction layer. This is a frontend role; it does not own reconstruction or retailer research.

## What is here

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
node --test spatial/room/*.test.mjs   # plan validation, diffs, footprints, scale verdicts (Node 24+)
npm run lint
npm run build
```

## Boundaries

Angelina owns screen layout, forms, product panels, capture UI, and basket review in `frontend/`. Matthew owns canonical state and shopping operations in `backend/`. The project lead owns capture processing, metric geometry proposals, and Blender exports in `reconstruction/`.

`app/spatial/page.tsx` is a thin route that mounts the lab. It lives in `app/`, which Matthew coordinates, so it needs his okay before merge, or it can be dropped.

The viewer never writes the plan, researches products, or prices anything. Shared plan coordinates do not align with a physical room on their own; the headset alignment is local to one session.

Keep heavy renderer code lazy-loaded and browser-only. Use type-only shared contracts; do not import provider SDKs or backend implementations into the renderer. See [team ownership](../docs/team-ownership.md) and [platform UX](../docs/platforms-and-ux.md).
