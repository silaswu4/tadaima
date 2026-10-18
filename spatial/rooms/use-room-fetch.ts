"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FetchPairing, FetchRoomStatus } from "../../backend/session/fetch-types";

async function request<T>(projectId: string, method = "GET", signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/room-sessions/${encodeURIComponent(projectId)}/fetch`, { method, signal, cache: "no-store", credentials: "same-origin" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Fetch could not connect to this room.");
  return result;
}

/** Lives with the room, so incoming Fetch activity survives closing the assistant. */
export function useRoomFetch(projectId: string | undefined) {
  const [value, setValue] = useState<{ projectId: string; status: FetchRoomStatus } | null>(null);
  const [pairing, setPairing] = useState<{ projectId: string; code: string } | null>(null);
  const [pendingProject, setPendingProject] = useState<string | null>(null), [error, setError] = useState<{ projectId: string; message: string } | null>(null);
  const version = useRef(0);
  useLayoutEffect(() => { version.current++; }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const generation = version.current;
      let delay = 5000;
      try {
        const status = await request<FetchRoomStatus>(projectId!, "GET", controller.signal);
        if (controller.signal.aborted) return;
        if (generation === version.current) { setValue({ projectId: projectId!, status }); setError(null); }
        delay = status.status === "disconnected" ? 15000 : 3000;
      } catch (cause) { if (!controller.signal.aborted && generation === version.current) setError({ projectId: projectId!, message: cause instanceof Error ? cause.message : "Fetch status is unavailable." }); }
      if (!controller.signal.aborted) timer = setTimeout(() => { if (document.visibilityState === "visible") void poll(); else timer = setTimeout(poll, 10000); }, delay);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId]);
  const change = useCallback(async (method: "POST" | "DELETE") => {
    if (!projectId) return;
    const generation = ++version.current;
    setPendingProject(projectId); setError(null);
    try {
      const status = await request<FetchPairing>(projectId, method);
      if (generation === version.current) { setValue({ projectId, status }); setPairing(status.code ? { projectId, code: status.code } : null); }
    } catch (cause) { if (generation === version.current) setError({ projectId, message: cause instanceof Error ? cause.message : "Fetch could not connect." }); }
    finally {
      // A GET begun during this mutation must not resurrect the previous binding
      // after disconnect, or replace a newly minted connection with stale status.
      if (generation === version.current) { version.current++; setPendingProject(null); }
    }
  }, [projectId]);
  return { status: value && value.projectId === projectId ? value.status : null,
    code: pairing && pairing.projectId === projectId ? pairing.code : null, pending: pendingProject === projectId,
    error: error?.projectId === projectId ? error?.message ?? "" : "",
    pair: () => change("POST"), disconnect: () => change("DELETE") };
}
export type RoomFetchConnection = ReturnType<typeof useRoomFetch>;
