# Backend · Project lead

Owner: **you, the project lead**. This is the application and agent integration area. Work alongside Matthew's reconstruction pipeline, Angelina's screens, and Silas's spatial viewer.

## Scope

- Canonical room-plan state, persistence, revisions, authorization, and async job coordination.
- Shared browser-safe types in [`contracts.ts`](contracts.ts).
- Product research and cart preparation through Browser Use.
- Constraint-aware planning and deterministic validation.
- ElevenLabs server tools/authentication and Fetch/ASI:One agent integration.
- The selected Solana adapter once the team chooses its scope; x402 remains rejected.
- Integration in root `app/` routes/layout and shared package/config changes.

## First tasks

1. Agree on `contracts.ts` with the other three owners. The scaffold is a starting contract, not runtime validation or a complete implementation of the proposed data model.
2. Implement one fixture-backed project/plan read and validated revision write.
3. Connect Matthew's confirmed geometry output to the canonical plan.
4. Expose product research and a constrained revision through the same service operations used by the frontend, voice, and ASI:One.
5. Add exact-basket review and real cart state before payment work.

## Boundaries

`contracts.ts` must stay free of runtime imports, secrets, Node-only libraries, and provider SDKs so clients can safely use `import type`. Put actual server implementations in this folder and guard them with the framework's server-only boundary when introduced. Root `app/api/**/route.ts` files should be thin adapters to those implementations.

Do not put UI components, capture screens, or Three.js rendering here. Do not make a provider response canonical without validation. No endpoint, database, model provider, or external integration is implemented by this scaffold.

See [team ownership](../docs/team-ownership.md), [architecture](../docs/architecture.md), and [shopping behavior](../docs/agent-and-shopping.md). All application commands run from the repository root.
