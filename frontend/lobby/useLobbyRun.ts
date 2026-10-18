"use client";
// Drives the lobby: plays the scripted stages at a real-work pace and, in the browse stage, follows a live
// Browser Use run (its live view and its own steps), falling back to a replay so the demo never stalls.
// The gist timeline read agent_tasks rows through usePipelineRun; this is that hook's stand-in.
import { useEffect, useReducer } from "react";
import { pollBrowse, siteFromSteps, startBrowse, stopBrowse, type BrowseStart } from "./liveBrowse";
import {
  BROWSE_MAX_MS,
  DEMO_BUILDING,
  LIVE_VIEW_TIMEOUT_MS,
  PLAN_ORDER,
  POLL_MS,
  PULL_STEP,
  STAGES,
  script,
  type PlanPhase,
  type StageId,
} from "./stages";

export type StageState = "pending" | "working" | "done";
export interface StageRun {
  id: StageId;
  state: StageState;
  steps: string[];
}
export type BrowseMode = "starting" | "live" | "replay";
export interface LobbyState {
  stages: Record<StageId, StageRun>;
  revealed: StageId[];
  plan: PlanPhase;
  browse: { mode: BrowseMode; liveUrl: string | null; site: string };
  finished: boolean;
}

type Action =
  | { type: "reset" }
  | { type: "start"; id: StageId }
  | { type: "step"; id: StageId; text: string }
  | { type: "steps"; id: StageId; steps: string[] }
  | { type: "done"; id: StageId }
  | { type: "plan"; plan: PlanPhase }
  | { type: "browse"; browse: Partial<LobbyState["browse"]> }
  | { type: "finished" };

const initial = (): LobbyState => ({
  stages: Object.fromEntries(STAGES.map((s): [StageId, StageRun] => [s.id, { id: s.id, state: "pending", steps: [] }])) as Record<StageId, StageRun>,
  revealed: [],
  plan: "empty",
  browse: { mode: "starting", liveUrl: null, site: DEMO_BUILDING.site },
  finished: false,
});

function reducer(s: LobbyState, a: Action): LobbyState {
  const patch = (id: StageId, p: Partial<StageRun>) => ({ ...s, stages: { ...s.stages, [id]: { ...s.stages[id], ...p } } });
  switch (a.type) {
    case "reset":
      return initial();
    case "start":
      return { ...patch(a.id, { state: "working" }), revealed: s.revealed.includes(a.id) ? s.revealed : [...s.revealed, a.id] };
    case "step":
      return patch(a.id, { steps: [...s.stages[a.id].steps, a.text] });
    case "steps":
      return patch(a.id, { steps: a.steps });
    case "done":
      return patch(a.id, { state: "done" });
    case "plan":
      // the sketch only ever moves forward
      return PLAN_ORDER.indexOf(a.plan) > PLAN_ORDER.indexOf(s.plan) ? { ...s, plan: a.plan } : s;
    case "browse":
      return { ...s, browse: { ...s.browse, ...a.browse } };
    case "finished":
      return { ...s, finished: true };
  }
}

// ---- one live browse per lobby, shared across React's dev double-mount ----
interface BrowseHandle {
  key: string;
  start: Promise<BrowseStart>;
  stopped: boolean;
  stopTimer: number | null;
}
let current: BrowseHandle | null = null;

function acquireBrowse(address: string): BrowseHandle {
  if (current && current.key === address && !current.stopped) {
    if (current.stopTimer != null) window.clearTimeout(current.stopTimer);
    current.stopTimer = null;
    return current;
  }
  current = { key: address, start: startBrowse(address), stopped: false, stopTimer: null };
  return current;
}

function stopHandle(h: BrowseHandle) {
  if (h.stopped) return;
  h.stopped = true;
  void h.start.then((r) => r.ok && stopBrowse(r.runId));
}

/** Stop soon, unless the same lobby picks it straight back up (React remounting in dev). */
function releaseBrowse(h: BrowseHandle) {
  if (h.stopped || h.stopTimer != null) return;
  h.stopTimer = window.setTimeout(() => stopHandle(h), 400);
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Gap between one stage landing and the next one opening. */
const STAGE_GAP_MS = 450;

export function useLobbyRun(address: string, { reduced, live = true }: { reduced: boolean; live?: boolean }) {
  const [state, dispatch] = useReducer(reducer, undefined, initial);

  useEffect(() => {
    const ctl = new AbortController();
    const { signal } = ctl;
    const handle = live ? acquireBrowse(address) : null;
    const startedAt = performance.now();
    // reduced motion: same story, a faster read
    const pace = reduced ? 0.4 : 1;
    const wait = (ms: number) => sleep(ms * pace, signal);
    const steps = script(address);
    dispatch({ type: "reset" });

    const playScripted = async (id: StageId) => {
      for (const s of steps[id]) {
        dispatch({ type: "step", id, text: s.text });
        if (s.plan) dispatch({ type: "plan", plan: s.plan });
        await wait(s.ms);
      }
    };

    const browse = async () => {
      const replay = async () => {
        if (handle) stopHandle(handle);
        dispatch({ type: "browse", browse: { mode: "replay", liveUrl: null, site: DEMO_BUILDING.site } });
        dispatch({ type: "steps", id: "browse", steps: [] });
        await playScripted("browse");
      };
      if (!handle) return replay();
      // the run was started the moment the lobby opened; give the request itself a fair moment
      const run = await Promise.race([handle.start, sleep(LIVE_VIEW_TIMEOUT_MS, signal).then(() => null)]);
      if (!run || !run.ok) return replay();
      dispatch({ type: "steps", id: "browse", steps: ["Opening a browser"] });
      let liveAt: number | null = null;
      for (;;) {
        const p = await pollBrowse(run.runId, signal);
        if (signal.aborted) return;
        const now = performance.now();
        if (p) {
          if (p.liveUrl && liveAt == null) {
            liveAt = now;
            dispatch({ type: "browse", browse: { mode: "live", liveUrl: p.liveUrl } });
          }
          const agent = p.steps.filter((s) => s !== "Browser open").slice(-4);
          dispatch({ type: "steps", id: "browse", steps: ["Opening a browser", ...agent] });
          dispatch({ type: "browse", browse: { site: siteFromSteps(p.steps, DEMO_BUILDING.site) } });
        }
        if (liveAt == null && now - startedAt > LIVE_VIEW_TIMEOUT_MS) return replay();
        if (liveAt != null && (p?.done || now - liveAt > BROWSE_MAX_MS * pace)) break;
        await wait(POLL_MS / pace);
      }
      // the browse is seeded for the demo: whatever it found, plan 1A is what comes back
      stopHandle(handle);
      dispatch({ type: "step", id: "browse", text: PULL_STEP });
      await wait(1400);
    };

    (async () => {
      await wait(reduced ? 200 : 900);
      for (const def of STAGES) {
        dispatch({ type: "start", id: def.id });
        await wait(STAGE_GAP_MS);
        if (def.id === "browse") await browse();
        else await playScripted(def.id);
        dispatch({ type: "done", id: def.id });
        await wait(STAGE_GAP_MS);
      }
      dispatch({ type: "finished" });
    })().catch(() => {
      /* aborted: the lobby closed */
    });

    return () => {
      ctl.abort();
      if (handle) releaseBrowse(handle);
    };
  }, [address, reduced, live]);

  return state;
}

/** Stop any live browse right now (skip, or leaving for the room). */
export function stopLiveBrowse() {
  if (current) stopHandle(current);
}
