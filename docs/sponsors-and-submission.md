# Sponsors and Submission

Research snapshot: October 17, 2026. This records intended alignment and published requirements, not completed integrations or prize eligibility certification. Recheck the live briefs before submission; mentor clarification takes precedence over our interpretation.

## Sponsor Strategy

The core product is a useful furniture shopping workflow. Sponsor technologies should make that workflow demonstrably better. Using six logos is not evidence that six integrations work.

| Sponsor | Intended contribution | Concrete evidence to show | Current planning status |
| --- | --- | --- | --- |
| Paper | Design exploration and interaction craft | Designed screens and a coherent, usable room editor | Requested sponsor; design-time tool, not a required runtime dependency |
| Browser Use | Research real products, compare variants, recheck availability, prepare merchant carts | Actual browser action trace plus source-linked structured results | Requested sponsor; core shopping adapter |
| Visa | Help people discover, decide, and check out with clear user control | Shopping improvement, understandable cart review, explicit payment approval | Requested sponsor alignment; no Visa API integration established |
| Fetch.ai | Expose meaningful room-shopping actions through ASI:One | Discoverable Agentverse agent completing the primary workflow in ASI:One | Requested sponsor; eligibility adds a substantive interface requirement |
| ElevenLabs | Voice interaction grounded in the selected object and actual tool results | Spoken constraint change producing a visible, validated plan revision | Requested sponsor; text/touch fallback remains necessary |
| Solana | Enforce a useful financial agreement between distinct parties | Onchain state, a successful action, and a rejected unauthorized action | Requested sponsor; specific feature still undecided |

The highest priority remains one measured room, real product evidence, constrained replanning, and a truthful cart review. Solana proposals are evaluated separately in [Solana Options](solana-options.md).

## Paper: Best Designed Hack

Paper's event page emphasizes design fundamentals, ease of use, and personal craft. Its listed awards are $1,500, $1,000, and $500. The practical implication for Tadaima is that polished interaction matters more than a large number of generated screens. See the [Paper challenge page](https://paper.design/la-hacks) and [Paper MCP documentation](https://paper.design/docs/mcp).

Recommended evidence:

- A clear choice between address research and guided mobile capture.
- One room editor with an obvious selected item, legible dimensions, and a persistent budget.
- A revision comparison explaining what changed and which constraints stayed fixed.
- Deliberate responsive layouts for touch, desktop, and the headset.
- Honest progress, failure, measurement, and checkout states.

Paper can help author the design. There is no reason to put a design editor in the production runtime just to mention its name. Preserve the latest ASCII landing-page work, Paper Mono typography, sentence case, and restrained copy. The original pencil/blueprint room renderer is retained as earlier design context; the scaffold does not reverse the incoming homepage update.

## Browser Use: Make Browsing Produce Verifiable Results

