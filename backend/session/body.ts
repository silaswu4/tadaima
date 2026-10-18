import { RoomSessionError } from "./service";

/** Stream before JSON parsing so a missing Content-Length cannot bypass limits. */
export async function readRoomBody(req: Request, limit = 2 * 1024 * 1024): Promise<unknown> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new RoomSessionError("expected application/json", 415);
  if (Number(req.headers.get("content-length")) > limit) throw new RoomSessionError("room request is too large", 413);
  const reader = req.body?.getReader();
  if (!reader) throw new RoomSessionError("missing room data", 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new RoomSessionError("room request is too large", 413); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RoomSessionError("invalid room JSON", 400); }
}
