/** Development-only, authenticated bridge for a private room preview over USB. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { timingSafeEqual } from "node:crypto";

export async function localPreviewResponse(request: Request, asset: string, config: {
  mode?: string; directory?: string; token?: string;
} = {
  mode: process.env.NODE_ENV,
  directory: process.env.TADAIMA_LOCAL_CAPTURE_DIR,
  token: process.env.TADAIMA_LOCAL_CAPTURE_TOKEN,
}): Promise<Response> {
  const absent = () => new Response("Unavailable", { status: 404, headers: { "Cache-Control": "no-store" } });
  const url = new URL(request.url);
  if (config.mode !== "development" || !config.directory || !isAbsolute(config.directory)
    || !config.token || config.token.length !== 64 || !/^[a-f0-9]{64}$/.test(config.token)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return absent();
  const provided = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${config.token}`;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return absent();
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) return absent();
  const entry = asset === "scene" ? { name: "scene.json", type: "application/json", max: 2 * 1024 ** 2 }
    : asset === "model" ? { name: "scene.glb", type: "model/gltf-binary", max: 64 * 1024 ** 2 } : null;
  if (!entry) return absent();
  let file;
  try {
    file = await open(join(config.directory, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > entry.max) return absent();
    const body = await file.readFile();
    if (body.byteLength > entry.max) return absent();
    return new Response(new Uint8Array(body), { headers: { "Content-Type": entry.type,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
  } catch { return absent(); }
  finally { await file?.close(); }
}
