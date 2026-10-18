# Tadaima

Project context, product decisions, architecture, capture research, sponsor requirements, Solana options, and the implementation plan live in **[docs/README.md](docs/README.md)**. Start there before building. The product, UI and package are named tadaima (Michael was the working name). The homepage uses the latest WebGL ASCII hero; the earlier Three.js room hero is retained in `spatial/`.

## Team working folders

| Folder | Owner | Work |
| --- | --- | --- |
| [`backend/`](backend/README.md) | Matthew | Shared contracts, agents, shopping, services, integration |
| [`reconstruction/`](reconstruction/README.md) | You / project lead | Address/capture processing, room geometry, Blender exports |
| [`frontend/`](frontend/README.md) | Angelina | Screens, onboarding, responsive UI, products and basket |
| [`spatial/`](spatial/README.md) | Silas | 3D viewer, selection, placement, Quest/browser interaction |

See [team ownership and first tasks](docs/team-ownership.md) and [copy-paste agent prompts](docs/agent-prompts.md). These are four working areas inside one web application; run the commands below from the repository root. `app/` holds thin Next.js entry points and `public/` holds shared static assets. The approved optional iPhone RoomPlan companion lives under reconstruction; shopping, design, and Quest remain on the web.

The [reconstruction worker](reconstruction/README.md) converts validated room geometry to an editable `.blend`, a GLB, and a revision-bound manifest. Local [address research](reconstruction/address/README.md) and [browser photo capture/inference](reconstruction/capture/README.md) feed the same worker. Photo-only input does not require tape measurements; its visual estimates remain uncalibrated and require review. Hosted upload authorization, persistence, and job integration are still pending.

The user also approved a thin SwiftUI/RoomPlan companion for an **iPhone 14 Pro**. See [native scanning and import status](docs/native-scan.md) before building or claiming device support. Native capture is an optional input, not a replacement shopping app; a physical iPhone scan has not yet been verified. [Modeling/export research](reconstruction/RESEARCH.md) remains applicable to all inputs.

## Application setup

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

Edit the screen in `frontend/HomePage.tsx` and the current hero in `spatial/components/AsciiHero.tsx`. The earlier 3D viewer is in `spatial/components/RoomHero.tsx`. The root `app/page.tsx` mounts the screen. The page auto-updates as you edit the files.

The current ASCII hero references `/art/japan.mp4`, a test clip intentionally excluded by `.gitignore`. A fresh clone will not include that background footage; supply an appropriately licensed asset before shipping it. The scaffold preserves the incoming hero without adding third-party test media.

This project uses `next/font/local` to load the bundled Paper Mono typeface. Its license is in [app/fonts/PaperMono-OFL.txt](app/fonts/PaperMono-OFL.txt).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
