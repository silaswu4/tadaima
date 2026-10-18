# Platforms and user experience

Documentation baseline: October 17, 2026. This is a proposed cross-device experience grounded in the current repository and platform research. It is not a hardware test report.

## Platform contract

The complete shopping workflow must work in a browser without a native Tadaima app. Desktop and mobile provide the full baseline. Meta Quest 3S adds immersive viewing and interaction with the same underlying plan.

| Surface | Required baseline | Proposed enhancement | Current evidence |
| --- | --- | --- | --- |
| Desktop browser | Input, plan review, product comparison, editing, budget, basket review | Voice and immersive entry when supported | Existing landing hero uses Three.js and pointer hover. No full shopping flow is implemented. |
| iPhone browser | Guided capture or photo upload, measurements, plan review, touch selection, text changes, basket review | Voice; optional supported 3D viewing handoff | Existing hero has coarse-pointer rendering adjustments and touch selection. Target iPhone model and browser version are unknown. |
| Quest 3S browser | Access the saved room and inspect it through the website | WebXR immersive viewing, controller selection, object-grounded voice, optional passthrough placement | Available headset is confirmed. Actual compatibility and performance are not yet tested. |
| ASI:One | Complete the sponsor-required primary agent workflow through conversation | Cards and links to optional spatial inspection | Integration is not present. This is a separate sponsor eligibility surface. |

