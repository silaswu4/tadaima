// Client for the demo lobby's live floorplan browse (app/api/demo/floorplan). The live view url is a session
// credential for that browser: it only ever lives in memory and an iframe src, never logged or stored.

export interface BrowsePoll {
  status: string;
  done: boolean;
  liveUrl: string | null;
  steps: string[];
}

export type BrowseStart = { ok: true; runId: string } | { ok: false; reason: "busy" | "off" | "error" };

export async function startBrowse(address: string, signal?: AbortSignal): Promise<BrowseStart> {
  try {
    const res = await fetch("/api/demo/floorplan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: address.slice(0, 300) }),
      signal,
    });
    if (res.status === 429) return { ok: false, reason: "busy" };
    if (res.status === 503) return { ok: false, reason: "off" };
    if (!res.ok) return { ok: false, reason: "error" };
    const body = (await res.json()) as { runId?: unknown };
    return typeof body.runId === "string" ? { ok: true, runId: body.runId } : { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

const LONG_DASH = new RegExp("\\s*[\\u2013\\u2014]\\s*", "g");
/** The agent writes freely; keep its lines in the page's own plain punctuation. */
const plain = (s: string) => s.replace(LONG_DASH, ", ").replace(/\s+/g, " ").trim();

export async function pollBrowse(runId: string, signal?: AbortSignal): Promise<BrowsePoll | null> {
  try {
    const res = await fetch(`/api/demo/floorplan/${encodeURIComponent(runId)}`, { cache: "no-store", signal });
    if (!res.ok) return null;
    const b = (await res.json()) as Partial<BrowsePoll>;
    return {
      status: String(b.status ?? ""),
      done: Boolean(b.done),
      liveUrl: typeof b.liveUrl === "string" && /^https:\/\//.test(b.liveUrl) ? b.liveUrl : null,
      steps: Array.isArray(b.steps) ? b.steps.filter((s): s is string => typeof s === "string").map(plain) : [],
    };
  } catch {
    return null;
  }
}

/** Stop the run. keepalive so it still goes out while the page is navigating away. */
export function stopBrowse(runId: string) {
  fetch(`/api/demo/floorplan/${encodeURIComponent(runId)}`, { method: "DELETE", keepalive: true }).catch(() => {});
}

/** The site the agent seems to be on, from its own words, for the frame's address bar. */
export function siteFromSteps(steps: string[], fallback: string): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const m = steps[i].match(/\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|co))\b/i);
    if (m) return m[1].toLowerCase().replace(/^www\./, "");
  }
  return fallback;
}
