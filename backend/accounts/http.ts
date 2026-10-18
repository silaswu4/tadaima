import "server-only";

import { handle } from "@/backend/http";
import { AccountError } from "@/backend/accounts/service";

/**
 * Agent routes act for an ASI:One sender, so only our agent may call them:
 * header x-agent-key must equal AGENT_API_KEY. Local dev without the env var
 * is open; production without it refuses.
 */
export async function agentRoute(req: Request, fn: () => Promise<unknown>) {
  const key = process.env.AGENT_API_KEY;
  if (key ? req.headers.get("x-agent-key") !== key : process.env.NODE_ENV === "production") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return handle(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AccountError) return Response.json({ error: e.message }, { status: 409 });
      throw e;
    }
  });
}
