# Solana Options

Research snapshot: October 17, 2026. **No specific Solana feature has been approved for implementation.** The user wants a useful, inventive integration and explicitly rejected the earlier x402 direction. This document preserves the later research and recommendations without turning them into accepted requirements.

## Decision History

| Idea | Status | Reasoning |
| --- | --- | --- |
| x402 payments between agents/services | Rejected by the user | It did not improve the furniture shopping thesis enough to justify itself |
| Generic roommate reimbursement or pooled funds | Explored, not selected | Easy to add, but weak differentiation without an exact shared purchase agreement |
| Sell-to-upgrade with resale proceeds | Research recommendation, not approved | Strong connection between a room's existing inventory, replacement cost, and a real financial agreement |
| Approve this room with an enforceable spending mandate | Research recommendation, not approved | Preserves the shopping scope while making bounded agent authority demonstrable |
| Exact-basket household consensus | Secondary possibility, not approved | Useful only when multiple people genuinely fund and approve a shared room |
| All-or-nothing room procurement | High-scope research idea | Onchain commitments cannot make unrelated card checkouts or physical deliveries atomic |

The decision should follow the product problem. A transfer receipt, NFT, token, or payment button alone does not create a compelling furniture product.

## The Test for Whether Solana Helps

A useful integration should answer all four questions:

1. Who are the distinct parties whose interests differ?
2. What rule is enforced even if our agent or backend makes a bad request?
3. What can a user verify without trusting a success animation?
4. What remains dependent on humans, merchants, or our application?

A database is usually sufficient for remembering a budget, saving a room, calculating resale estimates, and showing a receipt. Solana becomes more relevant when independent participants fund an agreement, or when an owner delegates strictly bounded authority to an agent. Neither case makes room geometry, product quality, or delivery truth an onchain fact.

## Option A: Sell-to-Upgrade

### Product Thesis

The shopper says, “Upgrade this room with $500 in new money.” The room model becomes a keep/sell/replace inventory. The agent proposes which existing items to retain, which to sell, and which new pieces to buy. The plan shows gross purchase cost, estimated resale proceeds, actual settled proceeds, and the resulting new-money requirement separately.

This is a product extension, not a small checkout adapter. It adds buyers, listings, pickup, release/refund decisions, and failed-sale handling. Build it only if that expansion is deliberate.

### Useful Financial Boundary

For a participating resale buyer, the agreed payment can be held under explicit escrow rules and released following a defined pickup confirmation. The point is that the seller cannot simply mark an unpaid listing as settled, and the agent cannot count unfunded interest as purchasing power. The program should constrain the permitted recipients and transitions; an application-only escrow label does not do that.

The physical handoff still needs an authority or participant signatures. A photo, a QR scan, or an agent's statement does not magically prove satisfactory delivery. The first prototype must state its trust model plainly, such as dual buyer/seller confirmation, and expose the failure path when one party refuses to confirm. A production dispute process is unsolved by this demo.

### Proposed State and Accounting

Suggested listing states, subject to implementation review:

```text
draft -> listed -> reserved -> funded -> pickup_pending -> released
                               \-> refund_pending -> refunded
```

Use separate accounting fields rather than one optimistic budget:

```text
new_money_budget
estimated_resale_proceeds
escrowed_proceeds
settled_resale_proceeds
committed_purchase_amount
available_purchase_budget
```

For the initial demonstration, only settled proceeds increase the spendable budget. A funded escrow is not yet a seller's released money. Listing prices and verbal offers are estimates. A failed sale should leave the room plan understandable and trigger replanning, rather than creating a negative balance after an irreversible purchase.

### Minimal Honest Demo

1. Load a measured room containing an existing chair and a desk.
2. Ask for a makeover with a fixed amount of new money.
3. Keep the desk and mark the chair for resale.
4. Show the chair's estimated proceeds separately from available funds.
5. Have a second, team-controlled buyer account fund one agreement on devnet.
6. Show that escrowed funds remain unavailable for spending.
7. Complete the explicitly simulated pickup confirmation using the chosen authorization rule.
8. Show the release transaction, reconcile its state, and then increase the available room budget.
9. Replan the new furniture basket. Hand off real merchant checkout separately.

