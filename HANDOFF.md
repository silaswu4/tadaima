> Historical handoff: the current project context is in [docs/README.md](docs/README.md). On October 18 the user approved an optional thin SwiftUI/RoomPlan scan companion for iPhone 14 Pro, superseding the earlier web-only restriction for this input alone. Shopping, design, and Quest remain web-based; address and browser-photo inputs remain available without tape measurements. See [native scan status](docs/native-scan.md); physical capture is not yet verified. The active repository is `silaswu4/tadaima`, while the UI still uses Michael. The original design notes below are retained for context.

# Michael: what we're building

Michael is a working name, so it may change. This is our LA Hacks 2026 project.

## The idea

A web-native VR app (it also works on phones) for remodeling and shopping for your own room.

1. **Bring your room in.** Use Apple's room scan, find your apartment's floor plan online, or upload photos. AI figures out where everything is and rebuilds the room in 3D. GPT-6 Astra does the scene building.
2. **Look around it** in VR, or on your phone by moving it around like a window.
3. **Change anything.** Point at the sofa to remove it, move it, or replace it.
4. **Say what you want** ("a green sofa under $900"). A voice agent searches the web for real products that fit those exact measurements.
5. **See it in your room** at true size, then buy it.

The hook is that everything it suggests actually fits the space it's going into.

## Tracks we're going for

All the tracks are listed at https://live.lahacks.com/tracks.

- **Paper: Best Designed Hack.** They judge on design fundamentals, ease of use, and personal craft, and they want designs that don't look AI-generated. So the UI has to be really clean and intuitive.
- **Visa: Future of Shopping.** AI-powered discovery, decision and checkout. 15% of the score is trust and privacy, so we need to be upfront about where your room scan lives and confirm before any payment.
- **Browser Use.** An agent that turns a goal into action on the web, including paying. Our furniture-search agent fits this exactly.
- **Also fits:** the "Beyond the Digital" main track (AR/VR), and MLH's ElevenLabs prize if the voice agent uses it.

## Where the landing page is at

Repo: https://github.com/silaswu4/michael. Run it with `npm install` then `npm run dev`.

Only the hero is built so far:
- **The view:** you're looking straight into a living room drawn in a black and white pencil / blueprint style. Everything is white with ink outlines on a faint floor grid.
- **Text:** "Michael" sits big on the back wall, with one line under it and a "Scan your room" button.
- **Hover:** pointing at any piece of furniture highlights it and shows what it is plus its exact size (x / y / z).
- **Copy:** all placeholder.

The rest of the page is planned but not built:
- **How it works:** three steps, scan, point and ask, buy what fits.
- **The swap:** the sofa getting replaced by options that fit. This is the key moment.
- **Trust:** what happens to your scan and how payment works.
- **Footer.**

## Design rules so far

- Black and white, light mode.
- Paper Mono for all type.
- No italics, sentence case, no em dashes.
- Copy should sound chill and human, not like marketing or an AI tagline.
