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

## Fetch.ai agents (ASI:One)

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Three Agentverse agents, each usable on its own from [ASI:One](https://asi1.ai), that also hire each other through typed protocols. All of them speak the Agent Chat Protocol.

| Agent | Address | Talk to it | Works with |
| --- | --- | --- | --- |
| [`tadaima`](backend/fetch/README.md) | `agent1qdsuu2yjgd0tnddnu79rp8jxdu7zd9lkjgskxasptxukqrdlrv08szru3em` | Set up an account and your room, plan it in plain words, find pieces that fit, check out with an approval step | Hires Scout for live finds (pays per run in testnet FET), asks Fit Check about doorways, Payment Protocol seller for the service fee |
| [`tadaima-scout`](backend/fetch/scout/README.md) | `agent1qf2hhun7qzx43av6t2ed4yytm96wx9cgw3tn9lnh86hu3w0lh7clc5slsxl` | "green velvet sofa under $900, max 2.2 m wide" or paste a product link: live IKEA and Target research with real sizes, prices and links | Sells research to other agents over the TadaimaResearch protocol, paid through the Payment Protocol in testnet FET |
| [`tadaima-fitcheck`](backend/fetch/fitcheck/README.md) | `agent1qw8a0tffhe420xzu7ultv2naf8k80dkwndq79pnn2ha84v0aam906uprl6v` | "will a 2.1 x 0.9 m sofa fit on my 2.4 m wall and through an 80 cm door?": deterministic yes, no or unknown with the numbers | Answers FitRequest from other agents; hires Scout to measure a pasted link |

Run instructions for each agent are in its README. The agents call the same backend operations (`/api/projects`, `/api/agent`) as the web app and voice agent, so ASI:One changes are real revisions of the shopper's room.

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
