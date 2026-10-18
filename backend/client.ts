/**
 * Browser-safe client for the room API, for the viewer and product screens.
 * No secrets, no server imports. Everything goes through the same routes the
 * voice agent uses, so the UI and voice always agree.
 *
 *   const room = roomClient("proj_demo");
 *   const { plan } = await room.get();
 *   // the shopper looks at the floor and asks for a couch under $300
 *   const stop = room.shop({ category: "sofa", spot: { position: [x, 0, z] }, maxPriceUsd: 300 }, (job) => showResults(job));
 *   const placed = await room.place(result.product.id, job.output.request.spot);
 *   if (placed.ok) redraw(placed.plan);
 *
 * Drawing a piece at its real size: see `assetFor` and `assetTransform` from
 * backend/shopping/assets.ts (also browser-safe).
 */
import type {
  ApplyResult,
  CostSummary,
  FloorSpot,
  Job,
  PlaceResult,
  PlanChange,
  PlanProposal,
  RoomPlan,
  ShopJobOutput,
  ShopRequest,
  ValidationResult,
} from "@/backend/contracts";

import { dropChange, type DragCheck } from "@/backend/shopping/drag";

export { assetFor, assetTransform, itemAsset } from "@/backend/shopping/assets";
export { dragCheck, dropChange, inventory, turned } from "@/backend/shopping/drag";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(json?.error ?? `request failed (${res.status})`, res.status);
  return json as T;
}

export function roomClient(projectId: string, opts: { baseUrl?: string; pollMs?: number } = {}) {
  const base = `${opts.baseUrl ?? ""}/api/projects/${encodeURIComponent(projectId)}`;
  const pollMs = opts.pollMs ?? 3000;

  return {
    get: () => call<{ plan: RoomPlan; cost: CostSummary; validations: ValidationResult[] }>("GET", base),
    reset: () => call<RoomPlan>("POST", `${base}/reset`),

    /** Direct edits (drag to move, lock, remove). Validated; stale revisions are refused. */
    change: (expectedRevision: number, changes: PlanChange[]) => call<ApplyResult>("POST", `${base}/changes`, { expectedRevision, changes }),
    /** Move to an exact pose, e.g. at the end of a drag. */
    move: (expectedRevision: number, itemId: string, position: [number, number, number], rotationY: number) =>
      call<ApplyResult>("POST", `${base}/changes`, { expectedRevision, changes: [{ kind: "move", itemId, position, rotationY }] }),
    /** Let go of a carried piece at the pose `dragCheck` gave; a stored piece comes out of inventory. */
    drop: (expectedRevision: number, item: { id: string; stored?: boolean }, pose: DragCheck["pose"]) =>
      call<ApplyResult>("POST", `${base}/changes`, { expectedRevision, changes: [dropChange(item, pose)] }),
    /** Put a piece away in inventory (locked pieces need unlock). Bring it back with moveTo or drop. */
    store: (itemId: string, unlock = false) =>
      call<ApplyResult | { ok: false; reason: "locked"; message: string }>("POST", `${base}/items/${encodeURIComponent(itemId)}/store`, { unlock }),
    /** Move to a spot, adjusted so it fits (snaps to walls, slides clear of other pieces). Also takes a piece out of inventory. */
    moveTo: (itemId: string, spot: FloorSpot, unlock = false) => call<PlaceResult>("POST", `${base}/items/${encodeURIComponent(itemId)}/move-to`, { spot, unlock }),

    /** Natural-language change ("make it $300 cheaper"). Nothing changes until `apply`. */
    propose: (intent: string, selectedItemId: string | null = null) => call<PlanProposal>("POST", `${base}/proposals`, { intent, selectedItemId }),
    apply: (proposal: PlanProposal) => call<ApplyResult>("POST", `${base}/proposals/${proposal.id}/apply`, { expectedRevision: proposal.baseRevision }),

    /**
     * Shop for a spot. `onUpdate` fires at once with catalog matches, then on
     * each poll while the live store search runs, then once more when it's
     * done. Returns a function that stops polling.
     */
    shop(req: ShopRequest, onUpdate: (job: Job<ShopJobOutput>) => void, onError?: (e: Error) => void) {
      let stopped = false;
      void (async () => {
        try {
          let job = await call<Job<ShopJobOutput>>("POST", `${base}/shop`, req);
          if (stopped) return;
          onUpdate(job);
          while (!stopped && job.output?.live === "running") {
            await new Promise((r) => setTimeout(r, pollMs));
            if (stopped) return;
            job = await call<Job<ShopJobOutput>>("GET", `${base}/shop/${job.id}`);
            if (!stopped) onUpdate(job);
          }
        } catch (e) {
          if (!stopped) onError?.(e as Error);
        }
      })();
      return () => {
        stopped = true;
      };
    },
    /** A search re-checked against the room now (call after any change to refresh fits). */
    shopJob: (jobId: string) => call<Job<ShopJobOutput>>("GET", `${base}/shop/${jobId}`),
    /** Put a product in the room at a spot; it joins the cart. */
    place: (productId: string, spot: FloorSpot, jobId?: string) => call<PlaceResult>("POST", `${base}/place`, { productId, spot, jobId }),
  };
}

export type RoomClient = ReturnType<typeof roomClient>;
