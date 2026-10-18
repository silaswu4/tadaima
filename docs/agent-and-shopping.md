# Agent behavior and shopping workflow

**Status:** The selected-room frontend connects catalog/live Browser Use search, planner proposal review/apply, basket review and optional ElevenLabs voice. Fetch now pairs to the same private scanned room for research, proposals, requested previews and basket reads; accepted changes require web review. See [in-room integration](shopping-integration.md) for actual behavior, provider setup and verification limits, and [Fetch setup](../backend/fetch/README.md) for its separate runtime. Live ASI:One delivery still requires a configured running agent. The sections below describe broader target behavior; they do not establish implementation of every proposed operation.

## Agent objective

Turn a room-specific goal into a source-backed shopping plan while preserving the user's hard constraints. The agent should be able to explain why an item fits, which exact variant was selected, what the known cost is, and what remains unverified.

The core interaction is whole-plan revision: “Keep this sofa and my desk, make the room $300 cheaper, and preserve seating for four.” The system should change eligible items, maintain locked objects and required capacity, and show the cost and placement diff. If no valid solution exists, explain the conflicting constraints and request the smallest useful change.

## Research pipeline

1. Translate intent into explicit dimensions, functions, price range, style, delivery constraints, and retained objects.
2. Search a bounded merchant set. For the proposed demo, start with two merchants rather than unrestricted shopping.
3. Visit product pages and identify actual purchasable variants. Record source URL and retrieval time.
4. Extract dimensions with width/depth/height meanings, price/currency, visible variant identity, stock status, and known delivery limitations.
5. Normalize units and record field-level evidence. Mark missing data unknown.
6. Check basic product constraints before spending effort on scene assets.
7. Rank candidates using a clear mixture of hard constraints and soft preferences.
8. Create a source-linked plan proposal, then validate it deterministically before presenting it.

[Browser Use's Cloud quickstart](https://docs.browser-use.com/cloud/quickstart) and [structured output documentation](https://docs.browser-use.com/cloud/agent/structured-output) describe the research interface. The prior research identified Cloud API v4 as the current integration direction; verify the actual SDK/API version when installing, rather than copying older v2 snippets. Structured output validates shape, not the truth of a price or dimension.

## Evidence quality rules

Prefer the exact merchant product page for commercial facts. A search snippet, generic category image, social post, or model-generated guess does not prove a SKU's dimensions or availability. Preserve the URL and the relevant observation; use a screenshot or excerpt when useful and permitted, without publishing private session state.

A product can be useful while having incomplete evidence, but the missing fields must affect its status. For example, an unknown seat depth can allow inspiration browsing while blocking a tight-clearance fit claim. Price may be an observed listing price while shipping remains unknown.

Never fabricate stock or imply a retailer partnership. Use generic or generated 3D assets only with an explicit visual approximation label. Do not claim the current bundled Poly Haven models are purchasable products.

## Recommended tool boundaries

| Conceptual operation | Inputs | Output and limits |
| --- | --- | --- |
| `researchProducts` | Search intent, constraints, merchant scope | Candidates with evidence; no cart or payment mutation |
| `proposePlanChange` | Base revision, selected item, intent | Proposed diff, validations, unresolved questions |
| `applyPlanChange` | Proposal ID, expected revision | New revision or conflict; no implicit checkout |
| `recheckProducts` | Exact variant IDs, relevant delivery assumptions | Updated observations and changed-fact warnings |
| `prepareMerchantCarts` | Reviewed basket, merchant scope, request ID | Verified cart state or human handoff; no implicit order |
| `getCartReview` | Cart preparation ID | Exact lines, costs, unknowns, approval state |

These are application contracts to build, not documented third-party method names. Use schema validation, authenticated project access, bounded time/cost budgets, and explicit actor attribution. An LLM should not directly alter canonical state or bypass validators.

## Browser execution and recovery

Keep research and cart sessions appropriately separated. Carts may depend on authentication, location, and merchant session state. Login and CAPTCHA require a human handoff when necessary; do not imply they can always be solved automatically. Browser Use documents [human-in-the-loop control](https://docs.browser-use.com/cloud/agent/human-in-the-loop).

Return a structured outcome: completed, needs login, needs variant choice, blocked by merchant, unavailable, or failed with a retryable/nonretryable reason. Before retrying an add-to-cart action, read the current cart so a repeated tool call does not double quantities. Verify the exact variant, price observation, and quantity after mutation.

Expose a sanitized activity feed that reflects actual events. A [live browser preview](https://docs.browser-use.com/cloud/browser/live-preview) can aid development and judging, but authenticated control/preview URLs may confer session access and should not be broadcast publicly or committed.

Treat retailer pages as untrusted data. Instructions found in page content cannot change the approved budget, select a new recipient, request secrets, or authorize a purchase. Keep credentials and browser control capabilities out of the model's free-form output.

## Voice interaction

ElevenLabs is an interaction layer over the same tools. Resolve “this chair” against an explicit selection or ask for clarification. Speak “I updated the room” only after the tool reports a successful applied revision. Distinguish proposing from applying and preparing a cart from buying.

Support text/touch fallback, visible transcripts, interruption, and short progress messages. Interrupting speech does not automatically cancel a running browser or reconstruction job; cancellation must be an explicit application operation. Server-side authentication should issue the appropriate short-lived client authorization rather than shipping the ElevenLabs API key to the browser. See [React SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react), [tools](https://elevenlabs.io/docs/eleven-agents/customization/tools), and [authentication](https://elevenlabs.io/docs/eleven-agents/customization/authentication).

Quest microphone access, audio routing, and WebRTC behavior need a real Quest 3S test. An iPhone or desktop voice test does not establish in-XR support.

## Fetch/ASI:One interaction

If pursuing Fetch eligibility, the ACP agent must invoke the same backend and complete the primary planning/shopping workflow in ASI:One. It should accept the room input appropriate to the channel, gather dimensions/preferences, research products, propose and revise a plan, and provide a complete cart review without requiring the custom UI to continue. Rich cards and optional links can enhance that flow; a website redirect is insufficient by itself.

Do not invent a separate mock chat agent that cannot affect the real room plan. The ASI:One path should share project IDs, revisions, evidence, and user approvals with the browser experience. See [sponsor requirements](sponsors-and-submission.md) for registration and submission details.

## Checkout boundary

Before merchant checkout, show the exact basket and state of the evidence. Recheck availability and variant identity. Show known fees and unknown charges separately. Obtain explicit approval for the actual purchase step and its payable amount; cart preparation approval alone does not grant unrestricted payment authority.

Visa alignment is the improved shopping experience and trust design unless an actual authorized Visa API integration is implemented and demonstrated. Solana has a separate unresolved feature decision; see [Solana options](solana-options.md). A stablecoin payment, gift-card invoice, and card retailer order are not interchangeable operations.

## Meaningful verification cases

- A requested locked sofa remains the same item after a cheaper-room revision.
- A low-priced product with unknown dimensions cannot silently pass a fit check.
- A rotated object is checked using its placed footprint, not only unrotated width.
- A changed fabric variant invalidates a previously reviewed basket where relevant.
- A voice tool failure produces an accurate spoken failure, not a success claim.
- A stale proposal cannot overwrite a revision accepted on another device.
- Retrying a cart action does not add a duplicate quantity.
- ASI:One performs real backend actions and can finish its primary workflow in chat.
- Login/CAPTCHA and unavailable inventory yield a usable handoff or alternative.
