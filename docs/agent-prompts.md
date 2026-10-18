# Copy-paste agent prompts

These prompts reflect both ownership swaps: **Matthew owns backend, the project lead owns reconstruction, Silas owns spatial, and Angelina owns product frontend**. Earlier chat prompts assigning Matthew to reconstruction are superseded. Each prompt is standalone. Read the current repository before assuming the first milestone is still unfinished.

Local geometry-to-Blender/GLB, address evidence processing, and browser-photo inference now exist. Matthew can consume their boundaries and Silas their artifacts. The user also approved an optional scan-only SwiftUI/RoomPlan companion for iPhone 14 Pro; see [native scan status](native-scan.md) and [reconstruction interfaces](../reconstruction/README.md). Inspect completed work before repeating an earlier milestone.

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

Work primarily in reconstruction/. Continue the existing local input and artifact pipelines:
1. Preserve validated geometry-to-editable-Blender/GLB generation and its shared contract.
2. Keep address evidence, actual photo bytes, inferred dimensions, and user confirmation distinct.
3. Finish the approved thin SwiftUI/RoomPlan companion under reconstruction/ios/ and validated importer under reconstruction/roomplan/; inspect docs/native-scan.md for current status before rebuilding completed work.
4. Preserve private source data, stable IDs, project/job/revision binding, and reviewable failures across all inputs.
5. Verify native compilation, importer/export behavior, and a real iPhone 14 Pro capture separately; report exactly which ran.

Keep reference scan geometry separate from the editable shell. Shopping, design, and Quest remain web-based; the optional scan-only native companion is the specific approved exception. Retain browser photos and address research without requiring tape measurements. Never represent browser photos as LiDAR, vision estimates as measured dimensions, or RoomPlan surfaces as measured wall thickness or guaranteed physical accuracy.

Angelina owns product capture screens; you own processing and the thin native scan companion. Matthew owns upload authorization, persistence, shared contracts, and job coordination. Silas owns browser rendering and Quest interactions. Coordinate boundary changes; do not duplicate room types or commit private captures/large generated artifacts.

The user requests reconstruction work directly on main. Preserve unrelated changes, fetch before publishing, run relevant checks, commit, and push without force-pushing. Report the commit, input/output contract, verified scale/export behavior, and integration instructions.
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
1. Connect the landing CTA to address/unit research or iPhone photo capture, with an optional native-scan handoff where implemented. Photo-only capture must not require tape measurements.
2. Build evidence/layout confirmation and budget/style/keep-item inputs.
3. Build workspace panels for selected furniture, alternatives, locks, and budget.
4. Show revision differences and an exact basket with known versus unknown costs.
5. Provide accessible text/touch controls and honest loading, error, and unavailable states.

Preserve the latest ASCII landing experience and Paper Mono typography. Silas owns renderer internals in spatial/; integrate through agreed props and stable IDs. The project lead owns capture processing and Blender in reconstruction/. Matthew owns backend operations, shared contracts, upload authorization, and root integration.

Do not invent successful scans, uploads, live research, or checkout. Label fixtures and unavailable integrations. Do not duplicate the room schema or create another backend. Coordinate thin root route adapters with Matthew and keep screen composition in frontend/.

Use a dedicated branch, run relevant checks, and commit your focused work. Report the branch, completed flow, fixture/live boundaries, actual verification, and backend interfaces needed. Do not push directly to main.
```