Quest browsing must not become a requirement for signing in, entering an address, fixing measurements, or approving a basket. ASI:One also needs its own complete conversational route if pursuing the Fetch prize; opening a custom frontend cannot be required to complete its primary workflow. [Fetch LA Hacks hackpack](https://www.fetch.ai/events/hackathons/la-hacks-ai-hackathon-2026/hackpack)

## What the repository currently implements

At the inspected baseline, `app/page.tsx` renders a single full-screen landing hero. `components/RoomHero.tsx` loads `lib/room/scene.ts`, which builds a fixed-camera living room from local GLB furniture assets and procedural pieces.

Current behavior includes:

- A straight-on room composition with monochrome surfaces, contour lines, and a floor grid.
- "Michael" on the back wall, placeholder introduction, a "Scan your room" link, and a placeholder sign-in link.
- Pointer hover and non-mouse pointer selection of furniture.
- A selected-object label displaying geometry bounding-box dimensions in centimeters and inches.
- Responsive camera aspect handling, a wider field of view on narrow screens, and a lighter rendering configuration for coarse pointers or small screens.

The displayed dimensions come from the demonstration geometry. They are not verified retailer product specifications or a measurement of the user's room. There is no implemented scan, address lookup, account flow, saved plan, voice service, WebXR session, shopping agent, or checkout behind the hero's placeholder links.

The older `HANDOFF.md` mentions Apple's room scan as an input. The later user requirement to remain web only takes precedence: the baseline is guided iPhone browser capture, not a native RoomPlan integration.

## Preserve the current design direction

The existing handoff sets a clear direction:

- Black and white, light mode.
- Paper Mono typography.
- Sentence case interface copy.
- No italics or em dashes in product copy.
- Human, direct wording without generic marketing language.
- The room itself as the visual anchor.

The stylesheet contains clay accent tokens, but their existence is not approval to turn the interface into a colorful dashboard. Extend the current visual system deliberately. Keep a strong distinction between the expressive landing illustration and evidence-heavy shopping controls, where legibility and clear status matter more than decorative treatment.

Paper's role is design and implementation craft, potentially through its MCP integration. It is not a runtime requirement for a user to view their room. Its event brief emphasizes design fundamentals, ease of use, and personal craft. [Paper LA Hacks brief](https://paper.design/la-hacks), [Paper MCP documentation](https://paper.design/docs/mcp)

## Proposed screen progression

| Screen | Main decision | Essential information |
| --- | --- | --- |
| Start | Find an apartment or capture a room | Two equally understandable paths; existing-photo fallback |
| Evidence review | Is this the correct space? | Source applicability, candidate plans, mirrored layout warning where relevant |
| Room confirmation | What measurements can we trust? | Editable outline, openings, known and uncertain dimensions |
| Brief | What should the room achieve? | Budget, style, seating, retained furniture, delivery preferences |
| Plan workspace | Which arrangement and products should we use? | Room, selection, exact product details, constraints, running cost |
| Revision review | Accept the proposed change? | Before/after item diff, savings, preserved locks, failed or unresolved checks |
| Basket review | Is this the exact purchase intent? | Product variants, latest prices, shipping/tax status, merchant grouping |
| Merchant handoff | Continue or complete checkout? | Actual cart status, user action required, explicit final purchase approval |

These are product states, not a requirement for eight separate routes. A compact workspace can cover several states if the next decision remains obvious.

## Address research experience

Accept the address and optional unit number, then show meaningful stages such as "Finding floor plans", "Comparing unit layouts", and "Ready for your review" only when those operations are actually running. Do not animate a confident reconstruction while the system is still looking for a matching source.

Show the evidence next to the candidate layout. "Building brochure, unit match unconfirmed" is more useful than a fabricated confidence percentage. If the unit cannot be identified, let the user choose a known apartment type, upload a plan, or switch to capture. Keep previous progress when switching paths.

## iPhone capture experience

The baseline sequence is:

1. Explain what to capture and what measurements will be needed.
2. Request camera permission after the user starts capture.
3. Guide the user through overlapping views with actual movement between positions.
4. Allow review and replacement of blurry or missing views.
5. Upload with visible, resumable job status where implemented.
6. Ask for anchor measurements and review the proposed room outline.

Use feature detection for camera APIs and recording formats. Safari's recording support does not make every codec, camera feature, or interruption behavior identical across iPhones. HTTPS and browser permission are prerequisites for normal camera capture. [WebKit MediaRecorder documentation](https://webkit.org/blog/11353/mediarecorder-api/)

Do not assume iPhone Safari offers the same WebXR room-scanning APIs as a native app. Native RoomPlan uses Apple's framework and supported device hardware. A third-party browser tracking SDK, if evaluated, still needs separate proof that its output supports the required room geometry and scale. [Apple RoomPlan](https://developer.apple.com/augmented-reality/roomplan/), [WebKit iOS WebXR discussion](https://bugs.webkit.org/show_bug.cgi?id=309550)

Provide clear failure recovery:

- Permission denied: upload existing photos and enter measurements.
- Interrupted recording: keep completed uploads and explain what needs recapture.
- Weak reconstruction: show the proposed outline and ask for correction rather than presenting an authoritative room.
- Long processing: allow the user to leave and reopen the job.

Apple Quick Look can display a supported USDZ asset as a native viewing handoff, but it is not a replacement for the product's custom editing, voice, and scan workflow. [Apple Quick Look](https://developer.apple.com/quick-look-gallery/), [model-viewer AR modes](https://modelviewer.dev/examples/augmentedreality/index.html)

## Shared plan, device-specific controls

The backend should own the accepted plan and its revision number. Desktop, mobile, Quest, and ASI:One send commands against that state. A device can temporarily preview a drag or proposed layout, but it should not silently overwrite a newer accepted revision.

Keep selection explicit. A request such as "replace this with a smaller one" should carry the selected object ID and plan revision. If nothing is selected, ask which item the user means. Device focus, a gaze target, and a selected furniture item are different concepts.

Use consistent actions across surfaces:

| Intent | Desktop | Mobile | Quest | ASI:One |
| --- | --- | --- | --- | --- |
| Select furniture | Click or accessible inventory list | Tap or inventory list | Controller ray or supported hand interaction | Name or numbered item |
| Request a change | Text input or voice | Text input or voice | Voice with controller/text fallback | Conversation |
| Review an alternative | Product panel and room preview | Bottom sheet and room preview | Readable panel with room preview | Product card or structured comparison |
| Accept a revision | Explicit accept action | Explicit accept action | Deliberate controller action | Explicit conversational approval |
| Review basket | Detailed grouped list | Detailed grouped list | Optional summary; flat-screen continuation available | Complete itemized conversational review |

Do not make hover the only way to discover critical product details. Provide a keyboard-accessible object list and text labels independent of the 3D canvas. Exact keyboard and assistive technology behavior remains implementation work and must be tested.

## Quest 3S experience

Start with a user-initiated WebXR entry action and feature detection. Meta documents browser WebXR and mixed-reality capabilities and provides a furniture catalog example that is relevant to this project. These establish an implementation route, not a guarantee that every optional feature works on the team's exact headset and browser build. [Meta WebXR overview](https://developers.meta.com/vr/documentation/web/webxr-overview/), [Meta mixed reality guidance](https://developers.meta.com/vr/documentation/web/webxr-mixed-reality/), [Chairs Etc. sample](https://developers.meta.com/vr/documentation/web/web-sample-chairs-etc/)

Recommended progression:

1. Open an existing saved plan in the Quest browser.
2. Enter an immersive, consistently scaled room view.
3. Select a piece and show a readable product panel.
4. Make one constrained revision and receive the same accepted result on desktop.
5. Evaluate passthrough placement, anchors, planes, or scene understanding only after the basic path works on actual hardware.

Use meters as the canonical geometry unit. A saved cloud plan does not automatically align with a physical room. Passthrough placement needs an explicit local alignment procedure, such as identifying a floor origin and wall direction and confirming scale. A device-local anchor cannot be assumed to transfer to another device merely because the plan is synchronized.

Avoid default smooth artificial locomotion. For a small demo room, standing inspection, deliberate repositioning, or teleportation is a reasonable starting recommendation. Test readable panel distance, controller targeting, recentering, session exit, and performance on the actual Quest 3S.

Quest browser camera and scene APIs have changed over time. Do not rely on old blanket claims that all camera access is impossible, or assume raw camera access will be reliable. Keep the phone-upload baseline independent of headset camera access. [Meta Browser 40.1 release reference](https://developers.meta.com/vr/downloads/package/browser/40.1/?view=full_width), [Meta camera permission investigation](https://developers.meta.com/vr/support/investigations/1557993751977106/)

## Voice behavior

ElevenLabs can provide a natural conversational voice, but the product value comes from successful room operations. Treat voice as an adapter to the same validated tools used by text. The agent should say a sofa was replaced only after the operation succeeds. It should distinguish "I found an option" from "I added it to your cart".

Authentication belongs on the server; browser clients should use the supported signed connection or token mechanism rather than receive a private API key. Voice interruptions and backend job cancellation are separate behaviors and need explicit handling. [ElevenLabs React SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react), [Tools](https://elevenlabs.io/docs/eleven-agents/customization/tools), [Authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication)

Always provide text and touch/controller fallbacks. Microphone access, audio routing, in-XR behavior, reconnects, and whether headphones are needed remain hardware test gates.

## Trust is part of the interface

Show uncertainty where it affects a decision:

- Layout evidence: exact unit versus a possible building match.
- Dimensions: measured, source-provided, inferred, or user-confirmed.
- Appearance: exact merchant model versus visual proxy.
- Price: observed price versus estimate, with observation time.
- Basket: reviewed, cart prepared, checkout opened, or purchase confirmed.
- Transaction demo: devnet or simulated action versus real settlement.

Do not publish raw room images, an exact home address, or a floor plan on a public chain. Public demos and screenshots should use a permitted sample room and avoid exposing credentials, browser session links, or private addresses. A full data retention policy is still a product decision; do not claim automatic deletion until implemented.
