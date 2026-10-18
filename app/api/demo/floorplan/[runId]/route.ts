import { handle } from "@/backend/http";
import { getFloorplanBrowse, stopFloorplanBrowse } from "@/backend/research/floorplanBrowse";

/** Poll the live browse: status, the embeddable live view once open, and the agent's latest steps. */
export async function GET(_req: Request, ctx: RouteContext<"/api/demo/floorplan/[runId]">) {
  const { runId } = await ctx.params;
  return handle(() => getFloorplanBrowse(runId));
}

/** Stop it early (the shopper skipped the lobby). */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/demo/floorplan/[runId]">) {
  const { runId } = await ctx.params;
  return handle(async () => { await stopFloorplanBrowse(runId); return { ok: true }; });
}
