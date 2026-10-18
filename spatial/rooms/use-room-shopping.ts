"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { FloorSpot, Job, RoomPlan, ShopJobOutput, ShopRequest } from "../../backend/contracts";
import { roomClient } from "../../backend/client";
import { localRoomSnapshot, mutationMessage, registerRoom, syncRoom, type RegisteredRoom } from "../../backend/room-session-client";
import type { WalkScene } from "../room/walk-api";

type Options = { roomId: string; sourceProjectId: string; persist?: (plan: RoomPlan) => Promise<void>; notice: (message: string) => void };

/** One canonical server session per selected room. The GLB/source never travels here. */
export function useRoomShopping(options: Options) {
  const callbacks = useRef(options);
  useLayoutEffect(() => { callbacks.current = options; });
  const current = useRef<{ engine: WalkScene; session: RegisteredRoom; epoch: number } | null>(null);
  const epoch = useRef(0);
  const pending = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const registration = useRef<AbortController | null>(null);
  const polling = useRef<(() => void) | null>(null);
  const searchVersion = useRef(0);
  const [session, setSession] = useState<RegisteredRoom | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState<Job<ShopJobOutput> | null>(null);

  const stopSearch = useCallback(() => { searchVersion.current++; polling.current?.(); polling.current = null; }, []);
  const apply = useCallback(async (plan: RoomPlan, expectedEpoch: number) => {
    const owner = callbacks.current;
    const active = current.current;
    if (active && expectedEpoch === epoch.current) {
      await active.engine.setPlan(plan);
      if (expectedEpoch === epoch.current) {
        active.session = { ...active.session, plan };
        setSession(active.session);
      }
    }
    // A committed server mutation still needs its browser copy if the shopper
    // navigated away while models were loading. Its original room owns the save.
    try { await owner.persist?.(localRoomSnapshot(plan, owner.sourceProjectId)); }
    catch (cause) { if (expectedEpoch === epoch.current) owner.notice(`Saved on the server; browser copy failed: ${cause instanceof Error ? cause.message : "storage unavailable"}`); }
  }, []);

  const connect = useCallback(async (engine: WalkScene) => {
    const generation = ++epoch.current;
    registration.current?.abort(); stopSearch();
    current.current = null; setSession(null); setError(""); setConnecting(true); setJob(null);
    pending.current = 0; setBusy(false); queue.current = Promise.resolve();
    const controller = new AbortController(); registration.current = controller;
    try {
      const registered = await registerRoom(callbacks.current.roomId, localRoomSnapshot(engine.getPlan(), callbacks.current.sourceProjectId), controller.signal);
      if (generation !== epoch.current) return;
      current.current = { engine, session: registered, epoch: generation };
      await apply(registered.plan, generation);
    } catch (cause) {
      if (generation !== epoch.current || controller.signal.aborted) return;
      current.current = null; setSession(null);
      setError(cause instanceof Error ? cause.message : "Could not connect this room to shopping.");
    } finally { if (generation === epoch.current) setConnecting(false); }
  }, [apply, stopSearch]);

  const disconnect = useCallback(() => {
    ++epoch.current; registration.current?.abort(); stopSearch(); current.current = null;
  }, [stopSearch]);

  const mutate = useCallback(<T,>(operation: (active: NonNullable<typeof current.current>) => Promise<T>): Promise<T> => {
    const generation = epoch.current;
    pending.current++; setBusy(true); setError("");
    const task = queue.current.catch(() => undefined).then(async () => {
      const active = current.current;
      if (!active || generation !== epoch.current) throw new Error("Connect the room before shopping.");
      return operation(active);
    });
    queue.current = task;
    return task.catch((cause) => {
      if (generation === epoch.current) { const message = cause instanceof Error ? cause.message : "The room service could not finish this action."; setError(message); callbacks.current.notice(message); }
      throw cause;
    }).finally(() => { if (generation === epoch.current) { pending.current--; setBusy(pending.current > 0); } });
  }, []);

  const refresh = useCallback(() => mutate(async (active) => {
    const latest = await roomClient(active.session.plan.projectId).get();
    await apply(latest.plan, active.epoch);
  }), [mutate, apply]);

  const sync = useCallback((snapshot: RoomPlan) => {
    return mutate(async (active) => {
      let result;
      try { result = await syncRoom(active.session.plan.projectId, active.session.plan.revision, snapshot); }
      catch (cause) { if (active.epoch === epoch.current) await active.engine.setPlan(active.session.plan); throw cause; }
      if (!result.ok) {
        const latest = await roomClient(active.session.plan.projectId).get();
        await apply(latest.plan, active.epoch);
        throw new Error(mutationMessage(result));
      }
      await apply(result.plan, active.epoch);
    });
  }, [mutate, apply]);

  const search = useCallback(async (request: ShopRequest) => {
    const generation = epoch.current;
    stopSearch(); setJob(null);
    const version = ++searchVersion.current;
    await refresh();
    const active = current.current;
    if (!active || generation !== epoch.current || version !== searchVersion.current) return;
    polling.current?.();
    polling.current = roomClient(active.session.plan.projectId).shop({ ...request, live: request.live !== false && active.session.capabilities.liveSearch }, (next) => {
      if (generation !== epoch.current || version !== searchVersion.current) return;
      setJob(next);
      if (next.output && next.output.checkedAtRevision > active.session.plan.revision && pending.current === 0) {
        void refresh().catch(() => undefined);
      }
    }, (cause) => {
      if (generation === epoch.current && version === searchVersion.current) { setError(cause.message); callbacks.current.notice(cause.message); }
    });
  }, [stopSearch, refresh]);

  const place = useCallback((productId: string, spot: FloorSpot, previewRevision: number, jobId?: string, replaceItemId?: string) => mutate(async (active) => {
    if (previewRevision !== active.session.plan.revision) throw new Error("The room changed. Preview this piece again before confirming.");
    const result = await roomClient(active.session.plan.projectId).place(productId, spot, jobId, previewRevision, replaceItemId);
    if (!result.ok) {
      if (result.reason === "stale_revision") { const latest = await roomClient(active.session.plan.projectId).get(); await apply(latest.plan, active.epoch); }
      throw new Error(result.reason === "validation_failed" || result.reason === "stale_revision" ? mutationMessage(result) : result.message);
    }
    await apply(result.plan, active.epoch);
    if (active.epoch === epoch.current) active.engine.select(result.itemId);
    return result;
  }), [mutate, apply]);

  return { session, busy, connecting, error, job, connect, disconnect, sync, refresh, search, stopSearch, place };
}
