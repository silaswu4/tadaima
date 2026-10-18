import { z } from "zod";
import { agentRoute } from "@/backend/accounts/http";
import { createRoom, roomTemplates } from "@/backend/accounts/service";

const Body = z.object({
  sender: z.string().min(8),
  address: z.string().trim().min(3).max(200),
  unit: z.string().trim().max(20).nullable().default(null),
  label: z.string().trim().min(1).max(40).optional(),
  template: z.string().regex(/^[a-z-]{2,40}$/).nullable().optional(),
});

/** Demo rooms a chat can start from. */
export async function GET(req: Request) {
  return agentRoute(req, async () => ({ templates: roomTemplates() }));
}

export async function POST(req: Request) {
  return agentRoute(req, async () => {
    const { sender, address, unit, label, template } = Body.parse(await req.json());
    return createRoom(sender, address, unit, label, template ?? null);
  });
}
