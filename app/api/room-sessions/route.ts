import { handle } from "@/backend/http";
import { readRoomBody } from "@/backend/session/body";
import { RegisterRoomSchema } from "@/backend/session/schema";
import { registerRoomSession } from "@/backend/session/service";

export async function POST(req: Request) {
  return handle(async () => {
    const body = RegisterRoomSchema.parse(await readRoomBody(req));
    const result = await registerRoomSession(req, body.roomId, body.plan);
    return Response.json(result.payload, { headers: { "Set-Cookie": result.cookie, "Cache-Control": "no-store" } });
  });
}
