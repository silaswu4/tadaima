/** CORS-safe public product photos for the same web card when drawn into WebXR. */
export function retailerImageURL(value: string | null): URL | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    const ikea = url.hostname === "www.ikea.com" && /^\/us\/en\/images\/products\/[a-z0-9_./-]+\.(jpg|jpeg|png|webp|avif)$/i.test(url.pathname);
    const target = url.hostname === "target.scene7.com" && /^\/is\/image\/Target\/[a-z0-9_./-]+$/i.test(url.pathname);
    return ikea || target ? url : null;
  } catch { return null; }
}

const MAX_BYTES = 5 * 1024 * 1024;
const error = (message: string, status: number) => Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });

export async function productImageResponse(request: Request, fetchImage: typeof fetch = fetch): Promise<Response> {
  const url = retailerImageURL(new URL(request.url).searchParams.get("url"));
  if (!url) return error("Unsupported product image.", 400);
  try {
    // Exact merchant hosts/paths only. Never follow a redirect to another origin,
    // forward cookies/credentials, or buffer an unbounded remote response.
    const upstream = await fetchImage(url, { redirect: "error", signal: AbortSignal.timeout(10000), credentials: "omit" });
    const type = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!upstream.ok || !upstream.body || !type || !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(type)) {
      await upstream.body?.cancel();
      return error("Product image unavailable.", 502);
    }
    if (Number(upstream.headers.get("content-length")) > MAX_BYTES) {
      await upstream.body.cancel();
      return error("Product image too large.", 413);
    }
    const reader = upstream.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { await reader.cancel(); return error("Product image too large.", 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (!size) return error("Product image unavailable.", 502);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new Response(bytes, { headers: { "Content-Type": type, "Content-Length": String(size),
      "Cache-Control": "public, max-age=86400, s-maxage=86400", "X-Content-Type-Options": "nosniff" } });
  } catch { return error("Product image unavailable.", 502); }
}