Use Browser Use for work that actually requires interacting with merchant websites: finding product variants, reading dimension tables, checking delivery information, and preparing carts. The current documentation points to the Cloud API quickstart and structured outputs; use the currently documented interface rather than copying an old versioned example. [Cloud quickstart](https://docs.browser-use.com/cloud/quickstart), [structured outputs](https://docs.browser-use.com/cloud/agent/structured-output).

Our proposed contract should return product URLs, selected variants, observed dimensions, currency, price, availability, and observation timestamps. A valid JSON object is not proof that the extracted information is correct: keep the source evidence and reject incomplete candidates when the missing field affects fit or purchase decisions.

Recommended demonstration:

1. Request a sofa satisfying a measured space and a price constraint.
2. Show the agent using real merchant pages.
3. Return a candidate with its exact variant and source evidence.
4. Apply it at its declared dimensions.
5. Recheck the selected products before cart preparation.
6. Show the actual cart state or clearly hand the user off when login, CAPTCHA, or checkout blocks automation.

Human intervention is an expected recovery path, not a reason to fabricate success. Treat live browser URLs as sensitive access surfaces and do not publish credential-bearing session links in the repository or an unrestricted demo. [Human-in-the-loop guidance](https://docs.browser-use.com/cloud/agent/human-in-the-loop), [live preview](https://docs.browser-use.com/cloud/browser/live-preview).

The public live track is the event-level reference. No separate mandatory sponsor artifact beyond the applicable event brief was established in this research. Recheck any updated workshop instructions. [Live tracks](https://live.lahacks.com/tracks).

## Visa: Future of Shopping

The event brief evaluates innovation (25%), user experience (25%), technical execution (20%), commerce impact (15%), and trust (15%). It does not establish a mandatory Visa API integration. Our alignment is helping a shopper reach a better purchase decision across discovery, comparison, planning, and checkout. [Visa event brief](https://docs.google.com/document/d/10vXJndQUMgbbc23v5NobI69DiV04nX62XKEHViC0ndA/edit).

The strongest story is: the shopper knows the furniture fits, understands the budget and remaining unknowns, and retains final purchase authority. Show a real selected product and a real cart review, with taxes, delivery, and availability labeled as estimates or unknowns until verified.

Visa's Trusted Agent Protocol concerns recognition of legitimate shopping agents. It does not grant arbitrary access to a consumer's card, guarantee that every merchant accepts an agent, or make an unintegrated checkout a Visa transaction. Only claim use of a specific API or protocol after it is actually implemented and tested. [Trusted Agent Protocol](https://developer.visa.com/docs/trusted-agent-protocol).

Solana funds and a normal merchant card checkout are separate rails unless a specific, working bridge is demonstrated. Do not describe one as automatically funding the other.

## Fetch.ai: Eligibility Changes the Product Surface

The hard requirements are substantive: register an agent on Agentverse, implement the Agent Chat Protocol (ACP), make it discoverable and directly usable in ASI:One, perform meaningful tool execution, complete the primary workflow inside an ASI:One conversation, and publish runnable/testable source. Interactive cards and the Payment Protocol are bonus opportunities. Submit through both Devpost and the event's ASI:One Submission Agent. The hackpack lists $1,500/$1,000/$500 awards plus internship interview opportunities. [Official Fetch.ai hackpack](https://www.fetch.ai/events/hackathons/la-hacks-ai-hackathon-2026/hackpack).

### Proposed Architecture for Compliance

The ASI:One integration should call the same application services as the web app. Avoid building a disconnected chatbot that describes a plan it cannot modify.

An intended ASI:One workflow is:

1. Start from an address, supported uploaded evidence, or an existing confirmed demo room.
2. Collect the shopper's budget, style, and keep/replace constraints.
3. Execute product research and return comparable candidates.
4. Generate and summarize a constrained room plan.
5. Accept a revision such as keeping two items while reducing cost and preserving seating.
6. Present a reviewable basket and execute the supported cart-preparation action.

The exact mechanics for input attachments and review cards must be verified in the live ASI:One environment. A custom frontend cannot be required to finish the primary workflow. The Quest view can remain an optional way to inspect the same room. If the judges consider immersive placement inseparable from the primary workflow, clarify that interpretation with Fetch mentors before claiming eligibility.

### Fetch Submission Work

The submission process includes a team registration flow. The lead provides the requested team/project fields, repository, Devpost entry, and demo; teammates join using the generated team identifier. Do not consider registration complete until all required members have joined. Optional profile/shared-conversation fields do not make the substantive integration requirements optional. See the [Fetch challenge document](https://docs.google.com/document/d/18_z3Px6Vc0m6L2blLAk7DV8SelpGhoZy8t_8clSEroI/edit) and [submission process document](https://docs.google.com/document/d/1UDW-X1C24hxZviFOQzjTeh0pXRNAoflMb8lhJqZP9Z0/edit).

The published hackpack also requests an agent README containing its name/address, resource instructions, Innovation Lab categorization badges, and a 3–5 minute agent demo video. Keep this sponsor video requirement separate from the shorter general event pitch/video expectations, and verify the active submission form before recording. A single length should not be assumed to satisfy both.

Implement ACP message acknowledgment and recovery according to current documentation. Do not confuse the Agent Chat Protocol with similarly named protocols from other ecosystems. Adding x402 is neither required for ACP nor proof of using Fetch's Payment Protocol. [Fetch Payment Protocol](https://uagents.fetch.ai/docs/guides/agent-payment-protocol).

## ElevenLabs: Voice That Actually Acts

The MLH prize brief broadly rewards a meaningful use of ElevenLabs audio/voice. The useful product contribution is a conversational furniture assistant that understands the selected object, asks for missing constraints, and reports the outcome of application tools. [MLH sponsor brief](https://docs.google.com/document/d/1a9TbDI0u8P2DGFFfoGXb9zEON5vrdm5PVK9yKufYLVo/edit).

Recommended tool sequence:

1. Capture the selected item ID and current plan revision.
2. Interpret the shopper's spoken request into a typed application action.
3. Run the same deterministic validation used by text/touch actions.
4. Commit a successful revision or return a specific failure.
5. Speak the actual result after the action finishes.

Interruption of speech does not automatically cancel a running browser or reconstruction job. The UI must show the job's real state. Pass browser-safe conversation credentials rather than exposing a server API key. Test headset microphone permissions, audio routing, interruption, and reconnect behavior on the actual Quest 3S. [React SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react), [tools](https://elevenlabs.io/docs/eleven-agents/customization/tools), [authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication), [client-to-server events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-to-server-events).

## Solana: Earn the Integration

The MLH challenge is broad enough for a consumer or commerce prototype with meaningful onchain behavior. This research did not establish a mandatory custom program, mainnet payment, or specific wallet. The prize descriptions conflict: the Devpost listing refers to Unruggable hardware wallets, while the MLH brief refers to Ledger Nano S Plus. Verify the actual award with the organizers. Do not base implementation decisions on either unconfirmed hardware description. [Devpost event](https://la-ai-hackathon-2026.devpost.com/), [MLH sponsor brief](https://docs.google.com/document/d/1a9TbDI0u8P2DGFFfoGXb9zEON5vrdm5PVK9yKufYLVo/edit).

The user rejected x402 as the project direction. Two subsequent research proposals remain unapproved: sell-to-upgrade with resale escrow, or an owner-controlled spending mandate for an approved room. The latter is closer to the core shopping scope; the former creates a more distinctive circular-commerce story and a substantially larger product. See [Solana Options](solana-options.md) before implementing either.

## Event Timing and General Deliverables

The live October event schedule gives a hacking window of October 17 at noon to October 18 at noon, Pacific time. The submission cutoff is **October 18, 2026, 12:00 p.m. PDT**. Round-one judging follows around 12:30 p.m., round two around 2 p.m., with closing around 3 p.m. The event is at UCLA's James West Alumni Center. [Live schedule](https://live.lahacks.com/schedule), [event page](https://ai.lahacks.com/).

The general event material calls for an accepted, registered student team, up to four people, a public repository, a complete Devpost submission, a project description identifying relevant tracks, and a concise demo. Disclose preexisting work and distinguish the work done during the event. Do not assume the existing hero or pre-event research automatically counts as newly built work. [Devpost](https://la-ai-hackathon-2026.devpost.com/), [rules](https://la-ai-hackathon-2026.devpost.com/rules).

The rules page contained stale April scheduling language during research. Earlier calendar information also differed from the October live schedule. Use the live October deadline operationally, and ask organizers to resolve any material rule conflict. Do not silently treat stale dates as an extension.

Potential main tracks are Beyond the Digital for material XR interaction and Applied Intelligence for the shopping system. The final choice has not been confirmed. Sponsor prize stacking has not been established; do not claim that every listed award can be won simultaneously.

## Submission Checklist

All items below are pending unless separately verified in the repository or event systems.

- [ ] Confirm team roster, participant registration, and event eligibility.
- [ ] Confirm the authoritative submission cutoff and active form fields.
- [ ] Publish a runnable repository with setup, required resources, and a truthful implementation-status section.
- [ ] Attribute preexisting assets, code, and Homebuddy inspiration.
- [ ] Record the main demo showing actual behavior and clearly marked fixtures/fallbacks.
- [ ] Complete Devpost project description, screenshots, demo URL, repository URL, and track selections.
- [ ] Identify which sponsor technologies were actually used, including design-time tools.
- [ ] Verify the complete ASI:One workflow, Agentverse registration, ACP, and discovery before selecting the Fetch prize.
- [ ] Complete Fetch team registration and have every teammate join.
- [ ] Include Fetch-specific README metadata, categorization, and requested video.
- [ ] Demonstrate actual Browser Use actions and their product evidence.
- [ ] Demonstrate actual ElevenLabs voice invoking validated actions.
- [ ] If selecting Solana, show the real cluster, transactions, enforced restriction, and failure case.
- [ ] Remove credentials, private room media, exact home addresses, browser session links, and payment data from public artifacts.
- [ ] Recheck sponsor-specific requirements and any prize-stacking restriction with the current briefs.

This document is a build/submission guide. It does not state that any checklist item, sponsor integration, or financial transaction has already been completed.
