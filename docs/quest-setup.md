# Quest 3S room exploration

Updated October 18, 2026. This is a browser experience: use Meta Quest Browser, with the same metric room geometry and furniture IDs as the desktop workspace. No native Quest app, Unity project, Quest Link, SteamVR, or APK is needed.

## Connect the headset

Yes: connect the Quest 3S to the Mac with a USB data cable, put it on, and accept the USB debugging prompt. For the local development path, enable Developer Mode first using Meta's [device setup instructions](https://developers.meta.com/vr/documentation/native/android/mobile-device-setup/). Developer Mode is for USB debugging; a normal hosted HTTPS WebXR page does not require sideloading an app.

Install Android Platform Tools if `adb` is unavailable. With the headset powered on, run:

```bash
adb devices -l
```

The headset must show `device`, not `unauthorized` or `offline`. If unauthorized, unlock the headset and accept the debugging prompt. Use a data-capable cable if no device appears. If more than one Android device is connected, add `-s <Quest serial>` after `adb` to target the headset explicitly.

With Tadaima running on port 3017 on the Mac:

```bash
adb reverse tcp:3017 tcp:3017
adb reverse --list
```

Open `http://localhost:3017/room` **in Meta Quest Browser on the headset**, then choose the page's VR entry button and allow the immersive experience. The forwarded `localhost` is the headset's connection to the Mac; `127.0.0.1` in an unforwarded headset browser is not the Mac. These USB forwarding and remote inspection steps follow Meta's [Browser debugging guide](https://developers.meta.com/vr/documentation/web/browser-remote-debugging/).

Keep the development server and USB connection active. The physical boundary remains the headset's boundary: a reconstructed room is not automatically registered to the real room around the wearer.

## Use the room

| Input | Behavior |
| --- | --- |
| Look around | Head tracking at 1:1 metric scale, with the headset's measured eye height |
| Controller trigger on furniture | Select that stable room item and update the shopping panel |
| Left thumbstick forward, aim, release | Teleport to the valid floor reticle |
| Right thumbstick left/right | Turn in discrete 30-degree steps; release to turn again |
| Controller grip | Hide/show and reposition the shopping panel in front of the wearer |
| Trigger on a product card | Choose a product preview supplied by the application |
| Trigger on a valid floor spot | Choose a shopping placement spot; position the local preview when a product is selected. This does not teleport. |
| Trigger on Confirm placement | Confirm that preview through the application's callback; this does not purchase furniture |

Controller rays respect the nearest supplied wall or furnishing. Trigger selection and locomotion are separate: only the left-stick aim/release action teleports. Teleport destinations use the same room clearance checks as desktop navigation. Moving your physical head is still physical movement, so the app's navigation checks do not replace the Quest boundary.

The headset panel is actual Three.js scene geometry. Ordinary DOM shopping controls are not visible inside an immersive VR session. The panel shows up to three current offers with supplied prices/dimension summaries, including the selected offer if it was chosen elsewhere in the result list. Display text is bounded, unchanged states reuse their existing panel textures, and confirmation is unavailable without a matching selected offer. The panel does not invent retailer results or call checkout. Search/loading/error status and selected offers come from the surrounding application. Exit immersive mode with the Quest browser/system controls to return to the page.

## Get the scanned room onto Quest

The Mac browser's imported JSON/GLB and local storage are **not shared** with the headset browser. Opening the same `/room` URL alone does not transfer a room imported on the Mac. The page must load the matching room request and clean GLB in the headset, either through an explicitly configured private local asset route or files available to the headset's file picker. Use matching reconstruction artifacts; do not use the fragmented raw LiDAR mesh as the primary shopping room.

Do not commit the user's room photos or generated scan assets into `public/` or expose them through a public tunnel merely to make a demo load. USB forwarding provides a local connection; it does not by itself publish anything on the internet.

### Private development bridge

The optional `/api/local-capture/scene` and `/api/local-capture/model` routes read only `scene.json` and `scene.glb` from an explicitly configured directory. Configure the directory containing the matching final clean room artifacts before starting the development server:

```bash
export TADAIMA_LOCAL_CAPTURE_DIR="/absolute/path/to/clean-room-final"
export TADAIMA_LOCAL_CAPTURE_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
npm run dev -- --hostname 127.0.0.1 --port 3017
```

Keep the token private. This bridge requires development mode, a loopback hostname, same-origin requests, and the exact bearer token; it returns 404 in production or when unconfigured. Responses are not cached. It does not expose room photos, the Blender source, arbitrary filesystem paths, or a directory listing.

After USB port forwarding, open this URL in the Quest browser, replacing the token placeholder with the same value configured for the server:

```text
http://localhost:3017/room#local-scan=<64-character-token>
```

