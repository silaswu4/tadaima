# Project context and decision ledger

Updated October 17, 2026. This is the compact handoff for continuing the work without reconstructing the conversation.

## What we are building

A web-native agentic furniture-shopping experience: bring in your own room, establish its dimensions, furnish it with real products, revise the whole plan against constraints, inspect it on desktop/mobile or in a Meta Quest 3S, and prepare purchases for explicit review.

The product thesis is that a shopping agent should understand the room and the complete basket. An attractive rendering alone does not establish fit, stock, the correct variant, delivery feasibility, or final cost. The proposed differentiator is a spatially grounded, editable shopping plan whose commercial facts remain traceable to retailer evidence.

The user wants an ambitious hackathon project inspired by Homebuddy, with meaningful alignment to **Paper, Browser Use, Visa, Fetch, ElevenLabs, and Solana**. Integrations should earn their place in the flow. Listing a sponsor SDK is not itself a useful feature.

## Confirmed user requirements

| Requirement | Consequence |
| --- | --- |
| Stay web-only | No required native iOS, Android, or Quest application |
| Work on web and mobile | Core planning and shopping cannot require a headset |
| Available headset is Meta Quest 3S | Test that device; do not assume a Quest 3 demonstration proves compatibility |
| Available scanning phone is an iPhone | Baseline capture must work in an iPhone browser |
| Offer address and unit number onboarding | Research publicly available plans/photos and ask the user to confirm the match |
| Offer mobile web room scanning | Use guided camera capture and measurements; native Apple RoomPlan is outside the baseline |
| Reconstruct using floor plans and photos, with Blender in the discussed pipeline | Preserve an editable room representation and export a browser-friendly asset |
| Explore substantive Solana integration | Research a useful role; the final feature has not been selected |
| Reject the x402 agent-payment direction | Do not reintroduce it as an accepted requirement |
| Document everything and push it to `silaswu4/tadaima` | Preserve decisions, uncertainty, sources, and actual repository state |

The user has assigned four working areas: project lead in `backend/`, Matthew in `reconstruction/`, Angelina in `frontend/`, and Silas in `spatial/`. See [team ownership](team-ownership.md). No actual apartment address, confirmed merchant list, event registration status, implementation deadline allocation, model provider credentials, wallet provider, or final Solana choice has been supplied in the material captured here.

## Recommended product baseline

These are synthesis and implementation recommendations, not additional user approvals:

- One confirmed room as the detailed shopping demo, even if an apartment-wide outline is available.
- Two real merchants and roughly 12–20 prepared, source-linked furniture assets to constrain the demo.
- One versioned room plan shared by desktop, mobile, Quest, voice, and the Fetch agent interface.
- Preserve fixed fixtures and user-locked items during revisions.
- Make the key interaction a constrained change such as: “Keep this sofa and my desk, make the room $300 cheaper, and preserve seating for four.”
- Treat final merchant checkout and payment as a separate explicit approval boundary.
- Build a complete text/touch path first, with Quest immersion and voice as additional interfaces.
- If targeting the Fetch prize, expose the complete primary workflow through ASI:One using the same backend, not a chat link that forces users into the custom frontend.

## Evolution of the idea

1. **Starting point:** Homebuddy-style property research, 3D reconstruction, furnishing, cost tracking, and a walkthrough.
2. **Product expansion:** Add an agentic shopping loop, voice, real retailer research, and Quest 3S inspection while keeping web/mobile compatibility.
3. **Input expansion:** Offer both address-based discovery and phone-based capture.
4. **Platform correction:** Keep the app web-only. An iPhone webpage cannot simply invoke native RoomPlan or assume standard iPhone WebXR room scanning.
5. **Commerce exploration:** The user proposed x402 agent payments on Solana, then explicitly rejected that direction.
6. **Deeper Solana research:** Explore either a sell-to-upgrade furniture loop with escrow or a bounded purchase mandate. Both remain proposals; no final selection was recorded.
7. **Repository handoff:** Continue in `silaswu4/tadaima`, which currently contains a stylized Three.js hero rather than the proposed application.
8. **Team scaffold:** Split work into backend, reconstruction, frontend, and spatial folders. The later user correction assigns Angelina the product screens and Silas the spatial frontend.
9. **Concurrent repository update:** Preserve the incoming ASCII landing hero from `34e581c` in `spatial/` and compose it from `frontend/`. Keep the earlier pencil-room renderer available; do not overwrite the newer work during scaffolding.

## Solana status at handoff

The most creative proposed extension is **sell-to-upgrade**: mark existing furniture for sale, escrow a participating buyer's USDC, release funds after agreed pickup confirmation, and add only settled proceeds to the makeover budget. This is a separate marketplace/escrow scope, not a built capability.

The narrower proposed alternative is **approve this room**: the owner grants an agent a capped, revocable spending allowance with permitted recipients using an established Solana wallet primitive such as Squads. On-chain restrictions can constrain money movement; they cannot establish furniture fit, stock, delivery, or merchant order semantics.

The user has not selected either proposal. [Solana options](solana-options.md) preserves the research and tradeoffs. Generic reimbursement, furniture NFTs, a new token, yield, or paid internal agent calls do not establish the desired product differentiation.

## What not to claim

- That entering any address reliably reconstructs its exact unit.
- That guided web capture is a native LiDAR room scan.
- That inferred geometry has measurement-grade accuracy.
- That a generic GLB is the exact retailer SKU or that model bounding boxes are verified product dimensions.
- That price excludes all unknown costs while still calling it the final total.
- That Browser Use bypasses login, CAPTCHA, payment approval, or merchant restrictions.
- That Visa's event challenge requires or proves access to a particular Visa payment API.
- That stablecoin transfers automatically purchase from arbitrary card-only furniture retailers.
- That the proposed headset, voice, capture, or sponsor integrations have already been tested.
- That the Homebuddy comparison establishes a wholly original category. Similar spatial shopping experiences exist.

## Resume checklist

Read the [actual implementation inventory](implementation-plan.md), choose one measured demo room, and implement a fixture-backed room-plan-to-viewer slice. Establish item IDs, source evidence, and constraints before connecting autonomous browsing. Choose a Solana concept only after the core flow and sponsor eligibility are understood. Use the source register for capability checks rather than treating old conversation suggestions as platform guarantees.
