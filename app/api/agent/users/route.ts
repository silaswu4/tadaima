import { z } from "zod";
import { agentRoute } from "@/backend/accounts/http";
import { createUser, listRooms } from "@/backend/accounts/service";

/** ?sender= → { user, rooms } (user null when this chat has no account yet) */
export async function GET(req: Request) {
  return agentRoute(req, async () => listRooms(z.string().min(8).parse(new URL(req.url).searchParams.get("sender"))));
}

const Body = z.object({ sender: z.string().min(8), name: z.string().trim().min(1).max(80), email: z.email() });

export async function POST(req: Request) {
  return agentRoute(req, async () => {
    const { sender, name, email } = Body.parse(await req.json());
    return createUser(sender, name, email);
  });
}