The page uses the fragment token to request the two artifacts with authorization headers and validates their matching identity before loading the room. URL fragments are not sent in ordinary HTTP requests, but the token is still a credential visible to someone reading the full URL. Do not put that URL in shared screenshots or documentation.

Once the server is running and the Quest is connected, open the private scan with one command from the repository root:

```bash
npm run quest:open
```

The helper reads only `TADAIMA_LOCAL_CAPTURE_TOKEN` from the current environment or a literal assignment in the repository's `.env.local`. Use the same value configured for the server; it never evaluates the environment file. It verifies an authorized Quest model, forwards port 3017, and opens the local room URL through Android's normal browser intent. ADB's output is captured because Android can echo the private URL; the helper does not print the token. It does not install software or open a remote address.

If more than one authorized Quest is attached, choose the serial shown by `adb devices -l`:

```bash
npm run quest:open -- --serial <Quest-serial>
```

No-headset, unauthorized, offline, missing-token, and ADB errors return a nonzero exit code with setup guidance. The helper can be tested without a headset:

```bash
node --test spatial/tests/test-quest-open.mjs
```

All 10 helper tests passed using injected ADB responses. Running the real helper while the headset was unavailable correctly reported that no authorized Quest was found; that is not a physical VR validation. The local bridge is an explicit demo transport, not hosted account storage or scan synchronization.

## HTTPS instead of USB

A reachable HTTPS deployment with a trusted certificate is the alternative. A plain `http://192.168...:3017` LAN URL is not a secure context for WebXR. A development certificate must actually be trusted by the headset; clicking past a certificate warning is not a reliable substitute. The page feature-detects immersive VR support and explains insecure/missing API states. Session entry must come directly from a user action, per [WebXR permission requirements](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Permissions_and_security).

## Debug and validate

Open `chrome://inspect/#devices` in Chrome on the connected Mac, find the Quest Browser tab, and inspect it. Check the tab console and network requests if the room or headset entry fails. Meta also supports managing the connection through Meta Quest Developer Hub. [Meta debugging reference](https://developers.meta.com/vr/documentation/web/browser-remote-debugging/).

Before calling the physical experience verified, record the actual Quest 3S browser build and check:

1. The intended scanned room loads with recognizable furniture and full-height walls.
2. Standing eye height is plausible, furniture dimensions are metric, and the spawn is on clear floor.
3. Trigger selection cannot reach through a wall; floor destinations reject obstructions and outside-room points.
4. Teleport works on left-stick release, and snap turn requires recentering the right stick.
5. Product cards, floor placement, and explicit placement confirmation work without leaving VR.
6. Exiting restores the previous desktop camera and controls. Re-entering and route unmount do not duplicate controllers or leave an active session.
7. Head tracking remains comfortable under the actual room's draw-call and texture load. Emulator success does not establish headset frame rate.

Automated tests cover metric teleport/snap pivot math, user-gesture entry, support and permission failures, unsafe room rejection, exact camera restoration, end/reentry, concurrent entry, disposal during pending permission and renderer initialization, current-frame ray picking, ray occlusion, tracking and browser-focus loss, destination revalidation, bounded HUD resources, and headset shopping callback separation:

```bash
npx tsx --test spatial/tests/test-workspace-xr.mjs
```

All 24 focused tests passed on October 18, 2026, alongside targeted ESLint and the repository TypeScript check. These are synthetic Three.js/controller tests, not a physical Quest session. Physical headset performance and controller feel remain unverified until the checklist is run. Losing controller tracking or opening immersive browser/system UI cancels an armed teleport; it is not treated as a deliberate stick release.

The current clean-room artifact measured 5,426,232 bytes, 75,124 triangles, 61 glTF meshes, 102 material primitives, and four embedded images. These are asset counts, not a headset frame-rate measurement. Prefer the clean room over the recovered 85 MB raw mesh, use the lighter shadow configuration, and check performance on the actual Quest 3S before increasing texture resolution or adding many products.

## Renderer integration

`spatial/room/workspace-xr.ts` owns a temporary player rig, two target-ray controllers, teleport reticle, and an in-scene shopping panel. The renderer owner must call `renderer.setAnimationLoop` and invoke the module's `update()` before rendering, disable desktop camera controls during the session, render full-height walls, and supply the current canonical plan, selectable roots, floor surfaces, blocking surfaces, and navigation clearance callback. This follows the [Three.js WebXR manager API](https://threejs.org/docs/pages/WebXRManager.html) and [renderer animation loop API](https://threejs.org/docs/pages/WebGLRenderer.html).

The camera is reparented at entry and starts at local origin under the rig: `local-floor` supplies the measured head height, so no additional desktop 1.6-meter camera offset is added. The original camera parent, pose, scale, FOV, and aspect are restored on exit. Controller events, panel textures, and geometries are released on disposal. Canonical furniture coordinates and purchase state are never changed by this module.
