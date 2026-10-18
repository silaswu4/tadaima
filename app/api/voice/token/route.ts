/**
 * Short-lived ElevenLabs conversation token for the browser (WebRTC voice).
 * The API key never leaves the server. An account with no credits left would
 * connect and get hung up on at once, so that's checked first and said plainly.
 */
const MIN_CREDITS = 200;

export async function GET() {
  const key = process.env.ELEVENLABS_API_KEY;
  const agent = process.env.ELEVENLABS_AGENT_ID;
  if (!key || !agent) return Response.json({ error: "voice is not configured" }, { status: 503 });
  const headers = { "xi-api-key": key };
  const [res, sub] = await Promise.all([
    fetch(`https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agent}`, { headers, cache: "no-store" }),
    // best effort: a key without account access just skips this check
    fetch("https://api.elevenlabs.io/v1/user/subscription", { headers, cache: "no-store" }).catch(() => null),
  ]);
  if (sub?.ok) {
    const { character_count: used, character_limit: limit } = (await sub.json()) as { character_count?: number; character_limit?: number };
    if (typeof used === "number" && typeof limit === "number" && limit - used < MIN_CREDITS) {
      return Response.json({ error: "Voice is out of ElevenLabs credits. Add credits to talk to the room." }, { status: 402, headers: { "Cache-Control": "no-store" } });
    }
  }
  if (!res.ok) return Response.json({ error: "could not start a voice session" }, { status: 502 });
  const { token } = (await res.json()) as { token: string };
  return Response.json({ token }, { headers: { "Cache-Control": "no-store" } });
}
