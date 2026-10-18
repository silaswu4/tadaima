/**
 * Server-only bridge between the web app and the reconstruction service.
 *
 * The phone uploads its TadaimaScan export here; the service token never leaves
 * the server. Callers must be on this machine (the /rooms inbox on localhost) or
 * present TADAIMA_SCAN_UPLOAD_KEY (the phone app).
 */
import "server-only";
import { timingSafeEqual } from "node:crypto";

const JOB_ID = /^[0-9a-f]{32}$/;
const ASSETS = {
  scene: { path: "draft/scene.json", type: "application/json" },
  model: { path: "draft/scene.glb", type: "model/gltf-binary" },
} as const;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NO_STORE = { "Cache-Control": "no-store" };

export type ScanAsset = keyof typeof ASSETS;

interface ServiceJob {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  finishedAt: string | null;
  result: { status?: string; warnings?: string[]; photoCount?: number; importedItemCount?: number } | null;
  error: { error: string; message: string } | null;
  artifacts: { name: string }[];
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function config(): { url: string; token: string } | null {
  const url = process.env.TADAIMA_SERVICE_URL, token = process.env.TADAIMA_SERVICE_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

function sameSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Local browser on this machine, or the phone holding the upload key. */
function authorized(request: Request): boolean {
  const key = process.env.TADAIMA_SCAN_UPLOAD_KEY;
  const provided = request.headers.get("x-tadaima-upload-key");
  if (key && provided && sameSecret(provided, key)) return true;
  // request.url reflects the bind address (0.0.0.0 when serving the phone), so use the Host header.
  const host = request.headers.get("host");
  return !!host && LOOPBACK.has(new URL(`http://${host}`).hostname);
}

async function service(path: string, init: RequestInit & { duplex?: "half" } = {}): Promise<Response> {
  const settings = config();
  if (!settings) throw new ScanServiceUnavailable();
  try {
    return await fetch(settings.url + path, {
      ...init, cache: "no-store", redirect: "error",
      headers: { ...init.headers, authorization: `Bearer ${settings.token}` },
    });
  } catch (cause) {
    console.error("reconstruction service unreachable", cause);
    throw new ScanServiceUnavailable();
  }
}

class ScanServiceUnavailable extends Error {}

/** Map a service job to what the phone and inbox need; never forward private paths. */
function summarize(job: ServiceJob) {
  const names = new Set(job.artifacts.map((artifact) => artifact.name));
  return {
    id: job.id, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt,
    roomStatus: job.result?.status ?? null,
    warnings: job.result?.warnings ?? [],
    photoCount: job.result?.photoCount ?? null,
    itemCount: job.result?.importedItemCount ?? null,
    ready: job.status === "succeeded" && names.has(ASSETS.scene.path) && names.has(ASSETS.model.path),
    error: job.error?.message ?? null,
  };
}

async function guarded(request: Request, work: () => Promise<Response>): Promise<Response> {
  if (!authorized(request)) return json({ error: "not authorized" }, 401);
  try { return await work(); }
  catch (cause) {
    if (cause instanceof ScanServiceUnavailable) return json({ error: "The reconstruction service is not running or not configured." }, 503);
    throw cause;
  }
}

export function uploadScan(request: Request): Promise<Response> {
  return guarded(request, async () => {
    if (!request.body) return json({ error: "empty upload" }, 400);
    const contentLength = request.headers.get("content-length");
    const response = await service("/v1/jobs/roomplan?render=true", {
      method: "POST", body: request.body, duplex: "half",
      headers: { "content-type": request.headers.get("content-type") ?? "application/octet-stream",
                 ...(contentLength ? { "content-length": contentLength } : {}) },
    });
    const body = await response.json();
    if (!response.ok) return json({ error: body?.detail?.message ?? "The scan was rejected." }, response.status);
    return json(summarize(body as ServiceJob), 202);
  });
}

export function listScans(request: Request): Promise<Response> {
  return guarded(request, async () => {
    const response = await service("/v1/jobs?kind=roomplan&limit=10");
    if (!response.ok) return json({ error: "Scans could not be listed." }, 502);
    const { jobs } = await response.json() as { jobs: ServiceJob[] };
    return json({ scans: jobs.map(summarize) });
  });
}

export function getScan(request: Request, id: string): Promise<Response> {
  return guarded(request, async () => {
    if (!JOB_ID.test(id)) return json({ error: "not found" }, 404);
    const response = await service(`/v1/jobs/${id}`);
    if (!response.ok) return json({ error: "not found" }, response.status === 404 ? 404 : 502);
    return json(summarize(await response.json() as ServiceJob));
  });
}

export function getScanAsset(request: Request, id: string, asset: string): Promise<Response> {
  return guarded(request, async () => {
    const entry = ASSETS[asset as ScanAsset];
    if (!JOB_ID.test(id) || !entry) return json({ error: "not found" }, 404);
    const response = await service(`/v1/jobs/${id}/artifacts/${entry.path}`);
    if (!response.ok || !response.body) return json({ error: "not found" }, 404);
    const length = response.headers.get("content-length");
    return new Response(response.body, { headers: {
      "Content-Type": entry.type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      ...(length ? { "Content-Length": length } : {}),
    } });
  });
}
