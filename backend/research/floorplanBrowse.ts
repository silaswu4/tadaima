/**
 * The demo lobby's live browsing: a real Browser Use run that goes looking for
 * an address's floorplan while the shopper watches its live view. The result
 * is seeded (the demo always builds the same studio), but the browsing is real.
 *
 * SERVER ONLY. The live view url is a session credential: it's handed to the
 * shopper's own browser to embed, never stored or logged.
 */

const API = "https://api.browser-use.com/api/v4";
/** Where the demo building lists its floorplans. */
export const DEMO_LISTING = "https://www.atrium-westwood.com/";

type Event = { id: number; type: string; data: Record<string, unknown> };
export interface BrowseStatus {
  runId: string;
  status: string;
  done: boolean;
  /** Embeddable live view of the browser, once it's open. */
  liveUrl: string | null;
  /** What the browsing agent is doing, newest last, in its own words. */
  steps: string[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const key = process.env.BROWSER_USE_API_KEY;
  if (!key) throw new Error("live browsing isn't configured");
  const res = await fetch(`${API}${path}`, { ...init, headers: { "X-Browser-Use-API-Key": key, "Content-Type": "application/json", ...init?.headers }, cache: "no-store" });
  if (!res.ok) throw new Error(`Browser Use ${init?.method ?? "GET"} ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export async function startFloorplanBrowse(address: string): Promise<{ runId: string }> {
  const task = [
    `Find the floor plans for the apartment building at ${address}.`,
    `Start at ${DEMO_LISTING} (Atrium Westwood).`,
    "Open its floor plans or apartments page and find the studio or smallest unit's floor plan.",
    "Open that floor plan so it is visible on screen, then stop and report its name, size and square footage if shown.",
    "Close any cookie or chat popups. Don't fill in forms or contact anyone.",
  ].join(" ");
  const run = await api<{ id: string }>("/runs", { method: "POST", body: JSON.stringify({ task, maxCostUsd: 0.4 }) });
  return { runId: run.id };
}

/** One readable line from a run event, or null for noise. */
function line(e: Event): string | null {
  const d = e.data ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = d[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  const text = pick("next_goal", "nextGoal", "goal", "thinking", "memory", "message", "description", "action", "title");
  if (text) return text.length > 140 ? `${text.slice(0, 137)}...` : text;
  if (e.type === "browser.ready") return "Browser open";
  return null;
}

export async function getFloorplanBrowse(runId: string): Promise<BrowseStatus> {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(runId)) throw new Error("bad run id");
  const [{ status }, ev] = await Promise.all([
    api<{ status: string }>(`/runs/${runId}/status`),
    api<{ events: Event[] }>(`/runs/${runId}/events?after=0&include_output=false&limit=100`).catch(() => ({ events: [] as Event[] })),
  ]);
  const ready = ev.events.find((e) => e.type === "browser.ready" || e.type === "browser.reattached");
  const url = ready?.data?.live_view_url;
  const steps = ev.events.map(line).filter((s): s is string => !!s);
  return {
    runId,
    status,
    done: ["completed", "failed", "cancelled"].includes(status),
    liveUrl: typeof url === "string" ? url : null,
    steps: [...new Set(steps)].slice(-12),
  };
}

export async function stopFloorplanBrowse(runId: string) {
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(runId)) return;
  await api(`/runs/${runId}/cancel`, { method: "POST" }).catch(() => null);
}
