# Product thesis and scope

Documentation baseline: October 17, 2026. This document distinguishes the user's requirements from proposals that still need a product decision. It describes the intended product; it does not imply that the current repository implements these flows.

## The product in one sentence

Tadaima is a web furniture shopping agent that understands a person's room, finds real products that fit, and revises a complete shopping plan around their budget and existing furniture.

The repository is named `tadaima`. The current UI, package metadata, and older `HANDOFF.md` call the project **Michael**, explicitly a working name. A final naming decision is still open. Use Tadaima as the repository identifier without silently renaming the existing interface.

## The problem to solve

Furniture shopping involves several decisions that conventional catalogs handle separately:

- Will the product physically fit, including usable clearance around it?
- Does the whole room work together, rather than each item looking good in isolation?
- Which exact size, color, and variant is available at the displayed price?
- Can the basket stay within a budget while preserving the things the user already owns?
- What changes if an item sells out or becomes more expensive?

The central product claim should be **a room plan grounded in measurements and current product evidence**. A realistic render alone does not establish any of these facts. Room fit also does not establish delivery fit through doors, stairs, or an elevator; this is a separate assessment that requires those measurements. [West Elm's delivery measurement guidance](https://www.westelm.com/pages/ideas-and-advice/measure-for-delivery/)

## Requirement status

| Status | Requirement or decision |
| --- | --- |
| Confirmed by the user | Stay web only. The product must work on desktop web and mobile web. |
| Confirmed by the user | Support Meta Quest 3S as an immersive way to inspect and shop the room. |
| Confirmed by the user | Offer two starting paths: address and unit research, or mobile web room capture. |
| Confirmed by the user | The available scanning phone is an iPhone. |
| Confirmed by the user | Investigate meaningful roles for Paper, Browser Use, Visa, Fetch, ElevenLabs, and Solana. |
| Confirmed by the user | Use Homebuddy as inspiration while making the experience more ambitious and distinctive. |
| Explicitly rejected | x402 agent payments as the project's Solana hook. Do not bring this back as the default. |
| Recommended scope | Make one shopping room work end to end before attempting detailed reconstruction of every room in a unit. |
| Recommended differentiation | Constraint-preserving whole-room replanning with real product evidence and a concrete cart review. |
| Recommended implementation | One structured, versioned room model shared by all clients; server-side Blender generation and optimized GLB viewing. |
| Still open | The final Solana concept, wallet provider, reconstruction model, deployment provider, model provider, and production payment integration. |

The user requested research into Solana; that is not approval of any particular escrow, spending mandate, gift card, or resale implementation. See the Solana options document before adding scope.

## The primary user

The initial user is furnishing or refreshing a living room and needs help making a complete set of decisions. They may be moving into an apartment, keeping a sofa and desk, and trying to spend less than a fixed amount. They should be able to finish the core workflow using an ordinary browser. A Quest adds spatial inspection; it is not a prerequisite for shopping.

For the hackathon, favor a specific scenario over a universal interior design application:

> "Keep my sofa and desk. Make this room work for four people, and bring the new purchases down by $300."

This creates a visible test of intelligence: the agent must preserve locked items, maintain seating capacity, respect geometry, find alternatives, and explain the price difference.

## Concise user flow

1. **Bring in the room.** Choose **Find my apartment** or **Capture my room**.
2. **Confirm the space.** Review the proposed layout, identify the target room, and confirm uncertain dimensions and openings.
3. **Set the goal.** Choose a budget, style, functional needs, and furniture to keep.
4. **Get a shoppable plan.** The agent researches real products, checks dimensions and constraints, and proposes a room arrangement with a cost breakdown.
5. **Inspect and revise.** Use desktop, mobile, or Quest to select a piece and ask for changes. See what changed, what stayed locked, and how the budget moved.
6. **Review the exact basket.** Recheck product variants, availability, prices, shipping, and known omissions.
7. **Continue to merchant checkout.** Approve cart preparation and explicitly approve any final purchase. Display actual completion status.

## Input path A: Find my apartment

The user supplies an address and optional unit number. The system searches public property manager pages, accessible listings, brochures, and floor plans. It presents candidate evidence instead of assuming the first search result belongs to that exact unit.

Every candidate needs an applicability label: exact unit, apartment type, building-level reference, or unknown. The user confirms the correct layout, including mirrored variants. Missing evidence leads to photo upload or manual measurements, not an invented apartment.

An address is a research starting point, not a universal floor plan API. For example, Zillow's documented rentals feed is a publisher integration, not a general-purpose API that returns arbitrary unit plans. [Zillow Rentals Feed integrations](https://www.zillowgroup.com/developers/api/rentals/rentals-feed-integrations/)

If a complete unit plan is available, the system may establish the structural outline of the apartment. The recommended first demo still furnishes one room in detail.

## Input path B: Capture my room

The user opens the mobile website on an iPhone, grants camera permission, and follows guided capture instructions. The baseline gathers photos or a supported video recording, uploads the material, and asks for a small number of anchor measurements. Server-side processing proposes a room model for review.

This must not be advertised as native Apple RoomPlan or a guaranteed LiDAR scan. RoomPlan is a native Apple framework. iPhone Safari camera capture does not itself provide the same semantic room model, tracked camera poses, or dimensional guarantees. [Apple RoomPlan](https://developer.apple.com/augmented-reality/roomplan/), [WebKit MediaRecorder support](https://webkit.org/blog/11353/mediarecorder-api/), [WebKit's iOS WebXR discussion](https://bugs.webkit.org/show_bug.cgi?id=309550)

The mobile path should remain useful when camera permission is denied: allow existing photos and manual dimensions. An AR or tracking enhancement can be evaluated later without making it a dependency of the core flow.

## What makes the shopping agent useful

### Whole-room constraints

The system treats a request as a plan revision, not a new image prompt. It needs to preserve:

- Locked existing items and their positions when requested.
- Required functions, such as seating four people or retaining a work surface.
- Door and window openings, fixed fixtures, and requested clearances.
- Product dimensions and orientation.
- An explicit budget definition, including which costs are known or estimated.

Spatial checks should be deterministic where possible. A language model can propose a layout; geometry and product data must determine whether the layout passes the stated checks. The planner must not shrink a product model to make it fit.

### Product truth

Each proposed purchase should identify the retailer, source URL, product and variant, dimensions, price and currency, availability evidence, and observation time. Unknown shipping or tax stays unknown or visibly estimated. A saved screenshot or successful extraction is evidence about a page at a time, not a guarantee that checkout will still match.

Use a merchant's model when available and permitted. Otherwise, use a dimensionally correct visual proxy and label it. A generic sofa that happens to resemble the product is not proof of exact fabric, shape, or color.

### Visible changes

After a revision, show a small diff: replaced item, reason, savings, changed constraints, and any unresolved issue. The user should be able to undo a revision or compare it with the previous plan. Do not replace the entire room silently when the user asked to change one chair.

## Relationship to Homebuddy

The organizer's project page identifies Homebuddy as the second-place project at the September 8, 2026 GPT-6 Astra SF hackathon and describes interior reconstruction and furniture placement. That is a real overlap with this concept. [Homebuddy project page](https://cerebralvalley.ai/e/openai-gpt-6-astra-sf/hackathon/gallery/41)

The user also supplied a detailed account of its demo: a 333 Bush Street listing, Blender reconstruction, presets, a roughly $5,410 running total, isometric and inventory views, first-person walkthrough, object editing, $25,000 in credits, and a future vision including agentic ordering and assembly services. Treat those as **user-provided demo context**, not independently verified facts unless the linked demo or organizer material is reviewed. The supplied video is [Homebuddy's demo](https://youtu.be/RpraWKe9crI). The reported unavailable GitHub repository is not a code dependency.

| Area | Homebuddy inspiration | Tadaima's intended emphasis |
| --- | --- | --- |
| Space input | Listing photos and floor plan | Address research with evidence confirmation, plus iPhone web capture |
| Reconstruction | A navigable, furnished 3D home | A confirmed metric room model with explicit uncertainty |
| Shopping | Catalog selection and running price | Source-linked, exact-variant, cross-retailer research and rechecking |
| Interaction | Interactive 3D editing and walkthrough | One plan usable on desktop, mobile, and Quest 3S, with object-grounded voice |
| Reasoning | Intelligent placement | Constraint-preserving whole-room revisions with a visible diff |
| Commerce | Ordering appeared in the user's account of the future vision | A reviewable basket and actual cart preparation within available merchant access |

Address input alone is an incremental change from a listing URL. Quest is an extension of an existing walkthrough idea. Adding sponsor SDKs is not product differentiation. The strongest demo distinction is whether the system can solve a constrained change and carry the answer into a trustworthy shopping action.

## The existing market raises the bar

IKEA Kreativ already connects room visualization with shopping, while Wayfair has AI inspiration and immersive spatial shopping work. Amazon also documents conversational shopping and selected outside-merchant purchase flows. Avoid claiming that AI room design, full-size furniture viewing, or agentic shopping is unprecedented. [IKEA Kreativ guidance](https://www.ikea.com/us/en/customer-service/knowledge/articles/2cf21206-86a9-44a6-bc3f-8ebc8d838b0d.html), [Wayfair Muse](https://www.aboutwayfair.com/category/company-news/wayfair-introduces-new-ai-powered-tool-muse-to-inspire-and-personalize-the-home-shopping-experience), [Wayfair spatial computing](https://www.aboutwayfair.com/careers/tech-blog/spatial-an-evolution-in-computing), [Amazon shopping assistant](https://www.aboutamazon.com/news/retail/amazon-rufus-ai-assistant-personalized-shopping-features)

Do not promise a universal percentage reduction in returns or conversion improvement. AR research is context-dependent, and published results from a different retail category do not establish furniture outcomes for this product. [Tan, Chandukala, and Reddy](https://journals.sagepub.com/doi/abs/10.1177/0022242921995449), [Pfaff and Spann](https://onlinelibrary.wiley.com/doi/full/10.1002/mar.21874)

## Recommended hackathon boundary

Build one coherent vertical slice:

- One measured room with a small set of retained objects and clear constraints.
- Two researched merchants and approximately 12–20 prepared, source-linked product candidates.
- Both onboarding routes visible and honest about their evidence and correction steps.
- One meaningful constrained revision that can be repeated during the demo.
- A usable flat-screen workflow and a tested Quest inspection path if hardware permits.
- A final exact-basket review and either a verified cart operation or an explicit merchant handoff.

Defer whole-home photorealism, perfect automatic measurement, arbitrary retailer purchasing, assembly dispatch, autonomous real-money payment, and a resale marketplace unless the core flow is already reliable. The recommended Solana extension is a separate decision; it should not consume the room-shopping demo by default.

## What success would demonstrate

The demo succeeds if the audience can follow the chain from the user's actual space, through a constrained product decision, to an inspectable and actionable basket. The room, product evidence, budget, and cart must describe the same plan revision. If any part is prepared, simulated, estimated, or unavailable, the interface should say so at the point where it matters.
