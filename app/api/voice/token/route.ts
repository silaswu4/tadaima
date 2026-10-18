/**
 * Short-lived ElevenLabs conversation token for the browser (WebRTC voice).
 * The API key never leaves the server.
 */
export async function GET() {
  const key = process.env.ELEVENLABS_API_KEY;
  const agent = process.env.ELEVENLABS_AGENT_ID;
  if (!key || !agent) return Response.json({ error: "voice is not configured" }, { status: 503 });
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agent}`, {
    headers: { "xi-api-key": key },
    cache: "no-store",
  });
  if (!res.ok) return Response.json({ error: "could not start a voice session" }, { status: 502 });
  const { token } = (await res.json()) as { token: string };
  return Response.json({ token });
}
