# Team ownership and working boundaries

Updated October 17, 2026. This allocation implements the user's request for four primary working folders. It assigns responsibilities, not assumed prior expertise. The project remains one Next.js application with one dependency installation, one development server, and one shared data contract.

## Primary folders

| Owner | Primary folder | Responsibility | Initial deliverable |
| --- | --- | --- | --- |
| Matthew | `backend/` | Shared contracts, application services, persistence, authorization, planning and shopping orchestration, sponsor adapters, and final integration | A browser-safe room-plan contract and a fixture-backed application boundary that the other three areas can use |
| User / project lead | `reconstruction/` | Address evidence processing, capture processing, metric geometry proposals, Blender generation, artifacts, and asynchronous reconstruction jobs | A confirmed room fixture that generates an editable shell and browser-viewable output, with a clear job status |
| Angelina | `frontend/` | Product screens, onboarding, capture interface, plan and product panels, constraints, revision review, basket review, and responsive UI | A coherent flat-screen flow that can use fixtures before live backend operations exist |
| Silas | `spatial/` | ASCII landing renderer, Three.js room viewer, object selection, dimensional overlays, placement interaction, and Quest/WebXR interface | Preserve the latest ASCII hero and earlier room renderer, then render the shared room fixture and emit stable item selections |

Silas and Angelina are both focused on frontend work. The split is between the surrounding product interface and the spatial interface; it is not two separate applications. The user owns processing and reconstruction rather than the capture screen. Matthew owns backend integration rather than asking each person to create their own backend. This reflects the user's latest swap of backend and reconstruction responsibilities.

## Repository shape

```text
app/                         Thin Next.js routes, layouts, and integration entry points
backend/                     Matthew
  contracts.ts               Browser-safe shared application types
reconstruction/              User / project lead
  contracts.ts               Reconstruction job and adapter boundary
frontend/                    Angelina
  HomePage.tsx               Page composition and surrounding product UI
  styles/globals.css         Shared product styling
spatial/                     Silas
  components/AsciiHero.tsx   Current homepage hero
  components/AsciiField.tsx  Current WebGL ASCII renderer
  components/RoomHero.tsx    Earlier pencil-room viewer, retained
  room/scene.ts              Existing Three.js scene
  room/parts.ts              Existing procedural scene parts
public/                      Shared static assets served by the one application
docs/                        Supporting project documentation
```

The listed UI/scene paths describe the scaffold layout. They do not establish that the proposed shopping or reconstruction flows have been built. Consult the current files and [implementation inventory](implementation-plan.md) before depending on a feature.

Do not add a separate `package.json`, Next.js application, development server, or competing root configuration inside each working folder. A future worker may need a Python environment or another runtime, but that is an explicit reconstruction deployment decision, not a reason to split the website into four apps.

## Shared files and integration ownership

Matthew, the backend integration owner, coordinates changes to these integration surfaces:

- `app/`, including route entry points, layout wiring, and future API route adapters.
- Root `package.json`, lockfile, TypeScript, Next.js, ESLint, and deployment configuration.
- `backend/contracts.ts`, shared fixture identity, and the public application operation boundary.
- Root documentation navigation and cross-area architecture decisions.

Angelina owns routine product styling in `frontend/styles/globals.css`. Silas should use local spatial component styling or agree on a shared style change with Angelina rather than independently editing global product rules.

Keep existing fonts and models in their established shared asset locations during the scaffold. For new `public/` assets, use a named subdirectory and tell Matthew what was added, its license/provenance, and which interface consumes it. Coordinate generated reconstruction artifacts with the project lead as well. Avoid replacing a shared asset under the same filename without coordinating its consumers.

All contributors must follow root `AGENTS.md`. Before changing application code, read the relevant installed Next.js guides under `node_modules/next/dist/docs/`; this repository explicitly warns against relying on older framework assumptions.

## Handoff contracts

### Backend to the two frontend areas

`backend/contracts.ts` is the shared browser-safe source for application data types. Keep it type-only: no runtime constants, provider SDK initialization, environment reads, private credentials, database clients, or server execution code. Client modules must not import a server service just to obtain a type.

The common contract needs to express, at minimum:

- Stable project, room, item, product-variant, evidence, and asset identities.
- A server-owned plan revision and the expected revision for a mutation.
- Metric geometry, explicit axes, and transforms that the viewer can render.
- Locked items, functional requirements, and the user's budget definition.
- Product evidence, exact variants, known prices, and unknown costs.
- Async job state, review-required outcomes, and usable error information.
- Proposed changes separately from accepted changes and completed commerce actions.

These responsibilities follow the [proposed data model](data-model.md); exact exported type names and fields must match the code that is actually introduced. Do not create parallel definitions of the same room or product in `frontend/`, `spatial/`, and `reconstruction/`.

### Reconstruction to backend

`reconstruction/contracts.ts` defines the adapter/job boundary. The project lead, who owns reconstruction, and Matthew, who owns backend, agree on its inputs and outputs before implementing a model or worker. Inputs should identify the project, source evidence, relevant geometry revision, and confirmed dimensions. Outputs should identify the actual job state, geometry proposal or confirmed artifact, evidence/provenance, and input revision.

Blender output needs an editable source artifact and an optimized runtime model, with scale and generator metadata. A failed or uncertain reconstruction must return a reviewable outcome rather than a successful-looking empty room. Model choice, GPU host, storage, queue, and deployment provider remain open until selected and tested.

