# Demo and validation plan

Documentation baseline: October 17, 2026. All steps below are proposed. No complete end-to-end demo, iPhone capture test, Quest hardware check, merchant checkout, or on-chain transfer is claimed to have passed.

## What the demo should prove

The audience should see one person's room become a constrained, shoppable plan and then see the agent solve a meaningful change without breaking the user's requirements.

The recommended center of gravity is:

> "Keep my sofa and desk. Make the room $300 cheaper while keeping seats for four."

That request connects geometry, product research, budgeting, existing possessions, voice or text, and an actionable basket. It is a stronger proof than showing a reconstruction and then listing sponsor logos.

## Recommended three-minute main demo

| Time | Action on screen | What it proves |
| --- | --- | --- |
| 0:00–0:15 | Show the starting room and the user's goal. State what stays, the spending limit, and the seating requirement. | A concrete problem and visible constraints. |
| 0:15–0:35 | Show the two entry choices. Use a permitted, prepared address example and confirm the matching plan; briefly show that the iPhone capture route is available. | Two honest ways to establish the space. |
| 0:35–0:55 | Open the confirmed room. Show one anchor measurement, the plan's evidence, and the retained sofa and desk. | Grounding and editable structure rather than an unverified render. |
| 0:55–1:20 | Present the initial shopping plan and source-linked products. Open one exact variant, dimensions, observation time, and budget subtotal. | The room is connected to real product evidence. |
| 1:20–1:50 | Enter Quest inspection if the tested hardware path is reliable. Select an item and give the constrained revision by voice; desktop text remains available. | Spatial inspection and object-grounded interaction with the shared plan. |
| 1:50–2:20 | Show the result and a compact diff: changed products, savings, four-seat check, preserved locks, and any unresolved estimate. | The agent can revise a whole room while respecting constraints. |
| 2:20–2:45 | Recheck the exact basket and prepare a merchant cart, or show the explicit merchant handoff if cart automation is unavailable. | An actual commerce action with an accurate completion state. |
| 2:45–3:00 | Show the final room and explain the one differentiating outcome. Mention the implemented sponsor roles and the current limitation. | A clear, honest conclusion. |

The timings are a rehearsal target, not a reconstruction latency claim. If ingestion takes minutes, use an already processed room and state when it was captured. A second short recording can demonstrate capture and processing without pretending a long job completed instantly.

The final submission video should be edited to the actual event's required length. The current public hackathon materials describe a 2–3 minute demo; the Fetch hackpack separately requests a 3–5 minute agent video. Prepare the applicable deliverables rather than assuming one length satisfies both. Recheck live instructions before submission. [LA AI Hackathon Devpost](https://la-ai-hackathon-2026.devpost.com/), [Live schedule](https://live.lahacks.com/schedule), [Fetch hackpack](https://www.fetch.ai/events/hackathons/la-hacks-ai-hackathon-2026/hackpack)

## Inputs and assets to prepare

- One room the team is authorized to photograph and show publicly.
- A manually verified reference outline with wall dimensions, door location and swing, window locations, and the furniture that must stay.
- A permitted public address or sample listing for the address path, with a known matching plan and saved source references.
- A capture set from the team's actual iPhone, including one deliberately poor capture for recovery testing.
- Approximately 12–20 curated product candidates across two merchants, each with a source URL, exact variant, dimensions, price, and observation time.
- Correctly scaled GLBs or clearly labeled proxies, with any required licenses and attribution retained.
- A repeatable initial plan in which at least one lower-cost valid alternative exists.
- A ready-to-open flat-screen session and Quest session using the same plan ID.
- A sanitized fallback recording and prepared state for network or hardware failure, visibly described as such.

Do not use personal home addresses, private account pages, payment details, or session credentials in the public recording.

## Address-path proof

A good address demo shows the uncertainty boundary rather than hiding it:

1. Enter the permitted sample address and unit reference.
2. Show the source the agent found and whether it applies to the exact unit or only a unit type.
3. Confirm the correct layout, including orientation or mirrored variants.
4. Inspect one dimension from source evidence and one user-confirmed measurement.
5. Accept the room model and continue into the same shopping workspace used by the capture path.

If the source is seeded for reliability, label it as a prepared example. If live search fails, show the upload or capture fallback. Do not render a different apartment and claim success.

## Capture-path proof

1. Open the mobile web capture page on the actual iPhone.
2. Grant permission and gather overlapping views while moving through the room.
3. Review the capture and upload it.
4. Show a real asynchronous processing state.
5. Confirm anchor measurements and correct the proposed outline if necessary.
6. Open the resulting room on desktop using the same saved state.

