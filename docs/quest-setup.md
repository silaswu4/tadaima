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

Open `http://localhost:3017/rooms` **in Meta Quest Browser on the headset**, select a room and choose **Step inside**, then **Enter VR** and allow the immersive experience. The selected room opens at `/rooms/[roomId]`; the old `/room` workspace remains diagnostic. The forwarded `localhost` is the headset's connection to the Mac; `127.0.0.1` in an unforwarded headset browser is not the Mac. These USB forwarding and remote inspection steps follow Meta's [Browser debugging guide](https://developers.meta.com/vr/documentation/web/browser-remote-debugging/).

Keep the development server and USB connection active. The physical boundary remains the headset's boundary: a reconstructed room is not automatically registered to the real room around the wearer.

## Use the room

| Input | Behavior |
| --- | --- |
| Look around | Head tracking at 1:1 metric scale, with the headset's measured eye height |
| Controller trigger on furniture | Select that stable room item and update the shopping panel |
| Left thumbstick | Walk/strafe relative to your head direction, with wall/furniture clearance and sliding |
| Use teleport in the headset menu | Switch to comfort teleport: point at clear floor, push left stick forward, then release on the valid reticle |
| Right thumbstick left/right | Turn in discrete 30-degree steps; release to turn again |
| Left controller grip | Bring the shopping panel in front of the wearer |
| Right controller grip | Hide/show the shopping panel; showing it also repositions it |
| Trigger on a product row in Shop | Choose a product preview supplied by the application |
| Trigger on a valid floor spot | Give the agent a spot for the next request, clearing an older preview. This does not teleport or start a category search. |
| Trigger on Confirm placement | Confirm that preview through the application's callback; this does not purchase furniture |
| Find chairs / rugs / lamps | Search the saved retailer catalog at your current floor spot, without leaving VR |
| Rotate 45° / Put in storage | Edit the selected unlocked piece through the same canonical server queue |
| Cancel preview | Discard the candidate before it joins the basket |
| Exit VR | Return to the website |

Controller rays respect the nearest supplied wall or furnishing. Trigger selection and locomotion are separate. Walking is the default; the headset menu retains teleport for comfort. Walking uses the existing swept desktop navigation solver at 1.3 meters/second, with thumbstick dead-zone/diagonal normalization, a capped frame delta, wall/furniture sliding and unchanged tracked eye height. Browser/system UI pauses input; center the sticks before locomotion resumes. Teleport destinations use the same room clearance checks. Moving your physical head is still physical movement, so the app's navigation checks do not replace the Quest boundary.

The agent is the primary VR flow. Shop remains optional browsing; choosing a floor spot supplies context without starting a category search. An arriving recommendation stays on Agent with its name, price and approval controls. Placement approval is bound to the previewed product, search job, room revision, price and pose; changed/cancelled previews require fresh review.

The headset menu is actual Three.js scene geometry; ordinary DOM controls are not visible inside immersive VR. It uses one 1440 × 1000 canvas texture on a level 1.04-meter panel, positioned 1.25 meters ahead and slightly below eye center. It follows physical movement and joystick translation immediately, follows larger head-yaw changes with damping and a 12-degree aiming deadzone, and recenters immediately after snap turns or teleporting. Head pitch does not tilt the panel. Its warm paper (`#f5f2eb`), brown ink (`#2b1a10`), pill controls and Inter/Inter Tight type match the room/gallery website. The canvas resolves the existing Next.js font variables and repaints after the faces load; it uses opaque surfaces for headset readability. Four tabs keep the tasks separate:

- **Shop:** Chairs/Rugs/Lamps saved-catalog presets and up to three current offers with supplied prices/details. The selected preview stays in the visible result subset.
- **Room:** Selected furniture, Rotate 45° and Put in storage. Locked furniture stays protected and explains how to unlock it on the website.
- **Agent (opens first):** Talk / Finish speaking / End conversation, with the request transcript, actual tool progress, replies and errors. The agent searches, ranks fitting in-budget pieces and shows a noncommitting preview automatically. Approve the recommendation by voice or the existing Confirm placement control, or ask for an alternative without browsing product categories. It uses the same ElevenLabs session and current scanned-room tools as the website. Voice requires configured ElevenLabs credentials and browser microphone permission; unavailable voice never disables catalog shopping. End conversation remains reachable during a shopping tool.
- **Controls:** Walking/teleport choice, controller hints and Exit VR.

Basket count/total stay in the header. A pending preview keeps Cancel preview and Confirm placement in the footer on every tab. Search/loading/error status comes from the surrounding application. Rays terminate at the exact menu cursor/hit, and share its transparent overlay rendering order; the complete menu rectangle blocks clicks through to the room, including disabled buttons and whitespace. The menu is drawn above nearby room geometry so furniture cannot clip its controls. Close or right grip hides it; left grip brings it back in front of you.

Saved-catalog presets search chairs/rugs up to $300 and lamps up to $150 using the same canonical room and fit checker. The menu does not invent retailer results or execute checkout. Confirmation requires a matching visible selected offer and application permission. It reuses its texture, redraws only when visible state/hover changes, and releases resources on disposal. This keeps the existing Quest room lighting budget unchanged.

For visual QA without a headset, open `/dev/vr-ui`. It displays the exact menu canvas with explicitly synthetic products and start/results/placement/locked scenarios. Its controls never call APIs or mutate a real room. This verifies layout and hit regions; headset readability, comfort and frame rate still need physical testing.

## Get the scanned room onto Quest

The owner-authorized cleaned scan is now included in the repository. Open `/rooms/scanned-living-room`, or choose **Scanned living room** from `/rooms`. The model, sanitized geometry and baked lighting ship with a normal checkout/deployment; no capture token is required. The original private imported room and its edits remain separate. See [published scan provenance](../public/demo/scanned-living-room/README.md).

The Mac browser's imported JSON/GLB and IndexedDB storage are **not shared** with the headset browser. Opening `/rooms` alone does not transfer a room imported on the Mac. Import the matching processed reconstruction JSON and optional clean GLB using **Open scan**, or use the private local bridge below. Successful imports persist in the headset browser's private room registry across gallery navigation and refresh. Use matching reconstruction artifacts; do not use the fragmented raw LiDAR mesh as the primary shopping room.

Browser storage is scoped to the origin: `localhost:3017` and `127.0.0.1:3017` have different saved rooms, as do different browsers. Clearing site data removes these local records. There is no account sync in this integration. See [website flow](website-flow.md) for source identity, editable drafts and the preview basket boundary.

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
http://localhost:3017/rooms#local-scan=<64-character-token>
```

The gallery bootstrap uses the fragment token to request the two artifacts with authorization headers and validates their exact matching identity before saving a private room. It selects the imported room in **Your rooms**; choose **Step inside**, then **Enter VR**. Reopening the same source preserves accepted furniture edits and basket lines.

After successful import, the bootstrap removes `local-scan` from the URL and clears a matching legacy `sessionStorage["tadaima:local-scan"]` value. It does not persist the credential in IndexedDB or create a new stored token. Refresh and navigation use the saved room artifacts instead. Failed imports leave the link available for retry. URL fragments are not sent in ordinary HTTP requests, but the token is still a credential visible to someone reading the full URL. Do not put that URL in shared screenshots or documentation.

Once the server is running and the Quest is connected, open the private scan with one command from the repository root:

```bash
npm run quest:open
```

The helper reads only `TADAIMA_LOCAL_CAPTURE_TOKEN` from the current environment or a literal assignment in the repository's `.env.local`. Use the same value configured for the server; it never evaluates the environment file. It verifies an authorized Quest model, forwards port 3017, and opens the `/rooms#local-scan=…` bootstrap using Meta's [system browser deep link](https://developers.meta.com/vr/documentation/android-apps/ps-system-deep-linking/): `com.oculus.vrshell/.MainActivity`, intent `systemux://browser`, and the URL in its `uri` extra. A generic VIEW intent reported success while the physical Quest 3S remained in another panel; directly targeting the browser Activity marked it resumed but still did not establish a visible headset window. The Horizon shell owns panel presentation. ADB's output is captured because Android can echo the private URL; the helper does not print the token. It does not install software or open a remote address. A successful launch still requires wearer confirmation that the page is visible; it does not verify room loading or immersive VR.

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
4. Left-stick walking/strafe follows the head direction, stops/slides at walls and furniture, and preserves tracked eye height. Test the menu's teleport alternative and right-stick snap-turn recentering.
5. Product cards, floor placement, and explicit placement confirmation work without leaving VR.
6. Exiting restores the previous desktop camera and controls. Re-entering and route unmount do not duplicate controllers or leave an active session.
7. Head tracking remains comfortable under the actual room's draw-call and texture load. Emulator success does not establish headset frame rate.

Automated tests cover metric teleport/snap pivot math, user-gesture entry, support and permission failures, unsafe room rejection, exact camera restoration, end/reentry, concurrent entry, disposal during pending permission and renderer initialization, current-frame ray picking, ray occlusion, tracking and browser-focus loss, destination revalidation, bounded HUD resources, and headset shopping callback separation:

```bash
npx tsx --test spatial/tests/test-workspace-xr.mjs
```

The focused XR, room-action and menu checks cover direct head-relative walking, frame-delta clamping, shared swept collision delegation, focus pause/neutral rearming, simultaneous walk/turn head-pivot preservation, bounded action dispatch and disabled-panel click-through, in addition to the earlier session/teleport/selection cases. These are synthetic Three.js/controller tests.

Physical Quest 3S connection is now confirmed: USB device authorized, browser version `154.0.0.45.15.1092497976`, local scan JSON/model reachable, JSON SHA-256 matching the saved room, and 28 captured objects. A wearer confirmed the room works; a local headset framebuffer capture showed stereo rendering of the measured room, furniture selection and controller rays. This establishes physical room rendering, not headset frame rate, shopping completion or the updated walking/controller feel. The remaining checklist requires wearer verification. Losing controller tracking or opening immersive browser/system UI cancels an armed teleport; it is not treated as a deliberate stick release.

The published clean-room artifact measures 8,553,012 bytes, 75,124 triangles, 61 glTF meshes, 102 material primitives and 5 embedded images. These are asset counts, not a headset frame-rate measurement. Prefer this cleaned room over the recovered raw mesh; keep the lighter Quest shadow configuration and verify actual device performance before increasing texture resolution or adding many products.

## Renderer integration

`spatial/room/workspace-xr.ts` owns a temporary player rig, two target-ray controllers, teleport reticle, and an in-scene shopping panel. The product engine `walk-scene.ts` adapts it for `/rooms/[roomId]`; it is the sole immersive owner on that route, rather than attaching the older walk XR controller layer simultaneously. The renderer owner must call `renderer.setAnimationLoop` and invoke the module's `update()` before rendering, disable desktop camera controls during the session, render full-height walls, and supply the current canonical plan, selectable roots, floor surfaces, blocking surfaces, and navigation clearance callback. This follows the [Three.js WebXR manager API](https://threejs.org/docs/pages/WebXRManager.html) and [renderer animation loop API](https://threejs.org/docs/pages/WebGLRenderer.html).

The XR ArrayCamera pose is read directly from its `matrixWorld` after `WebXRManager.updateCamera()`: calling `getWorldPosition()` / `getWorldQuaternion()` on that unparented camera recomputes and discards the rig-adjusted pose. Regression fixtures keep tracking-local coordinates separate from world coordinates, matching Three.js.

The camera is reparented at entry and starts at local origin under the rig: `local-floor` supplies the measured head height, so no additional desktop 1.6-meter camera offset is added. The original camera parent, pose, scale, FOV, and aspect are restored on exit. Controller events, panel textures, and geometries are released on disposal. Canonical furniture coordinates and purchase state are never changed by this module.


## Activate the real room agent

The code uses the existing ElevenLabs conversational agent and Matthew's canonical room tools. No local catalog macro is presented as an AI agent. Add `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` to the ignored `.env.local`; add `BROWSER_USE_API_KEY` for live retailer research. `ANTHROPIC_API_KEY` enables separate room-planning requests. Never commit these credentials.

After changing the agent prompt/tools, synchronize the hosted ElevenLabs configuration (editing this repository alone does not update a hosted agent):

```bash
npx tsx --env-file=.env.local backend/voice/setup-agent.ts
```

If only the API key is configured, that script creates an agent and prints its ID to save locally. Restart or reload the backend environment as appropriate, then reload the room to refresh its capabilities before entering VR. The wearer explicitly starts the microphone; browser microphone permission and live audio still require a physical check.

Say “find a comfortable chair under $200 for this room.” The agent calls the existing room search, fit/ranking and preview tools. It explains the preview and asks once before adding the approved piece. Live store research is used only when configured; saved catalog observations are identified as such. The agent never treats a preview as approval or executes payment.
