<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Team working areas

Read `docs/team-ownership.md` and the relevant folder README before editing.

The user requests reconstruction work directly on `main`. Preserve concurrent commits, fetch before pushing, and never force-push the shared branch.

| Area | Owner | Boundary |
| --- | --- | --- |
| `backend/` | Matthew | Shared contracts, services, shopping agents, sponsor adapters, integration |
| `reconstruction/` | User / project lead | Address/capture processing, metric geometry, Blender, generated artifacts |
| `frontend/` | Angelina | Product screens, capture UI, responsive styles, product/basket panels |
| `spatial/` | Silas | Three.js viewer, selection, rendering, Quest/WebXR interactions |

This is one Next.js application. Keep root `app/` as thin route/layout/API wiring and coordinate root configuration and dependency changes with Matthew, the backend integration owner. Do not create four independent apps or duplicate shared room types. `backend/contracts.ts` is browser-safe and type-only; keep server implementations and secrets out of client imports. Coordinate changes to another owner's files and shared interfaces. The current hero remains a demonstration scene, not a live reconstruction or shopping integration.
