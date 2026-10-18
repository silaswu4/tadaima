# Frontend · Angelina

Owner: **Angelina**. Build the desktop and mobile product interface around the shared room plan and Silas's spatial viewer.

## Existing code

- [`HomePage.tsx`](HomePage.tsx): latest landing-page content, composed with the ASCII hero.
- [`styles/globals.css`](styles/globals.css): existing global styles, design tokens, and grain treatment.
- Root `app/page.tsx` mounts `HomePage`; root `app/layout.tsx` imports these styles and the existing font.

## Scope and first tasks

1. Build the two onboarding choices: address/unit and iPhone guided capture/upload.
2. Add evidence/layout confirmation and budget/style/keep-item inputs.
3. Build the room workspace panels: item details, product comparison, locks, and budget.
4. Show plan revision diffs and the exact basket with known/unknown costs.
5. Connect controls to Matthew's validated backend operations.
6. Coordinate Paper design work and responsive/accessibility checks.

Camera permission, capture controls, and upload progress UI belong here; the project lead processes the uploaded media in `reconstruction/`. Matthew owns Browser Use execution, provider secrets, payments, and persistence in `backend/`. Silas owns Three.js internals, WebXR, raycasting, and the viewer lifecycle in `spatial/`.

## Integration rules

Import the viewer component directly, as the existing homepage does. Agree on selected-item IDs, plan revision, and callback props with Silas before wiring the editor. The current hero is a demo scene, not yet a `RoomPlan` viewer; do not claim it renders the scaffold contract until it does.

Use type-only imports from `@/backend/contracts` for shared data. Keep backend implementation imports out of client components. Work in this folder for screen composition; coordinate thin root `app/` route adapters with Matthew when adding routes.

Preserve the latest ASCII landing-page work, Paper Mono, sentence case, and direct copy. The earlier pencil-style room renderer is retained in `spatial/`; do not replace the newer homepage while extending it. Do not change product naming as part of the folder scaffold. Read [team ownership](../docs/team-ownership.md) and [platform UX](../docs/platforms-and-ux.md). Run application commands from the repository root.
