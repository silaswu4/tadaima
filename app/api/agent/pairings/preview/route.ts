import { z } from "zod";
import { handle } from "@/backend/http";
import { requestFetchPreview } from "@/backend/session/fetch";
import { readRoomBody } from "@/backend/session/body";
const Body = z.object({ productId: z.string().min(1).max(200), jobId: z.string().min(1).max(200) });
export async function POST(req: Request) {
  return handle(async () => requestFetchPreview(req, Body.parse(await readRoomBody(req, 1024))));
}
