# Copy-paste agent prompts

These prompts reflect both ownership swaps: **Matthew owns backend, the project lead owns reconstruction, Silas owns spatial, and Angelina owns product frontend**. Earlier chat prompts assigning Matthew to reconstruction are superseded. Each prompt is standalone. Read the current repository before assuming the first milestone is still unfinished.

## Matthew: backend and agents

```text
You own backend for https://github.com/silaswu4/tadaima.

Read AGENTS.md, docs/team-ownership.md, backend/README.md, docs/architecture.md, docs/agent-and-shopping.md, backend/contracts.ts, and reconstruction/contracts.ts first. Inspect the current implementation and preserve existing work.

Work primarily in backend/. Your first milestone is a shared, validated application boundary:
1. Refine the browser-safe shared contract with its consumers and provide one clearly labeled fixture.
2. Implement project/plan reads and validated revision writes, including stale-write rejection and locked-item preservation.
3. Define async job/status handling and integrate the project lead's reconstruction boundary.
4. Expose constrained planning and product research through the same operations used by the frontend, voice, and ASI:One.
5. Add exact-basket review and verified cart preparation before any payment work.

Coordinate root app/ route adapters, configuration, dependencies, and integration. Keep contracts.ts type-only and provider secrets server-side. Use existing patterns and the installed Next.js guides; do not create another app or duplicate schemas.

The project lead owns reconstruction/, Silas owns spatial/, and Angelina owns frontend/. Solana's specific feature remains undecided; x402 was rejected. Do not fabricate live integrations or place purchases.

Use a dedicated branch, run relevant checks, and commit your focused work. Report the branch, operation contracts, fixture/live boundaries, actual verification, and integration instructions. Do not push directly to main.
```

## Project lead: reconstruction

```text
You own reconstruction for https://github.com/silaswu4/tadaima. Matthew owns backend and shared application integration.

Read AGENTS.md, docs/team-ownership.md, reconstruction/README.md, docs/capture-and-reconstruction.md, backend/contracts.ts, and reconstruction/contracts.ts first. Inspect current work before implementing anything already completed.

Work primarily in reconstruction/. Your first milestone is a deterministic geometry-to-Blender pipeline:
1. Create a clearly labeled synthetic room fixture using the shared geometry contract.
2. Validate geometry and generate editable, named walls, floor, doors, and windows.
3. Export an editable .blend and correctly scaled GLB.
4. Return artifact references tied to the project, job, generator version, and input revision.
5. Document installation, execution, and verification using a known measurement.

Start with controlled procedural geometry before adding neural reconstruction or address research. Keep reference scan geometry separate from the editable shell. The product is web-only: no required native RoomPlan or assumed iPhone WebXR scanning, and no unsupported measurement claims.

Angelina owns camera/capture UI; you own processing. Matthew owns upload authorization, persistence, shared contracts, and job coordination. Silas owns browser rendering and Quest interactions. Coordinate boundary changes; do not duplicate room types or commit private captures/large generated artifacts.

Use a dedicated branch, run relevant checks, and commit your focused work. Report the branch, input/output contract, verified scale/export behavior, and integration instructions. Do not push directly to main.
```

## Silas: spatial frontend

```text
You own the spatial frontend for https://github.com/silaswu4/tadaima.

Read AGENTS.md, docs/team-ownership.md, spatial/README.md, docs/platforms-and-ux.md, and backend/contracts.ts first. Inspect existing work before starting.

Work primarily in spatial/. Your first milestone is a data-driven room viewer:
1. Render a shared RoomPlan fixture rather than relying exclusively on hardcoded scene data.
2. Use stable item IDs and expose selection callbacks for Angelina's panels.
3. Support metric placement, rotation, selection highlighting, and locked-item indicators.
4. Keep physical product dimensions separate from rotated mesh bounding boxes.
5. Verify desktop/touch interaction, resizing, asset loading, and cleanup before adding Quest 3S WebXR.

Preserve the latest ASCII homepage renderer and retain the earlier pencil-room renderer. The test video is deliberately gitignored. Keep heavy renderer code lazy-loaded and backend implementations out of client imports.

Angelina owns surrounding screens in frontend/. Matthew owns canonical state, shared contracts, and shopping in backend/. The project lead owns geometry and Blender artifacts in reconstruction/. Agree on viewer props/callbacks with Angelina and artifact compatibility with the project lead. Do not create a competing plan store or claim untested headset support.

Use a dedicated branch, run relevant checks, and commit your focused work. Report the branch, component API, actual verification, and integration instructions. Do not push directly to main.
```

## Angelina: product frontend

```text
You own the product frontend for https://github.com/silaswu4/tadaima.

Read AGENTS.md, docs/team-ownership.md, frontend/README.md, docs/product.md, docs/platforms-and-ux.md, and backend/contracts.ts first. Inspect existing work before starting.

Work primarily in frontend/. Your first milestone is a coherent desktop/mobile flow using clearly labeled fixture data:
1. Connect the landing CTA to address/unit research or iPhone guided capture.
2. Build evidence/layout confirmation and budget/style/keep-item inputs.
3. Build workspace panels for selected furniture, alternatives, locks, and budget.
4. Show revision differences and an exact basket with known versus unknown costs.
5. Provide accessible text/touch controls and honest loading, error, and unavailable states.

Preserve the latest ASCII landing experience and Paper Mono typography. Silas owns renderer internals in spatial/; integrate through agreed props and stable IDs. The project lead owns capture processing and Blender in reconstruction/. Matthew owns backend operations, shared contracts, upload authorization, and root integration.

Do not invent successful scans, uploads, live research, or checkout. Label fixtures and unavailable integrations. Do not duplicate the room schema or create another backend. Coordinate thin root route adapters with Matthew and keep screen composition in frontend/.

Use a dedicated branch, run relevant checks, and commit your focused work. Report the branch, completed flow, fixture/live boundaries, actual verification, and backend interfaces needed. Do not push directly to main.
```
