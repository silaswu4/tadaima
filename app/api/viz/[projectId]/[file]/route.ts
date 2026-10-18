import { getPlanRevision, getProposal } from "@/backend/plan/store";
import { renderDiffPng, renderPlanPng } from "@/backend/viz/render";
import { vizSigOk } from "@/backend/viz/sign";

/**
 * Signed, immutable room images for chat: r{rev}.png is the plan at a revision,
 * p{proposalId}.png a proposal diff. Node runtime (the default under cacheComponents).
 */

const IMMUTABLE = { "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable" };
const notFound = () => new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request, ctx: RouteContext<"/api/viz/[projectId]/[file]">) {
  const { projectId, file } = await ctx.params;
  // Browser-owned scans are never public chat images, even when development
  // permits unsigned demo images. Pairing doesn't grant a shareable media URL.
  if (projectId.startsWith("proj_room_")) return notFound();
  if (!vizSigOk(`${projectId}/${file}`, new URL(req.url).searchParams.get("s"))) return notFound();
  const m = /^(r|p)([\w-]{1,80})\.png$/.exec(file);
  if (!m) return notFound();
  if (m[1] === "r") {
    if (!/^\d+$/.test(m[2])) return notFound();
    const plan = await getPlanRevision(projectId, Number(m[2]));
    return plan ? renderPlanPng(plan, { headers: IMMUTABLE }) : notFound();
  }
  const proposal = await getProposal(projectId, m[2]);
  const base = proposal && (await getPlanRevision(projectId, proposal.baseRevision));
  if (!proposal || !base) return notFound();
  return renderDiffPng(base, proposal.result, { title: proposal.intent, headers: IMMUTABLE });
}
