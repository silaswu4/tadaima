# Website room flow

Updated October 18, 2026. The product entry point is `/` → `/rooms` → `/rooms/[roomId]`. The gallery, desktop room and Quest experience now share the same room identity, furniture IDs and editable plan.

## Use the product

1. From the landing page, choose **Walk through a demo room**, or open `/rooms` directly.
2. On **Your rooms**, choose a demo or select **Open scan**. Import a processed reconstruction JSON and, optionally, its matching clean/photo-textured GLB. Importing a scan saves it privately in this browser and opens that room.
3. Choose **Step inside** on a gallery room. **Walk** provides first-person exploration; **Dollhouse** provides orbit controls; **Explode** lays out the furniture separately without changing its accepted placement.
4. Select furniture to inspect it. Unlocked pieces support moving, rotating, putting away and replacement. **Inventory** brings stored pieces back; **Undo** reverses edits during the current visit.
5. Use **Add furniture**, choose a saved catalog product, inspect its placement preview, then explicitly **Confirm placement**. Only confirmation adds it to the room and preview basket.
6. Return to **Rooms** or refresh. Saved room edits and basket lines remain associated with that room. The gallery remembers the last selected room for the current browser session.
7. On a supported Quest browser, open the same selected room and choose **Enter VR**. See [Quest setup](quest-setup.md) for USB forwarding and private scan transfer.

Desktop movement uses WASD/arrow keys and mouse look. Click the walk view to capture the pointer; Escape releases it. Touch devices use drag-to-look and the movement pad. Dollhouse, selection, product panels and the basket remain available without entering immersive VR.

The old `/room` page is retained as a diagnostic workspace with manual artifact controls. It is not the main product route. `/dev` remains the backend development console; a local preview basket does not silently hand off to its unrelated demo project.

## Routes and handoffs

| Entry | Current contract |
| --- | --- |
| `/` | Landing page links to the gallery and browser photo capture. |
| Address submission | Stores a trimmed address under `sessionStorage["tadaima:pending-address"]`, then opens `/rooms?onboarding=address`. The address is not placed in the URL. |
| `/rooms` | Reads private room records, shows their detailed model previews when available, and includes the fixture room catalog. **Open scan** mounts the importer. |
| `/rooms/[roomId]` | Resolves that exact private room ID or catalog ID/slug, loads its saved draft and mounts `RoomExperience`. Changing IDs cannot keep rendering the previous room. |
| Missing room | Shows recovery guidance and **Back to rooms**; it does not substitute another room. |
| `/capture` | Collects four browser photographs and downloads a private photo ZIP. Processing is an explicit next step. |
| `/rooms#local-scan=…` | Development-only private scan bootstrap using the configured local capture bridge; successful import removes the capability from the URL. |

Automatic address research is **not connected to this website flow**. The gallery explains that the address has been saved for setup and offers processed-room import or demos. It does not display a demo as the researched address. Blocked session storage keeps address submission on the landing form with an error.

## Import a real scan

The importer accepts a **processed reconstruction request JSON**, up to 2 MiB. A raw native RoomPlan JSON, USDZ, native photo ZIP or browser capture ZIP first needs its corresponding reconstruction processing step. The optional runtime model must be the matching clean or photo-textured GLB, up to 64 MiB. The fragmented observed LiDAR reference is not the primary editable model for this flow.

The importer checks the JSON contract and computes SHA-256 over its original UTF-8 bytes. The saved room ID is `local-scan-<source SHA-256>`. A supplied model must match project, job, original revision and request hash. GLB preflight forbids external resources and unsupported geometry; semantic binding then checks furniture IDs, transforms, dimensions, floors, walls and openings. A mismatch fails before saving a successful-looking room.

The GLB is optional. JSON-only imports use the accepted room layout and furniture stand-ins. Adding the matching model later enriches the same room without resetting accepted edits. Reopening the same source also preserves existing edits.

For an iPhone capture, use the [native scanner/importer](native-scan.md), retain the full photo/detailed-scan bundle, and process it into reconstruction artifacts before import. For four-photo web capture, follow the [photo reconstruction workflow](../reconstruction/capture/README.md). Downloading the ZIP alone does not run inference or create a room in the gallery.

## Source geometry and editable state

`spatial/rooms/registry.ts` owns the private browser registry in IndexedDB database `tadaima-private-rooms`, version 2. It has separate `rooms` and `catalog-drafts` stores.

A private room retains:

