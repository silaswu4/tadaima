import { handle } from "@/backend/http";
import { readRoomBody } from "@/backend/session/body";
import { SyncRoomSchema } from "@/backend/session/schema";
import { syncRoomSession } from "@/backend/session/service";

export async function POST(req: Request, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;
  return handle(async () => {
    const body = SyncRoomSchema.parse(await readRoomBody(req));
    return syncRoomSession(req, projectId, body.expectedRevision, body.plan);
  });
}
