# Risks, open decisions, and evidence gates

Updated October 17, 2026. These are concrete unresolved project choices, not requests to stop all progress. Routine reversible implementation can proceed inside the confirmed scope.

## Decisions to make

| Decision | Current state | Evidence needed / recommended default |
| --- | --- | --- |
| Product name | Decided: tadaima in the repo, UI, and package | Done |
| Demo property/room | None supplied | Use a permissioned, measured room and public property evidence with sensitive details redacted |
| Merchant pair | Not selected | Favor accessible product dimensions, stable variants, usable cart flow, and asset provenance |
| Detailed room scope | Whole-unit ambition; one-room recommendation | Prove a room before multi-room topology and capture alignment |
| Reconstruction provider | Blender discussed; no deployed pipeline | Start with confirmed geometry to procedural shell; benchmark neural methods separately |
| Model/orchestration provider | GPT-6 Astra discussed through inspiration; no integration observed | Verify access, current API, outputs, latency, and cost before relying on any named model |
| Persistence/auth/jobs/storage | Unselected | Choose a minimal compatible backend and worker based on actual deployment constraints |
| Fetch prize | Desired sponsor alignment; no completed registration observed | Decide early whether to implement the complete ASI:One workflow and submission |
| Solana feature | Research complete; user choice pending | Select sell-to-upgrade or bounded mandate, or defer; do not assume approval |
| Wallet UX/provider | Unselected | Verify new-app availability, web/iPhone support, key custody, and test-network flow |
| Checkout depth | Agentic buying ambition | First prove real cart preparation and approval; actual purchases need explicit authorization |
| Team capacity and registration | Working areas assigned in [team ownership](team-ownership.md); capacity/registration not confirmed | Coordinate the shared contracts and verify actual event registration; do not infer VR experience from owning a Quest |

## Capability gates

### Address-to-unit matching

An address may identify a building without identifying the correct unit. Similar unit types, renovations, mirrored plans, missing dimensions, and inaccessible listings are expected failure cases. Success means the system presents evidence scope and gets confirmation, not that it always returns a model. Do not infer an exact plan from total square footage.

### iPhone web capture

The baseline is guided camera capture plus measurements and server processing. Native RoomPlan is outside the web-only scope; iPhone Safari support cannot be inferred from visionOS Safari. Test the actual iPhone/browser, permissions, upload limits, codec behavior, interruption, and capture quality. Reconstruction may recover useful shape without reliable absolute scale or editable semantics.

### Geometric fit

Ground dimensions separately from appearance. A plausible scene, generic asset, or world-space bounding box cannot establish the exact SKU dimensions. Define conservative tolerances and distinguish room fit from door/hallway/elevator delivery. Unknown measurements should produce an unknown or blocked result, not a green check.

### Quest 3S

Test WebXR entry, frame rate, selection, spatial alignment, microphone/voice, and comfort on the actual headset. Vendor docs and samples establish possible capabilities, not that all scene/camera features are available in the team's browser version. Make the core flow work on ordinary web screens.

### Shopping automation

Login, merchant page changes, anti-automation controls, unavailable variants, and destination-dependent fees may block a browser task. Prepare a human handoff and show what actually happened. Recheck before checkout and prevent duplicate cart mutation on retry.

### Solana settlement

Prove the selected on-chain property, such as a rejected over-budget transfer or escrow release/refund conditions. Do not claim the chain verifies pickup, product fit, delivery, retailer inventory, or card checkout. A physical-item dispute policy and release authority must be explicit if building resale escrow.

## Source conflicts and unverified claims

| Issue | Treatment |
| --- | --- |
| General event rules contain a stale April date | Prefer the live October schedule for planning and confirm with organizers if material |
| General demo and Fetch video lengths differ | Prepare the applicable deliverables; do not assume one duration satisfies both |
| MLH Solana hardware prize differs across public material | Do not promise a specific device; verify current award details |
| Homebuddy user-provided award amount and rich demo details | Preserve as attributed context where not independently established by the organizer page |
| Older Quest camera restrictions versus newer release notes | Test the actual runtime; do not universalize either old restrictions or newer support |
| Crossmint Amazon/Solana indexed quickstart returns 404 | Treat as historical lead, not a supported current production bridge |
| Reconstruction repository code license versus checkpoint license | Verify the exact selected checkpoint and dependencies, not only the top-level repository license |
| Provider/account access | A public SDK or documentation page does not establish the team's credentials or approval |

See [Research and sources](research-and-sources.md) and [Sponsors and submission](sponsors-and-submission.md) for the source-level details.

## Privacy boundaries to implement

Room photos and plans reveal private interiors; an address plus unit is directly identifying. Collect only what the feature needs, restrict project/media access, use scoped asset URLs, define retention and deletion, and redact public demo captures. Do not commit real scans, private messages, credentials, browser sessions, or personal addresses.

Never publish raw home data on-chain. Keep wallet approvals scoped to the selected operation. Do not put card details into the room plan, model prompt, logs, or Git history. Use the merchant/payment provider's intended secure flow and keep application provider keys server-side.

## Validation status

This documentation task inspects and records source code and research. It does not establish a successful application build, measured reconstruction accuracy, headset compatibility, real checkout, payment settlement, or sponsor acceptance. Record actual results with date, device/browser/version, input fixture, revision, expected behavior, observed outcome, and known limits as implementation proceeds.

The central success test remains: a user can bring in a room, understand uncertainty, revise a real source-backed furniture plan under constraints, inspect it on an available device, and reach an accurate purchase review without losing control of the decision.