- Exact original source JSON, parsed source plan, job/hash binding and optional GLB Blob.
- A separate edited plan with current furniture transforms, stored state and proposed purchases.
- Room label and update time.

Source geometry, appearance observations, original furniture dimensions and evidence identities remain immutable. Edited plans may move/rotate furniture, change locks/storage and introduce shopping proposals; they are validated before saving. The room route queues saves and surfaces storage failures instead of claiming an edit was saved. Saved browser drafts survive route changes and refresh; camera pose, hover, pending previews, explode animation and undo history are transient.

Catalog drafts use their own catalog room IDs and cannot alias private `local-scan-…` records. Cross-tab change notifications update the room list. Clearing site data or using a different browser, device, hostname or port does not preserve these private rooms: storage is scoped to the browser origin. There is no account sync in this integration.

Room inputs are not uploaded by the importer or copied into `public/`. Private model bytes pass directly to Three.js. The registry is local persistence, not encrypted cloud storage; other code with access to this browser origin has the same browser-storage boundary.

## One detailed model across gallery and room

`IsoRoomGallery` passes an optional immutable reconstruction source to `iso-gallery.ts`. The gallery validates and binds the model, preserves its packed materials and opening details, and hides foreground walls for a cutaway preview. It applies accepted furniture edits once and excludes stored/removed pieces. Proposed purchases use the existing catalog/library display path. The original scan is not duplicated as both a static backdrop and editable furniture.

`RoomExperience` uses `walk-scene.ts` for selection, first-person navigation, orbit view, move/rotate/store/take-out, undo, explode and placement preview. Source models are validated against the immutable source plan; an edited revision is not incorrectly compared with the original GLB revision. Each selectable item owns one editable transform wrapper around its model-local geometry.

Explode changes presentation transforms only. Entering walk/VR or performing an edit restores assembled furniture first. Navigation and shopping validation use the assembled canonical room. Collision/spawn checks account for the floor boundary, walls and furniture footprints; these are simplified clearance checks, not a physics simulation of every mesh cavity.

## What is measured and what is approximate

Sensor-derived RoomPlan inputs supply metric room geometry and detected furniture extents. Four-photo inference inputs instead retain inferred scale and dimensions. Importing either format does not upgrade its evidence status.

The clean photo-informed GLB uses recognizable furniture forms and finishes inferred from actual room photos inside those accepted dimensions. Upholstery, fine structure, carpet pattern boundaries, hidden surfaces and lighting remain estimates. It is not an exact photogrammetric replica or measured material scan. The raw observed surface mesh, when retained separately, reflects actual sensor coverage and can contain holes and projection artifacts.

Catalog products retain listed dimensions and saved retailer observations. A category/library model may approximate their appearance; its shape is not proof of an exact SKU match. Placement validation checks recorded dimensions and plan constraints, not independently measured shipping or installation clearance.

## Shopping and payment boundary

The catalog is the saved retailer data in `backend/fixtures/real-catalog.json`. Preview and confirmation recheck price/dimensions, recorded availability, fit, budget and locked replacement rules. A product that cannot fit is rejected; the engine does not place it at an overlapping room center. Confirmed proposed purchases become basket lines; owned furniture does not become a purchase charge.

**Export basket** downloads a JSON preview with room/item details and available retailer links. No order or payment is submitted by this flow. Prices and stock still need rechecking; tax, delivery and installation costs are unknown. Sponsor checkout/payment adapters in the backend development console remain separate until a room-specific, reviewed handoff is deliberately wired.

## Quest integration and verification

The selected product room uses `workspace-xr.ts` as its sole immersive session/controller owner, adapted by the walk engine. It supplies real scene-space offer cards, selection, valid floor targeting, teleport, snap turn and explicit placement confirmation. DOM panels alone are insufficient inside immersive VR. Session exit restores the desktop camera and controls; route disposal releases session/controller resources.

Automated checks cover source binding, private registry validation, shopping constraints, navigation, explode/return, movement input, WebXR interactions and the USB launcher. Run:

```bash
npm run test:spatial
npx tsc --noEmit
npm run build
```

Browser verification during this integration included loading the actual private clean-room model in the gallery and entering its detailed room. Continue verifying edits → back → reenter → refresh, room switching, placement cancel/confirm, stored inventory, no-fit rejection and missing-room recovery when changing these contracts.

No physical Quest 3S session was available during this integration. Headset frame rate, controller feel, comfort, real session entry/exit and repeated route/session lifecycle still require the device checklist in [Quest setup](quest-setup.md). Synthetic/controller tests do not establish physical headset performance.
