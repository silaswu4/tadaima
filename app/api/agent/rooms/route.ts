import { z } from "zod";
import { agentRoute } from "@/backend/accounts/http";
import { createRoom } from "@/backend/accounts/service";

const Body = z.object({
  sender: z.string().min(8),
  address: z.string().trim().min(3).max(200),
  unit: z.string().trim().max(20).nullable().default(null),
  label: z.string().trim().min(1).max(40).optional(),
});

export async function POST(req: Request) {
  return agentRoute(req, async () => {
    const { sender, address, unit, label } = Body.parse(await req.json());
    return createRoom(sender, address, unit, label);
  });
}
