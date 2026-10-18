import { z } from "zod";
import { handle } from "@/backend/http";
import { redeemFetchPairing } from "@/backend/session/fetch";
import { readRoomBody } from "@/backend/session/body";

const Body = z.object({ code: z.string().regex(/^[a-f0-9]{32}$/), sender: z.string().min(1).max(128).regex(/^[a-zA-Z0-9:_-]+$/) });
export async function POST(req: Request) {
  return handle(async () => {
    const { code, sender } = Body.parse(await readRoomBody(req, 1024));
    return redeemFetchPairing(code, sender);
  });
}
