# Research and Sources

Research consolidated October 17, with native-capture references updated **October 18, 2026**. This register captures the public evidence used during product research. It is not a statement that every integration is implemented, available to our account, or tested on team hardware. Recheck deadlines, eligibility, API versions, pricing, access, and licenses before depending on them.

The conversation contains three types of material: explicit user requirements, research findings from public sources, and proposed product extensions. Source links establish capabilities and constraints; they do not turn a proposal into an approved feature. The user has now approved an optional thin SwiftUI/RoomPlan capture companion for iPhone 14 Pro. Shopping, design, and Meta Quest 3S remain web-based; address research and browser-photo capture remain available without tape measurements.

## Evidence and uncertainty rules

- Prefer current official event pages, vendor documentation, original research, and source repositories.
- Preserve source scope and date. A general capability or an old quickstart does not prove current access or production readiness.
- Distinguish measured dimensions, source dimensions, estimates, and user confirmations.
- A public listing, retailer URL, structured agent response, or live browser trace is evidence to inspect, not a guarantee of truth.
- Record conflicts rather than silently choosing whichever source is most convenient.
- No raw private inbox content, personal contact details, user room photographs, or home addresses belong in this public repository.

## Event and submission

| Source | What it supports | Qualification |
| --- | --- | --- |
| [LA Hacks AI event](https://ai.lahacks.com/) | Event identity and public overview | Use the live portal for operational changes |
| [Live event portal](https://live.lahacks.com/) | Current on-site information | Recheck during the event |
| [Live schedule](https://live.lahacks.com/schedule) | October 17–18, 2026 schedule; hacking noon Saturday to noon Sunday and subsequent judging | The researched submission cutoff is October 18 at noon PDT; recheck before submission |
| [Tracks and sponsor challenges](https://live.lahacks.com/tracks) | Main tracks and sponsor entry points | Do not infer that every sponsor prize stacks |
| [Devpost event](https://la-ai-hackathon-2026.devpost.com/) | Submission portal and event requirements | Complete the actual submission, not only a repository push |
| [Devpost rules](https://la-ai-hackathon-2026.devpost.com/rules) | Eligibility, team and originality requirements | Research found a stale April date on this page; the October live schedule is the operational reference, and organizers resolve conflicts |

The researched event requirements include an eligible in-person student team of at most four, a public repository, project description, a short demo, and disclosure of pre-existing work. These are a preparation summary, not a substitute for the current official rules. Sponsor-specific entries may require additional submissions.

## Sponsors and tools

### Paper

- [Paper at LA Hacks](https://paper.design/la-hacks): sponsor design challenge, judging emphasis, and event offer. Research identified design fundamentals, ease of use, and personal craft as core criteria. Paper is a design workflow tool; a runtime SDK is not needed merely to use it in the project.
- [Paper MCP documentation](https://paper.design/docs/mcp): supported design-tool integration. Do not describe Paper as the runtime room planner or geometry engine.

### Browser Use

- [Cloud quickstart](https://docs.browser-use.com/cloud/quickstart): current hosted-agent entry point; research favored current v4 examples over older v2 examples.
- [Structured output](https://docs.browser-use.com/cloud/agent/structured-output): extraction into a schema. Valid JSON does not independently verify a price, dimension, or variant.
- [Live preview](https://docs.browser-use.com/cloud/browser/live-preview): progress and inspection. Treat session-bearing URLs as sensitive rather than publishing them in demo logs.
- [Human in the loop](https://docs.browser-use.com/cloud/agent/human-in-the-loop): handoffs for authentication and interactive obstacles. A product should not assume every merchant is fully automatable.

### Visa

- [Official event challenge brief](https://docs.google.com/document/d/10vXJndQUMgbbc23v5NobI69DiV04nX62XKEHViC0ndA/edit): Future of Shopping criteria. Research recorded innovation 25%, user experience 25%, technical implementation 20%, commerce impact 15%, and trust/privacy 15%. No mandatory Visa API integration was identified in that brief.
- [Trusted Agent Protocol](https://developer.visa.com/docs/trusted-agent-protocol): recognition and trust mechanisms for agent activity. This does not establish universal merchant acceptance or provide a ready-to-use credential for arbitrary purchases.

### Fetch.ai

- [Official challenge brief](https://docs.google.com/document/d/18_z3Px6Vc0m6L2blLAk7DV8SelpGhoZy8t_8clSEroI/edit): Agentverse registration, Agent Chat Protocol support, ASI:One usability, and substantive execution requirements.
- [LA Hacks hackpack](https://www.fetch.ai/events/hackathons/la-hacks-ai-hackathon-2026/hackpack): sponsor setup and entry guidance. Research identified a complete primary workflow usable from ASI:One, without requiring a custom frontend, as a critical eligibility constraint. Confirm the mentor's interpretation if the proposed visual companion is ambiguous.
- [Submission instructions](https://docs.google.com/document/d/1UDW-X1C24hxZviFOQzjTeh0pXRNAoflMb8lhJqZP9Z0): additional submission-agent and team-registration steps. Devpost alone is insufficient for this sponsor workflow.
- [Agent Payment Protocol](https://uagents.fetch.ai/docs/guides/agent-payment-protocol): optional payment functionality. It is distinct from Agent Chat Protocol and does not become integrated merely by adding x402.

### ElevenLabs and MLH

- [MLH sponsor-prize brief](https://docs.google.com/document/d/1a9TbDI0u8P2DGFFfoGXb9zEON5vrdm5PVK9yKufYLVo/edit): event-specific ElevenLabs and Solana opportunities. Prize descriptions should be rechecked; research found different hardware-wallet descriptions across event materials.
- [ElevenLabs React library](https://elevenlabs.io/docs/eleven-agents/libraries/react): web voice-client integration.
- [Agent tools](https://elevenlabs.io/docs/eleven-agents/customization/tools): tool invocation capabilities. Successful speech must follow successful backend execution.
- [Client-to-server events](https://elevenlabs.io/docs/eleven-agents/customization/events/client-to-server-events): conversation state and client events. Interrupting speech is not proof that an asynchronous backend job was canceled.
- [Authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication): authenticated sessions and server-issued credentials; never expose the provider API secret in browser code.

## Homebuddy and market context

| Source | Supported finding | Boundary |
| --- | --- | --- |
| [Homebuddy organizer gallery](https://cerebralvalley.ai/e/openai-gpt-6-astra-sf/hackathon/gallery/41) | Homebuddy, its team, its spatial furniture-design premise, and its placement at the September 8, 2026 GPT-6 Astra SF hackathon | The user's richer demo account is not entirely independently verified by this gallery page |
| [Homebuddy demo link supplied by the user](https://youtu.be/RpraWKe9crI) | Reference for the described demonstration | Do not claim the video was independently watched or benchmarked in this documentation |
| [IKEA Kreativ help](https://www.ikea.com/us/en/customer-service/knowledge/articles/2cf21206-86a9-44a6-bc3f-8ebc8d838b0d.html) and [additional IKEA help](https://www.ikea.com/gb/en/customer-service/knowledge/articles/3639b465-gf3f-4f4d-8d60-41213db7df69.html) | Existing room-design and capture-to-shopping capabilities | Do not claim room scanning plus furniture visualization is a new category |
| [Wayfair Muse announcement](https://www.aboutwayfair.com/category/company-news/wayfair-introduces-new-ai-powered-tool-muse-to-inspire-and-personalize-the-home-shopping-experience) | Shoppable AI-assisted home inspiration | Inspiration and precise measured planning are different capabilities |
| [Wayfair spatial computing account](https://www.aboutwayfair.com/careers/tech-blog/spatial-an-evolution-in-computing) | Existing immersive/spatial furniture-shopping work | A headset alone is insufficient differentiation |
| [Amazon shopping assistant update](https://www.aboutamazon.com/news/retail/amazon-rufus-ai-assistant-personalized-shopping-features) | Existing agentic discovery and shopping behavior, including the assistant's evolving branding | Research found the May 2026 Alexa for Shopping renaming; avoid presenting old Rufus branding as a current universal product name |
| [West Elm measure-for-delivery guidance](https://www.westelm.com/pages/ideas-and-advice/measure-for-delivery/) | Doors, stairs, hallways, and elevators affect delivery | Fitting inside a room does not establish that the item can reach it |

The user reported Homebuddy's approximately $5,410 demo basket, style presets, Blender reconstruction, explode view, first-person controls, $25,000 credits award, and future ordering vision. Treat these as user-provided context unless independently verified from the relevant primary record. The user also reported the repository `areibman/homebuddy` as unavailable. This project must not imply code reuse or independently verified access to that repository.

The proposed differentiation is a constrained, evidence-backed whole-room shopping loop: preserve selected existing items, preserve functional requirements, revise a budget, compare actual products, and prepare reviewed carts. It remains a product thesis until demonstrated.

### Research on AR and shopping

- [Tan, Chandukala, and Reddy, Journal of Marketing](https://journals.sagepub.com/doi/abs/10.1177/0022242921995449): evidence on AR in retail. The researched setting is not a universal furniture experiment; do not translate its reported associations into a guaranteed furniture conversion or return-rate claim.
- [Pfaff and Spann, Psychology & Marketing](https://onlinelibrary.wiley.com/doi/full/10.1002/mar.21874): context can affect AR product perceptions and purchase intentions. Immersion can reveal an unfavorable fit as well as encourage a purchase.

## Address lookup and scene reconstruction

- [Apartments.com unit-level content FAQ](https://propertyhelp.apartments.com/article/1019-unit-level-content-faqs): exact units and model plans are distinct source scopes.
- [Apartments.com models and units guidance](https://propertyhelp.apartments.com/article/1073-how-do-i-add-update-or-hide-models-and-units-canada): model/unit publishing structure; geographically specific guidance is illustrative rather than a promise of identical data access everywhere.
- [Zillow rentals feed integrations](https://www.zillowgroup.com/developers/api/rentals/rentals-feed-integrations/): inbound listing-publisher integration, not a universal outbound address-to-plan API.
- [Plan2Scene repository](https://github.com/3dlg-hcvc/plan2scene), [scene format](https://github.com/3dlg-hcvc/plan2scene/blob/main/docs/md/scene_json_format.md), and [paper](https://arxiv.org/abs/2106.05375): floor-plan/photo reconstruction research and useful structured-scene concepts. Inputs and research setup require adaptation.
- [CubiCasa5K](https://github.com/CubiCasa/CubiCasa5k): floor-plan analysis dataset and reference implementation. Check the old implementation stack and distinct artifact licenses before adoption.
- [MapAnything](https://github.com/facebookresearch/map-anything): multi-view geometric reconstruction. Check the exact checkpoint; the Apache checkpoint and other available weights do not necessarily share terms.
- [VGGT](https://github.com/facebookresearch/vggt): multi-view geometry and camera estimation. Distinguish original weights from the commercial variant and inspect current licenses.
- [COLMAP](https://github.com/colmap/colmap): established multi-view reconstruction reference. Overlap, texture, and metric scaling remain practical requirements.
- [Metric3D paper](https://arxiv.org/abs/2307.10984): research context for metric depth and scale. Learned estimates should still be checked against room measurements.
- [Blender mesh API](https://docs.blender.org/api/current/bpy.types.Mesh.html) and [pipeline capabilities](https://www.blender.org/features/pipeline/): procedural scene construction and export capabilities.
- [Khronos glTF overview](https://www.khronos.org/gltf/) and [coordinate-system specification](https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/Specification.adoc#34-coordinate-system-and-units): portable assets, meter units, and coordinate conventions.
- [Shopify product media types](https://help.shopify.com/en/manual/products/product-media/product-media-types): evidence that some merchant workflows support 3D media; not proof that arbitrary retailer models can be scraped, reused, or accurately identified.

See [Capture and Reconstruction](capture-and-reconstruction.md) for the proposed pipeline, fallback behavior, and uncompleted verification gates.

## Mobile web and Quest

- [WebKit MediaRecorder](https://webkit.org/blog/11353/mediarecorder-api/): Safari media capture baseline; feature-detect formats and test actual devices.
- [WebKit iPhone WebXR issue](https://bugs.webkit.org/show_bug.cgi?id=309550): evidence against treating iPhone immersive WebXR as a supported baseline. visionOS support does not establish iPhone support.
- [Apple RoomPlan](https://developer.apple.com/augmented-reality/roomplan/) and [multiroom scanning](https://developer.apple.com/documentation/roomplan/scanning-the-rooms-of-a-single-structure): capabilities behind the approved optional native capture input; they do not make Safari a RoomPlan scanner. See [native scan status](native-scan.md) for implementation versus physical-device evidence.
- [Apple's official RoomCaptureView sample](https://developer.apple.com/documentation/roomplan/create-a-3d-model-of-an-interior-room-by-guiding-the-user-through-an-ar-experience): requires a physical LiDAR device. Simulator/build success does not verify scanning.
- [Surface polygon corners](https://developer.apple.com/documentation/roomplan/capturedroom/surface/polygoncorners) and [parent identifiers](https://developer.apple.com/documentation/roomplan/capturedroom/surface/parentidentifier): corners use local plane coordinates; the parent associates an opening/window with its wall. Import must preserve transforms and identity rather than guessing screen-space geometry.
- [Apple DTS clarification on wall surfaces](https://developer.apple.com/forums/thread/837547): Apple staff confirms that RoomPlan returns estimated planes without wall thickness or an interior/exterior designation. Any added wall thickness and extrusion convention are modeling assumptions, not sensor measurements or guaranteed inward normals.
- [RoomCaptureView processing delegate](https://developer.apple.com/documentation/roomplan/roomcaptureviewdelegate) and [WWDC23 enhancements](https://developer.apple.com/videos/play/wwdc2023/10192/): use the final processed result, not an intermediate rectangle or stale scan; local multiroom scans need a common AR session or relocalization before merging.
- [Apple Quick Look](https://developer.apple.com/quick-look-gallery/) and [model-viewer AR examples](https://modelviewer.dev/examples/augmentedreality/index.html): viewing handoffs and distinct rendering modes; not a semantic room-scanning API.
- [Google WebXR requirements](https://developers.google.com/ar/develop/webxr/requirements), [ARCore comparison](https://developers.google.com/ar/develop/webxr/arcore-comparison), and [Hello WebXR](https://developers.google.com/ar/develop/webxr/hello-webxr): Android/browser capability references. Support varies; Android is not the team's confirmed capture device.
- [Raw Camera Access specification](https://immersive-web.github.io/raw-camera-access/): proposed/implemented API semantics. A specification is not evidence of support on every target device.
- [8th Wall repository](https://github.com/8thwall/8thwall) and [engine documentation](https://github.com/8thwall/8thwall/blob/main/packages/engine/README.md): post-hosted-platform community tooling. Core code and SLAM binary licensing require separate attention.
- [Zappar Instant World Tracking](https://docs.zap.works/universal-ar/threejs/tracking/instant-world-tracking/): cross-browser positional tracking with setup/scale assumptions; not automatic full-unit reconstruction.
- [Meta WebXR overview](https://developers.meta.com/vr/documentation/web/webxr-overview/), [mixed reality](https://developers.meta.com/vr/documentation/web/webxr-mixed-reality/), and [Chairs Etc. sample](https://developers.meta.com/vr/documentation/web/web-sample-chairs-etc/): Quest web interaction references.
- [Meta Browser 40.1 notes](https://developers.meta.com/vr/downloads/package/browser/40.1/?view=full_width) and [camera permission investigation](https://developers.meta.com/vr/support/investigations/1557993751977106/): camera support changed over time and can encounter device/browser-specific problems. Test the actual Quest 3S; do not promise universal raw camera access.
- [Immersive Web SDK scene understanding](https://iwsdk.dev/guides/11-scene-understanding.html): reference for scene surfaces and immersive interactions. Local spatial alignment still requires implementation.

## Solana: meaningful product options and constraints

The user rejected x402 as the project direction. Later research proposed sell-to-upgrade proceeds and constrained purchase mandates; neither is an approved implemented feature merely because it appears here. See the Solana options document for the decision boundary.

### Permissions, wallets, and escrow

- [Squads spending-limit overview](https://docs.squads.so/main/navigating-your-squad/settings/spending-limits), [developer reference](https://docs.squads.so/main/development/reference/spending-limits), [v4 source](https://github.com/Squads-Protocol/v4), and [spending-limit execution source](https://raw.githubusercontent.com/Squads-Protocol/v4/main/programs/squads_multisig_program/src/instructions/spending_limit_use.rs): enforceable limits can constrain token, amount, authorized member, period, and allowed destinations. An empty destination list is not a merchant allowlist. A furniture-specific SKU, plan revision, or fit rule requires additional application or program logic.
- [SPL token delegation](https://solana.com/docs/tokens/basics/approve-delegate) and [spend permissions](https://solana.com/docs/payments/advanced-payments/spend-permissions): bounded/revocable delegation primitives. Basic token delegation does not encode arbitrary recipient, expiry, product, and delivery rules; approved delegates can have transfer/burn authority within the applicable token rules.
- [How payments work](https://solana.com/docs/payments/how-payments-work): settlement primitives. On-chain settlement does not reverse already completed merchant purchases or verify physical delivery.
- [Delivery-versus-payment](https://solana.com/docs/defi/dvp-program): token exchange primitives; two on-chain asset legs are different from proof of a sofa pickup.
- [Solana Foundation escrow example](https://github.com/solana-foundation/escrow) and [program overview](https://github.com/solana-foundation/escrow/blob/main/docs/PROGRAM_OVERVIEW.md): reference implementation, not a ready-made physical-furniture dispute and seller-release product.
- [Program-derived addresses](https://solana.com/docs/core/pda/pda-derivation) and [Clock sysvar](https://docs.rs/solana-program/latest/solana_program/sysvar/clock/index.html): possible custom escrow building blocks; not a reason to add a custom program when an existing primitive satisfies the chosen scope.
- [SWIG repository](https://github.com/anagrambuild/swig-wallet): alternative delegated-wallet research. Licensing and the complete SDK/infrastructure path require their own evaluation; not selected.
- [Privy authentication](https://docs.privy.io/authentication), [policy and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls), and [Solana signing](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction): possible web wallet integration. Actual account access, controls, and device behavior are unverified.
- [Phantom Browser SDK](https://docs.phantom.com/sdks/browser-sdk): research found new Portal/Connect application creation paused while existing application IDs could continue. Recheck availability rather than planning around a fresh embedded login.
- [Phantom connection help](https://help.phantom.com/hc/en-us/articles/29995498642195-Connect-to-apps): mobile connection constraints. An external wallet application or in-app browser can introduce installation and handoff friction in the web shopping experience.

### Actual merchant rails

- [Bitrefill home catalog](https://www.bitrefill.com/us/en/gift-cards/home/), [MCP integration](https://docs.bitrefill.com/docs/mcp-partner-integration-guide), and [crypto payments](https://docs.bitrefill.com/docs/crypto-payments): research found an agent-accessible gift-card purchase route with `usdc_solana` payment instructions and home-retail catalog entries. A gift card is not a furniture order, inventory guarantee, or delivery reservation. No purchase was performed.
- [Bitrefill refund policy](https://help.bitrefill.com/hc/en-us/articles/360019310740-What-is-our-refund-policy): delivered codes generally cannot be treated as freely refundable cash. Check current product restrictions, region, denomination, residual balance, and test access before any purchase flow.
- [Crossmint agents overview](https://docs.crossmint.com/agents/overview), [platform overview](https://docs.crossmint.com/introduction/platform-overview), and [documentation index](https://docs.crossmint.com/llms.txt): distinguish agent cards, stablecoin wallets, and checkout automation. Their coexistence does not prove an arbitrary Solana-funded card checkout bridge is available to us.
- [Older Crossmint Amazon/Solana quickstart URL](https://www.crossmint.com/quickstarts/purchase-on-amazon-using-solana): research found this URL returned 404 despite being search-indexed. It is historical context, not a validated implementation dependency.
- [MoonAgents Card support](https://support.moonpay.com/en/articles/629708-moonagents-card-crypto-funded-virtual-payment-cards): researched eligibility excluded US residents and described a Mastercard product. Do not promise it as the team's US/Visa bridge.
- [Shopify native USDC payments](https://help.shopify.com/en/manual/payments/shopify-payments/local-payment-methods/usdc-payments): research found listed networks other than Solana. Native Shopify USDC and a separate Solana plugin are different integrations.
- [Solana Pay Shopify plugin](https://docs.hel.io/docs/solana-pay-shopify-plugin): separate merchant opt-in rail; it does not make every Shopify or furniture store a Solana merchant.

### Resale and rejected ideas

- [AptDeco help reference 1](https://aptdeco.frontkb.com/en/articles/13495105), [reference 2](https://aptdeco.frontkb.com/en/articles/713856), and [reference 3](https://aptdeco.frontkb.com/en/articles/716544): examples of the real resale operational problem, including payment and fulfillment expectations. A direct wallet escrow does not inherit AptDeco's logistics or dispute handling, and no marketplace integration was established.
- [Solana x402 overview](https://solana.com/docs/payments/agentic-payments/x402), [facilitator reference](https://solana.com/docs/tools/x402-facilitator), and [x402 repository](https://github.com/x402-foundation/x402): retained only to explain the researched and rejected payment-for-agent-services direction. Do not silently reintroduce it as a requirement.
- [Solana Pay transfer requests](https://solana.com/docs/tools/solana-pay/quickstart/transfer-requests): simple payment-request primitives; these alone do not justify a generic roommate reimbursement feature.

## What remains unverified

1. Actual end-to-end performance and dimensional accuracy of either onboarding path.
2. iPhone capture reliability, Quest 3S runtime capabilities, voice inside XR, and device-specific wallet flows.
3. Retailer automation reliability, permitted asset reuse, current stock, taxes, shipping, delivery dates, and checkout access.
4. Exact model checkpoint and dependency licenses selected for implementation.
5. Sponsor interpretation of the ASI:One primary workflow, current entry forms, prize stacking, and conflicting prize descriptions.
6. Availability of wallet/provider accounts, devnet assets, test modes, and any merchant-funded payment bridge.
7. Whether a Solana extension improves the core demo enough to justify its implementation cost.

These items should become explicit implementation gates. They should not be converted into “supported,” “integrated,” or “tested” claims in the pitch until demonstrated.