Use a devnet test token and label it accordingly. Do not call an arbitrary test mint “real USDC.” Identify both demo participants as controlled accounts and the pickup as a simulation. The financial-state transition can be real on devnet while the marketplace and physical handoff are fixtures.

### What to Reuse and What to Build

The Solana Foundation's DvP program handles an atomic exchange between two onchain token legs. It does not provide a physical-furniture delivery oracle or an off-ledger card-payment leg. It is useful background for settlement design, not a turnkey furniture escrow. [DvP program](https://solana.com/docs/defi/dvp-program).

The Foundation escrow repository is also not a drop-in buyer-to-seller marketplace contract: inspect the actual deposit/withdrawal semantics and authorities before reusing it. A name containing “escrow” is insufficient evidence of the desired release policy. [Escrow repository](https://github.com/solana-foundation/escrow), [program overview](https://github.com/solana-foundation/escrow/blob/main/docs/PROGRAM_OVERVIEW.md).

A custom physical-trade program would need explicit parties, mint, amount, release authorization, cancellation/refund paths, and replay protection. Use exact integer base units. Bind every release/refund to the same agreement and designated recipients. Decide whether timeouts give unilateral refund rights and whether that creates a seller risk after pickup. Those are product rules requiring a real design, not fields to fill in after coding.

No integration with Facebook Marketplace, Craigslist, AptDeco, or their escrow systems has been established. Do not scrape an asking price and call it a guaranteed sale. Existing marketplaces have their own payment, pickup, and payout rules; this proposal is a participating-buyer flow operated by our prototype. [AptDeco seller payment reference](https://aptdeco.frontkb.com/en/articles/13495105).

## Option B: Approve This Room

### Product Thesis

The shopper approves a reviewed room basket once and delegates a limited amount of purchasing authority. The agent can use that authority within explicit limits, while an excessive or unauthorized transfer fails independently of the model's intentions.

This is the more contained option. Its strongest demonstration is a correct purchase attempt followed by a visibly rejected wrong-recipient or over-budget attempt, followed by owner revocation and another rejected attempt. It should be presented as a financial permission system, not as a guarantee that an agent bought the correct sofa.

### Candidate Mechanism: Squads v4 Spending Limits

Squads spending limits can authorize selected members to move a specified token amount from a vault, optionally restricted to destination wallets. A period of `None` creates a non-resetting allowance rather than a recurring budget. Configuration changes are performed through configuration transactions. [User guide](https://docs.squads.so/main/navigating-your-squad/settings/spending-limits), [developer reference](https://docs.squads.so/main/development/reference/spending-limits).

The implementation checks authorized members, mint, remaining amount, and configured destinations. **An empty destination list does not restrict the recipient.** Populate it deliberately. Revocation prevents subsequent authorized use; it does not reverse a transfer already executed. [Spending-limit implementation](https://raw.githubusercontent.com/Squads-Protocol/v4/main/programs/squads_multisig_program/src/instructions/spending_limit_use.rs).

Suggested configuration for a contained prototype:

- A user-controlled configuration authority.
- A separate agent member that cannot enlarge or replace its own limit.
- A specific token mint and integer cap.
- A non-resetting period for the one approved purchase session.
- An explicit destination allowlist containing the intended demo payees.
- A separate owner revocation action.

The user must inspect the actual authority arrangement, not just the UI's role labels. If the same agent also controls enough owner keys to rewrite the policy, the claimed restriction is meaningless.

### Room Approval Is Additional Application Logic

Squads does not know what a sofa is. A spending limit alone does not enforce product URL, SKU, color, dimensions, quantity, delivery date, or which room revision was approved.

A proposed approval record can bind:

```text
approval_id
room_plan_revision
canonical_basket_hash
currency_or_mint
maximum_total
selected_product_variants
permitted_payee_identifiers
approval_timestamp
```

Canonicalization must be deterministic. An unstructured text summary is not a reliable commitment. Keep the detailed basket private when necessary and avoid putting exact addresses or floorplans in public transaction metadata. A hash provides a way to compare an approved record; it does not make the program validate the record's real-world meaning. Low-entropy identifying data should not be published even as a simple unsalted hash.

For stronger SKU-specific restrictions, a separate contract or policy adapter would have to validate appropriate signed merchant quotes or commitments. That requires merchant participation or a clearly stated trusted attestor. It is a different scope from using a stock Squads limit. Do not describe the extra enforcement as already available.

### Minimal Honest Demo

1. Review a versioned room basket with exact variants and a maximum total.
2. Owner configures one bounded devnet allowance to known demo recipients.
3. Agent executes one permitted transfer.
4. Attempt a transfer exceeding the remaining allowance; show the program rejection.
5. Attempt a transfer to a different recipient; show rejection.
6. Owner revokes the authority.
7. Attempt another transfer; show rejection and unchanged balance.
8. Link the transactions and reconcile balances with the application state.

These test transfers are not proof that an unaffiliated furniture retailer accepted an order. That is a separate integration that must be demonstrated separately.

### Why Basic Token Delegation Is Insufficient

SPL token delegation grants a bounded amount of authority but does not inherently express an approved merchant, SKU, expiry, or room revision. Delegates can transfer or burn within their allowance. A simple approval is therefore not a complete shopping mandate. [Approve delegate](https://solana.com/docs/tokens/basics/approve-delegate), [spend permissions](https://solana.com/docs/payments/advanced-payments/spend-permissions).

## Real Merchant Settlement: Verified Possibilities and Gaps

### Bitrefill: Gift Cards, Not a Furniture Checkout API

Bitrefill offers a documented MCP purchase flow: discover products, inspect details, create an invoice, then check invoice status and delivered codes. Testing requires following its test-product/staging guidance; production purchases are real purchases. [Partner integration guide](https://docs.bitrefill.com/docs/mcp-partner-integration-guide).

Its crypto payment documentation lists `usdc_solana`; invoices provide a payment address and amount. Its US home catalog includes furniture-related brands, but the current product, denomination, region, and payment methods must be inspected per purchase. [Crypto payments](https://docs.bitrefill.com/docs/crypto-payments), [US home catalog](https://www.bitrefill.com/us/en/gift-cards/home/).

This is a potential bridge from settled Solana funds to merchant gift-card value. It does not reserve a sofa, verify stock, select delivery, or place the furniture order. Delivered gift cards generally cannot simply be refunded when the shopper changes their mind. Denominations and residual balances also matter. [Refund policy](https://help.bitrefill.com/hc/en-us/articles/360019310740-What-is-our-refund-policy).

Our recommended sequence, if ever selected, is: recheck the furniture cart, explain the gift-card terms and denomination, obtain explicit approval, buy the gift card, wait for delivery, and redeem it through the merchant's supported flow. Do not purchase a gift card early merely because a plan looks good. Do not send devnet tokens to a production invoice or promise a devnet IKEA purchase.

A dynamic invoice address also complicates a fixed-recipient mandate. A new invoice cannot be treated as a preapproved retailer wallet without verifying the invoice and binding it to the intended purchase. The adapter and its authority would need their own design. No production Bitrefill purchase or end-to-end retailer bridge has been performed for this project.

### Crossmint: Promising Surface, Unverified Bridge

Current Crossmint materials distinguish agent wallets, agent cards, and agent checkout capabilities. These could be useful building blocks, but their existence does not establish that arbitrary USDC on Solana can fund any furniture merchant's card checkout under our intended policy. Verify the exact supported product, geography, funding path, spending controls, and sandbox. [Agents overview](https://docs.crossmint.com/agents/overview), [platform overview](https://docs.crossmint.com/introduction/platform-overview).

An older “purchase on Amazon using Solana” quickstart appeared in search results, but the linked page returned 404 during research. Do not build an architecture around that obsolete result. [Previously indexed quickstart](https://www.crossmint.com/quickstarts/purchase-on-amazon-using-solana).

### Shopify and MoonPay Commerce

Shopify Payments' native USDC documentation lists Base, Ethereum, Optimism, Polygon, and Arbitrum, not Solana. Do not use “Shopify supports USDC” as proof of Solana acceptance. [Shopify USDC support](https://help.shopify.com/en/manual/payments/shopify-payments/local-payment-methods/usdc-payments).

The separate MoonPay Commerce/Helio Solana Pay plugin requires a merchant to install and activate it. This is a possible route for a cooperating merchant, not a way to change a third-party retailer's checkout from the shopper side. [Solana Pay Shopify plugin](https://docs.hel.io/docs/solana-pay-shopify-plugin).

### MoonAgents Card

MoonAgents Card documentation excludes US residents in its current eligibility description and requires identity checks. It is a Mastercard product, not evidence of a Visa integration. It is unsuitable as the assumed payment bridge for this US hackathon demo. Recheck eligibility if the product changes. [MoonAgents Card documentation](https://support.moonpay.com/en/articles/629708-moonagents-card-crypto-funded-virtual-payment-cards).

## Wallet UX Under the Web-Only Requirement

The primary furniture experience must work without installing a native app. A conventional wallet handoff can add an external app dependency for a person who wants the optional financial feature, but cannot become a hidden prerequisite for viewing or shopping.

Phantom's current Browser SDK documentation says new Portal/Connect applications are paused, while existing app IDs can continue. Do not plan on obtaining a fresh embedded-wallet app ID during the hackathon without confirming access. Injected extension and mobile wallet behavior also differ; test the actual browser and phone. [Phantom Browser SDK](https://docs.phantom.com/sdks/browser-sdk), [connecting to apps](https://help.phantom.com/hc/en-us/articles/29995498642195-Connect-to-apps).

Privy or Crossmint embedded wallets are candidates, subject to actual access, supported Solana operations, authentication, and signing-policy tests. No wallet provider has been selected. Keep signing on the phone or desktop for the first demo rather than making headset wallet UX a dependency. [Privy authentication](https://docs.privy.io/authentication), [Solana signing](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction), [policy controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls).

Use an explicit cluster badge and configured token mint. Never infer currency from a ticker string alone. Never publish wallet private keys, recovery phrases, or server signing credentials. A server-side agent wallet must have only the permissions necessary for the demonstrated action.

## Required Verification Before Claiming Success

These are proposed acceptance checks, not tests that already passed:

| Area | Evidence needed |
| --- | --- |
| Authorization | Correct signer succeeds; wrong signer fails |
| Amounts | Exact integer amount; over-budget action fails; no accidental recurring reset |
| Recipients | Intended recipient succeeds; other recipient fails |
| Mint and cluster | Exact configured values; wrong mint rejected; devnet clearly labeled |
| Replay and retries | Retrying a request does not release or credit proceeds twice |
| Reconciliation | UI derives success from actual chain state and transaction confirmation |
| Revocation | Revoked authority cannot execute the next action |
| Escrow release | Only the chosen release rule can move funds to the agreed seller |
| Cancellation | Documented refund path works; no hidden unresolvable state |
| Room linkage | Approval references the intended plan revision; later edits require review |
| Merchant bridge | Actual test proves the supported funding-to-order path, or the demo stops before claiming a retail purchase |

Do not credit spendable funds solely because the frontend submitted a transaction. Track pending, confirmed, failed, and reconciled states separately. Show transaction details without exposing private room data.

## Recommended Scope Decision

Finish the useful furniture workflow first. If the team wants a contained Solana demonstration, choose the bounded room-spending mandate and prove that an unauthorized action actually fails. If the team wants to make circular commerce a central product thesis, choose one sell-to-upgrade escrow trade and accept that it adds a second marketplace workflow.

Do not build both just to cover sponsor surface area. Do not reactivate x402 without a new user decision. Neither recommendation changes the current core requirements or establishes that the user selected it.
