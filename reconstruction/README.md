# Reconstruction · Matthew

Owner: **Matthew**. Turn address evidence or browser-captured room media into confirmed geometry and editable/renderable artifacts.

## Scope

- Address/unit lookup, candidate plan extraction, exact-unit versus model/building evidence, and orientation matching.
- Capture quality checks, server-side frame processing, measurement requests, and geometry proposals.
- Geometry confirmation inputs and dimensional provenance.
- Controlled Blender generation, editable `.blend` output, optimized GLB exports, and asset manifests.
- Reconstruction job stages, failures, retries, and scale validation.

## First tasks

1. Read the [capture research](../docs/capture-and-reconstruction.md) and agree on [`backend/contracts.ts`](../backend/contracts.ts).
2. Produce one manually verified room geometry fixture with source evidence.
3. Implement a deterministic Blender shell generator from that geometry.
4. Return artifact references tied to the input project/revision through [`contracts.ts`](contracts.ts).
5. Add address evidence and iPhone-upload processing behind the same confirmed geometry boundary.

## Handoffs

Angelina owns camera permission/capture/upload **UI** in `frontend/`; Matthew owns processing and geometry. The project lead owns upload authorization, persistence, and job coordination. Silas owns rendering, export compatibility checks in the browser, and Quest interactions.

`contracts.ts` is a TypeScript integration boundary, not a requirement to run Blender in JavaScript. Python scripts and a separate worker can live here once introduced. Keep worker dependencies and invocation instructions here; all Next.js application commands still run from the repository root.

Do not place private captures or large generated assets in Git. Do not depend on native RoomPlan or standard iPhone WebXR for the web-only baseline. Keep reference scan geometry separate from the editable shell and furniture. The scaffold does not include a running processor, selected reconstruction model, or Blender installation.

See [team ownership](../docs/team-ownership.md), [data model](../docs/data-model.md), and [architecture](../docs/architecture.md).
