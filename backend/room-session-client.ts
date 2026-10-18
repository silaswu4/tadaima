/** Browser-safe registration of this room with Matthew's canonical plan API. */
import type { ApplyResult, RoomPlan } from "./contracts";
import { ApiError } from "./client";

export type RoomCapabilities = { liveSearch: boolean; testPayments: boolean; persistence: "memory" | "redis" };
export type RegisteredRoom = { plan: RoomPlan; capabilities: RoomCapabilities; resumed: boolean };

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(typeof value?.error === "string" ? value.error : `Room service returned ${response.status}.`, response.status);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("The room service returned an unreadable response.", response.status);
  return value as T;
}
let registrations: Promise<void> = Promise.resolve();
const abortReason = (signal: AbortSignal) => signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

/** Cancel a queued caller promptly, while leaving its queue slot behind the active
 * registration. A cancelled slot never sends a request when it reaches the front. */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(abortReason(signal)); };
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    operation.then((value) => { signal.removeEventListener("abort", aborted); resolve(value); },
      (cause) => { signal.removeEventListener("abort", aborted); reject(cause); });
  });
}

export function registerRoom(roomId: string, plan: RoomPlan, signal?: AbortSignal): Promise<RegisteredRoom> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  // The caller may edit the draft while another room is registering.
  const body = { roomId, plan: structuredClone(plan) };
  const operation = registrations.then(async () => {
    if (signal?.aborted) throw abortReason(signal);
    const request = () => {
      if (signal?.aborted) throw abortReason(signal);
      return post<RegisteredRoom>("/api/room-sessions", body, signal);
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    // Web Locks are scoped to the browser origin, so fresh tabs cannot race to
    // install different HttpOnly owner cookies. No token is exposed to JavaScript.
    return locks?.request ? locks.request("tadaima:room-session-registration", { mode: "exclusive", ...(signal ? { signal } : {}) }, request) : request();
  });
  registrations = operation.then(() => undefined, () => undefined);
  return abortable(operation, signal);
}
export const syncRoom = (projectId: string, expectedRevision: number, plan: RoomPlan) =>
  post<ApplyResult>(`/api/room-sessions/${encodeURIComponent(projectId)}/sync`, { expectedRevision, plan });

/** Server identity is transport state; source identity remains bound to the original model. */
export function localRoomSnapshot(serverPlan: RoomPlan, sourceProjectId: string): RoomPlan {
  return { ...structuredClone(serverPlan), projectId: sourceProjectId };
}
export function mutationMessage(result: Exclude<ApplyResult, { ok: true }>): string {
  return result.reason === "stale_revision" ? "The room changed on the server. It has been refreshed; please try your edit again."
    : result.validations.filter((v) => v.status === "fail" || v.status === "unknown").map((v) => v.message).join(" ") || "The server refused this change.";
}