The project lead owns reconstruction-specific implementation behind this boundary. Changes to common application types go through Matthew; changes to the reconstruction boundary are agreed with its backend consumer. Neither side should silently redefine units or treat an inferred dimension as measured.

### Product UI to spatial UI

Angelina supplies the accepted plan, current selection, and relevant view state through agreed component props or a shared state boundary. Silas renders that data and emits explicit events, such as selecting an item or proposing a placement change. The exact callback names are implementation choices to agree on together.

Use stable item IDs rather than visible labels or mesh names. Local hover, camera position, and a drag preview can remain in the viewer. Accepted furniture placement, locks, budget, and basket state belong to the application plan. A local preview must not quietly become an accepted revision.

The viewer should not independently research products, recalculate merchant prices, authorize purchases, or introduce its own copy of the canonical plan. Product panels should not infer physical SKU dimensions from a rotated mesh bounding box. Selection and dimensional evidence must describe the same item.

### Capture UI to reconstruction

Angelina owns camera permission screens, capture guidance, upload interaction, progress presentation, and measurement correction UI. The project lead owns processing uploaded material, quality observations, reconstruction proposals, and generated artifacts. Matthew's backend coordinates authorized uploads and job execution.

Agree on media references, capture metadata, required measurement prompts, progress stages, and retry/review outcomes before building both sides. The baseline is guided iPhone browser capture. Native RoomPlan or guaranteed LiDAR scanning is not part of this allocation.

## Initial work, in dependency order

1. **Matthew: establish one shared fixture and contract.** Define stable IDs, meters, money representation, revision semantics, and the smallest room/product/evidence shape. Use a clearly labeled synthetic or measured sample. Share the real exported types before parallel implementation depends on them.
2. **Silas and Angelina: preserve the existing landing experience.** Confirm page composition and styles live in `frontend/`, scene rendering lives in `spatial/`, and thin `app/` entry points still load the same hero. Do not combine the move with a product rename or design overhaul.
3. **Silas: render the common fixture.** Replace only the necessary hardcoded assumptions, expose selected item IDs, and keep mesh bounds separate from product dimensions. Prove desktop and touch selection before adding Quest behavior.
4. **Angelina: build the surrounding fixture-backed flow.** Add the address/capture choice, confirmation and brief states, product details, locked-item controls, revision diff, and basket review. Explicitly mark fixture data and unavailable actions.
5. **Project lead: establish the reconstruction adapter.** Accept a known geometry input, run controlled shell generation, and return artifact references tied to the input revision. Add address/capture evidence processing behind the same boundary, with measurement review and fallback outcomes.
6. **Matthew: connect shared operations.** Add persistence and real validated plan mutations, then product research, rechecks, and cart preparation. All UI adapters use the same state and operations; choose providers only when their access and runtime needs are known.
7. **Integrate one complete constrained revision.** Preserve the sofa and desk, reduce the budget target, maintain seating for four, and display the actual diff. Record what passes and what remains unknown.
8. **Add the remaining interfaces against stable operations.** Silas evaluates the Quest 3S browser path; Angelina supports the responsive controls and review states; Matthew coordinates voice and Fetch adapters. The project lead improves capture/reconstruction using actual measured results.

Solana remains a separate feature decision. No assignment here approves escrow, a spending mandate, a wallet provider, or x402. Do not implement an additional payment system merely because a folder needs a task.

## Rules that prevent overlapping work

- Work in your primary folder by default. Request a coordinated cross-folder change when a task affects another owner's interface.
- Propose shared contract changes before changing both the producer and consumers. Include the field, units, nullable/unknown behavior, and migration needed.
- Keep route/config integration changes small and let Matthew coordinate them. Do not have multiple people reorganize `app/` or dependency files in parallel.
- Do not rename or move another owner's files as incidental cleanup.
- Do not add an alternative room schema, global state store, upload pipeline, or API client without checking the shared boundary.
- Distinguish fixture-backed behavior from live integrations in code, UI, and handoff notes.
- Preserve the current ASCII landing-page work and Paper Mono typography. The earlier pencil-room renderer remains available; this scaffold does not reverse the newer design change.
- Preserve unrelated work. Resolve a conflict with the affected owner instead of overwriting their branch wholesale.

These are collaboration boundaries, not a prohibition on helping another owner. Agree on a bounded task first so the same file is not being changed independently.

## Branch and integration guidance

Use one short-lived branch per focused change. Example names are `work/backend-room-contract`, `work/reconstruction-shell`, `work/frontend-onboarding`, and `work/spatial-selection`; they are suggestions, not branches created by this document.

Start from the latest shared base, commit a coherent change, and open a reviewable pull request when using the team's review workflow. Coordinate contract PRs first, then update dependent branches. Let Matthew integrate changes that cross the root application wiring or common contracts. Do not force-push another person's branch.

No GitHub handles, branch protection policy, or `CODEOWNERS` mapping has been inferred from people's first names. Add those only after the team supplies the correct account identities and chooses the policy.

## Shared commands and handoff evidence

Run the same root commands from every contributor's checkout:

```bash
npm ci
npm run dev
```

For verification and a production run:

```bash
npm run lint
npm run build
npm run start
```

`npm run start` serves an already produced production build. It does not replace `npm run build`. These commands do not claim that a particular change has passed them.

Each handoff should state the files changed, public contract changes, fixture versus live behavior, checks actually run, and the next unresolved dependency. For capture or Quest work, include the actual device/browser and observed behavior. Use the [demo acceptance plan](demo-and-validation.md) for end-to-end proof once the pieces are connected.
