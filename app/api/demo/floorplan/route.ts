import { z } from "zod";
import { handle } from "@/backend/http";
import { startFloorplanBrowse } from "@/backend/research/floorplanBrowse";

const Body = z.object({ address: z.string().trim().min(3).max(300) });

// one live browse per visitor per minute: each run costs real money
const lastStart = new Map<string, number>();
const COOLDOWN_MS = 60_000;

/** Start the demo lobby's live floorplan browse. Returns the run id to poll. */
export async function POST(req: Request) {
  return handle(async () => {
    if (!process.env.BROWSER_USE_API_KEY || process.env.DEMO_LIVE_BROWSE === "0") return Response.json({ error: "live browsing is off" }, { status: 503 });
    const who = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const now = Date.now();
    if (now - (lastStart.get(who) ?? 0) < COOLDOWN_MS) return Response.json({ error: "one live browse a minute" }, { status: 429 });
    lastStart.set(who, now);
    const { address } = Body.parse(await req.json());
    return startFloorplanBrowse(address);
  });
}
