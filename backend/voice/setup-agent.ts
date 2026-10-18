/**
 * Creates the ElevenLabs voice agent, or updates it if ELEVENLABS_AGENT_ID is set.
 *   npx tsx --env-file=.env.local backend/voice/setup-agent.ts
 * Prints the agent id to put in ELEVENLABS_AGENT_ID.
 */
import { voiceAgentConfig } from "./agent-config";

async function main() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  const existing = process.env.ELEVENLABS_AGENT_ID;

  const res = await fetch(
    existing ? `https://api.elevenlabs.io/v1/convai/agents/${existing}` : "https://api.elevenlabs.io/v1/convai/agents/create",
    {
      method: existing ? "PATCH" : "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify(voiceAgentConfig),
    },
  );
  const body = await res.json();
  if (!res.ok) {
    console.error(res.status, JSON.stringify(body, null, 2));
    process.exit(1);
  }
  console.log(existing ? `updated ${existing}` : `ELEVENLABS_AGENT_ID=${body.agent_id}`);
}

main();