This proves a browser input route. It does not prove native RoomPlan, LiDAR, or survey-grade measurement. Those claims require a different implementation and evidence. [Apple RoomPlan](https://developer.apple.com/augmented-reality/roomplan/), [WebKit recording guidance](https://webkit.org/blog/11353/mediarecorder-api/)

## Fetch / ASI:One side demonstration

If pursuing the Fetch prize, the custom frontend cannot be the only working product. Its event materials require an Agentverse-registered, discoverable agent using AgentChatProtocol, with meaningful work available through ASI:One. The primary workflow must be completable there. [Fetch hackpack](https://www.fetch.ai/events/hackathons/la-hacks-ai-hackathon-2026/hackpack), [Fetch challenge brief](https://docs.google.com/document/d/18_z3Px6Vc0m6L2blLAk7DV8SelpGhoZy8t_8clSEroI/edit)

Prepare a separate complete conversational demonstration:

1. Discover and open the registered agent in ASI:One.
2. Start from a sample room or supply the room details through supported messages.
3. Set budget, seating, and retained furniture.
4. Receive an actual researched comparison with product links and dimensions.
5. Request the same constrained revision used in the main demo.
6. Review the full updated basket and complete cart preparation or an accurate merchant handoff through the conversation.

Opening an optional 3D view is fine; requiring that view to perform the planning or review step creates an eligibility risk. Do not substitute an ASI:One link that merely launches the website. Confirm any ambiguous interpretation with the sponsor before relying on prize eligibility.

## Optional Solana proof

The final Solana direction is still open. Do not put an unchosen blockchain feature into the primary three-minute story as if it were a confirmed requirement. x402 was rejected.

If the team chooses a **spending mandate**, demonstrate a useful enforcement boundary: an approved transaction succeeds, an oversized or wrong-recipient transaction is rejected, and revocation blocks a later attempt. Be precise about what the chosen program actually enforces; room fit, SKU identity, and delivery are not automatic consequences of a token transfer.

If the team chooses **sell-to-upgrade**, demonstrate one devnet furniture resale escrow: funds are committed, a human pickup confirmation releases funds, and only settled proceeds increase the spendable budget. Expected resale proceeds remain separate. Do not imply integration with a third-party marketplace or a real furniture sale.

Devnet actions should be labeled throughout. Neither option proves that arbitrary furniture merchants accept Solana or that a devnet payment purchased a real product.

## Acceptance checks

These are proposed release checks. Record the actual result, device, browser version, and evidence when run. A table entry is not a passed test.

| Area | Check | Pass condition |
| --- | --- | --- |
| Address evidence | Research a matching and a nonmatching unit example | The exact match can be confirmed; the nonmatch stays unconfirmed and offers a fallback. |
| Capture permission | Deny camera permission | Existing-photo upload or manual measurement remains usable without losing the user's brief. |
| Capture recovery | Interrupt recording or upload | Completed material is preserved where implemented; the user sees a specific recovery action. |
| Geometry | Compare the reconstructed target room to the manually measured reference | Differences are visible and within the team's explicitly declared tolerance before shopping claims are made. |
| Product scale | Place a product near a tight boundary | Its real dimensions govern the check; the model is not silently shrunk. |
| Fixed structure | Move an item through a wall, doorway swing, or required passage | The chosen constraint is rejected or flagged with a concrete explanation. |
| Locked objects | Ask for a cheaper plan while keeping the sofa and desk | Locked item identities and required positions are preserved. |
| Functional needs | Require seating for four | The result retains four justified seats or reports the constraint as unresolved. |
| Budget | Lower the target by $300 | The diff reconciles item changes and savings; unknown shipping/tax is separated. |
| Product evidence | Open one exact variant and source URL | Dimensions, variant, price, and observation time correspond to that product. |
| Stale evidence | Recheck a product with a changed price or unavailable variant | The basket updates or blocks continuation; it does not retain the old claim silently. |
| Revision ordering | Edit the same plan from two devices | A stale mutation cannot silently overwrite a newer accepted revision. |
| Voice grounding | Say "replace this" with and without selection | The selected object is targeted; missing selection triggers clarification. |
| Tool truth | Force a shopping or placement tool failure | Voice and UI report failure; neither claims completion. |
| Mobile interaction | Select, compare, revise, and review on the team's iPhone | The core workflow is possible without hover or a native app. |
| Quest entry | Enter, recenter, select, and exit on Quest 3S | Supported features work on the actual browser build, with a flat-screen fallback. |
| Quest scale | Compare a known object dimension in immersive viewing | The team's scale calibration procedure is repeatable; visual impression alone is not the measurement. |
| Cart state | Prepare a merchant cart or perform the documented handoff | The UI identifies the actual state and exact variants; purchase is not claimed prematurely. |
| Payment approval | Reach the final purchase boundary | A deliberate user action is required before any real payment. |
| ASI:One | Perform the complete primary agent flow in conversation | Meaningful planning, comparison, revision, and basket review work without a required custom UI. |
| Public demo | Review the recording and visible browser state | No private addresses, payment data, credentials, or sensitive session URLs appear. |

Do not invent a millimeter accuracy threshold or a Quest frame-rate result before measuring. Set a useful demo tolerance and performance target after the first real reconstruction and hardware benchmark, then report observed results against it.

## Failure and fallback script

| Failure | Honest fallback |
| --- | --- |
| Public floor plan cannot be found | "We could not verify this unit. Upload a plan or use guided capture." |
| Reconstruction is slow | Open a previously processed sample and show the real job separately. |
| Reconstruction geometry is poor | Correct the outline with measurements and label inferred dimensions. |
| Merchant blocks automation or requires login | Preserve the plan and provide the exact merchant link or user browser handoff. |
| Product goes out of stock | Show the failed recheck and request approval for an alternative. |
| Quest session fails | Continue the same plan on desktop; use the labeled hardware recording only if needed. |
| Microphone or audio fails | Use the same command through text with no loss of room state. |
| Network is unavailable | Use a clearly labeled prepared snapshot or recording; do not claim live research or checkout. |
| Optional Solana feature is incomplete | Omit that feature from claims and keep the room-shopping flow intact. |

## Submission review

Before recording, freeze a repeatable plan and check all products again. Before submitting, recheck the live event instructions, public repository access, required project description, sponsor-specific registration, and final video links. Keep pre-existing work disclosure accurate: this repository already contained the landing hero before this documentation was added. Only claim the work actually completed during the eligible period. The public rules contain date inconsistencies, so prioritize the current October live schedule and organizer clarification for cutoff timing. [Live schedule](https://live.lahacks.com/schedule), [Devpost rules](https://la-ai-hackathon-2026.devpost.com/rules)
