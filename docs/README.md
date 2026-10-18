# Tadaima project documentation

This is the shared project context for the LA Hacks AI Hackathon 2026 furniture-shopping experience. It consolidates the product discussion, research, constraints, sponsor requirements, and a proposed implementation path as of **October 17, 2026**.

The repository is named `tadaima`; the existing UI, package, and older handoff still use **Michael**. This documentation uses Tadaima as the repository label, without treating a product rename as completed or approved. “Room Service” was an earlier research working name.

## Start here

For active development, start with [Team ownership and working boundaries](team-ownership.md): Matthew owns `backend/`, the project lead `reconstruction/`, Angelina `frontend/`, and Silas `spatial/`. Use the updated [copy-paste agent prompts](agent-prompts.md). The four areas share one application and one root development command.

1. Read [Project context and decisions](project-context.md) for what the user actually requested.
2. Read [Repository state and implementation plan](implementation-plan.md) before changing code. The current application is a landing-page hero, not an implemented shopping agent.
3. Read [Product](product.md), [Architecture](architecture.md), and [Data model](data-model.md) for the proposed experience and system boundaries.
4. Read [Demo and validation](demo-and-validation.md) before deciding what to build next.

## Documentation map

| Document | Purpose |
| --- | --- |
| [Team ownership](team-ownership.md) | Four working areas, named owners, initial tasks, and handoff boundaries |
| [Agent prompts](agent-prompts.md) | Standalone prompts matching the latest ownership swaps |
| [Project context](project-context.md) | Confirmed requirements, recommendations, rejected directions, and handoff |
| [Product](product.md) | Thesis, concise user flow, scope, and Homebuddy differentiation |
| [Architecture](architecture.md) | Data flow, shared state, jobs, integrations, and trust boundaries |
| [Data model](data-model.md) | Proposed room, evidence, product, revision, and checkout contracts |
| [Capture and reconstruction](capture-and-reconstruction.md) | Address research, iPhone web capture, dimensional grounding, Blender, and research options |
| [Platforms and UX](platforms-and-ux.md) | Desktop, mobile, Quest 3S, voice, and existing design direction |
| [Agent and shopping](agent-and-shopping.md) | Browser research, tool contracts, constrained replanning, and cart preparation |
| [Sponsors and submission](sponsors-and-submission.md) | Sponsor roles, eligibility, event requirements, and submission checklist |
| [Solana options](solana-options.md) | Deeper commerce research, viable proposals, constraints, and rejected x402 direction |
| [Demo and validation](demo-and-validation.md) | Proposed presentation sequence, fallbacks, and acceptance checks |
| [Implementation plan](implementation-plan.md) | Actual code inventory, setup, priorities, and build order |
| [Risks and open decisions](risks-and-open-decisions.md) | Unresolved choices and the evidence needed to resolve them |
| [Research and sources](research-and-sources.md) | Annotated public source register and confidence limits |

## Reading the status of a statement

- **Confirmed requirement:** explicitly requested by the user, including later corrections.
- **Observed:** found in the repository or a cited source. The original inventory used base commit `cbbe48f`; the implementation, platform, data-model, and team documents now also describe the subsequent four-folder scaffold explicitly.
- **Recommended:** a proposed design or scope decision, not an approval or an implemented feature.
- **Open:** needs a team decision, access confirmation, or device test.
- **Rejected:** deliberately excluded by the user or superseded by later direction.

Source publication does not prove that an integration works in this repository. No end-to-end reconstruction, shopping, payment, voice, or headset test is established by this documentation. Acceptance lists describe future checks unless a recorded result says otherwise.

## Authority and maintenance

The latest user instructions and applicable `AGENTS.md` instructions govern the work. These documents preserve context; they do not grant payment authority or turn proposed features into approved scope. [HANDOFF.md](../HANDOFF.md) is useful historical design context but contains superseded native scanning and repository-name assumptions. The source code remains authoritative for implemented behavior.

When implementation changes, update the repository inventory and record which proposed contracts became real. When external eligibility or SDK behavior changes, update the relevant source and date. Keep exact home addresses, room imagery, credentials, private inbox content, live authenticated browser links, and wallet secrets out of the public repository.
