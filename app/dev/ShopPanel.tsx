"use client";

import { useEffect, useState } from "react";
import type { FloorSpot, FurnitureCategory, Job, PlaceResult, RoomPlan, ShopJobOutput, ShopResult, Vector3Meters } from "@/backend/contracts";
import { api, money } from "./api";

export type Ghost = { label: string; dimensions: Vector3Meters; position: Vector3Meters; rotationY: number };

const CATEGORIES: FurnitureCategory[] = ["sofa", "chair", "table", "storage", "desk", "rug", "lamp", "decor"];
const POLL_MS = 3000;

const cm = (d: Vector3Meters | null) => (d ? `${Math.round(d[0] * 100)} x ${Math.round(d[2] * 100)} cm` : "size unknown");
const wall = (id: string | null) => (id ? id.replace("wall_", "") + " wall" : null);

function placeMessage(r: PlaceResult | null, error: string | null, verb = "Added, in the cart"): { kind: "ok" | "err"; text: string } {
  if (!r) return { kind: "err", text: error ?? "request failed" };
  if (r.ok) return { kind: "ok", text: `${verb}. Revision ${r.plan.revision}.` };
  if (r.reason === "validation_failed") return { kind: "err", text: r.validations.filter((v) => v.status === "fail").map((v) => v.message).join(" ") };
  if (r.reason === "stale_revision") return { kind: "err", text: `The room changed (now revision ${r.currentRevision}). Try again.` };
  return { kind: "err", text: r.message };
}

/** Shop for a floor spot: pick a spot on the map, search, preview, add. Voice-started searches show here too. */
export function ShopPanel({
  base,
  plan,
  spot,
  selectedId,
  job,
  onJob,
  onGhost,
  onPlanChanged,
}: {
  base: string;
  plan: RoomPlan | null;
  spot: FloorSpot | null;
  selectedId: string | null;
  job: Job<ShopJobOutput> | null;
  onJob: (job: Job<ShopJobOutput> | null) => void;
  onGhost: (g: Ghost | null) => void;
  onPlanChanged: () => Promise<void> | void;
}) {
  const [category, setCategory] = useState<FurnitureCategory>("sofa");
  const [maxPrice, setMaxPrice] = useState("");
  const [style, setStyle] = useState("");
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ key: string; kind: "ok" | "err"; text: string } | null>(null);
  const [lockedMove, setLockedMove] = useState<string | null>(null);

  // follow the live search; a new job (or unmount) stops the old loop
  const jobId = job?.id ?? null;
  const running = job?.output?.live === "running";
  useEffect(() => {
    if (!jobId || !running) return;
    let stop = false;
    const t = setInterval(async () => {
      const r = await api<Job<ShopJobOutput>>("GET", `${base}/shop/${jobId}`);
      if (!stop && r.ok && r.data) onJob(r.data);
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [base, jobId, running, onJob]);

  async function shop() {
    if (!spot) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    onGhost(null);
    const price = Number(maxPrice);
    const r = await api<Job<ShopJobOutput>>("POST", `${base}/shop`, {
      category,
      spot,
      maxPriceUsd: maxPrice.trim() && price > 0 ? price : null,
      request: style.trim() || null,
      live,
    });
    setBusy(false);
    if (r.ok && r.data) onJob(r.data);
    else setErr(r.error);
  }

  async function add(r: ShopResult) {
    if (!job?.output) return;
    const res = await api<PlaceResult>("POST", `${base}/place`, { productId: r.product.id, spot: job.output.request.spot });
    setMsg({ key: r.product.id, ...placeMessage(res.data, res.error) });
    if (res.data?.ok) {
      onGhost(null);
      await onPlanChanged();
    }
  }

  async function moveHere(unlock = false) {
    if (!spot || !selectedId) return;
    const res = await api<PlaceResult>("POST", `${base}/items/${encodeURIComponent(selectedId)}/move-to`, { spot, unlock });
    setLockedMove(res.data && !res.data.ok && res.data.reason === "locked" ? selectedId : null);
    setMsg({ key: "move", ...placeMessage(res.data, res.error, "Moved") });
    if (res.data?.ok) await onPlanChanged();
  }

  const preview = (r: ShopResult) =>
    onGhost(r.placement && r.product.dimensions ? { label: r.product.label, dimensions: r.product.dimensions, position: r.placement.position, rotationY: r.placement.rotationY } : null);

  const out = job?.output ?? null;
  const selected = plan?.items.find((i) => i.id === selectedId) ?? null;

  return (
    <section className="card">
      <div className="card-title">Shop this spot</div>
      <p className="mb-2 text-xs text-zinc-500">
        {spot ? (
          <>
            Spot <span className="font-medium text-zinc-800">x {spot.position[0].toFixed(2)}, z {spot.position[2].toFixed(2)}</span>
          </>
        ) : (
          "Click the floor on the map to pick a spot."
        )}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <select className="field" value={category} onChange={(e) => setCategory(e.target.value as FurnitureCategory)} aria-label="Category">
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input className="field" inputMode="decimal" placeholder="Max price, USD" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} />
        <input className="field col-span-2" placeholder="Style, e.g. gray, mid-century" value={style} onChange={(e) => setStyle(e.target.value)} />
      </div>
      <div className="mt-2 flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-zinc-600">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Live store search
        </label>
        <button className="btn btn-primary ml-auto" disabled={!spot || busy} onClick={shop}>
          {busy ? "Searching..." : "Shop"}
        </button>
      </div>

      {selected && spot && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2">
          <button className="btn" onClick={() => void moveHere()}>
            Move selected item here
          </button>
          {lockedMove === selected.id && (
            <button className="btn btn-danger" onClick={() => void moveHere(true)}>
              Move anyway (unlock)
            </button>
          )}
        </div>
      )}
      {msg?.key === "move" && <Note kind={msg.kind} text={msg.text} />}
      {err && <Note kind="err" text={err} />}

      {job && out && (
        <div className="mt-3 space-y-2 border-t border-zinc-100 pt-2">
          <div className="flex items-center gap-2 text-xs">
            {running && <span className="inline-block size-2 animate-pulse rounded-full bg-amber-400" />}
            <span className="text-zinc-600">{job.stage}</span>
            <span className="ml-auto text-zinc-400">{job.id}</span>
          </div>
          {out.results.length === 0 && <p className="text-xs text-zinc-400">Nothing under that price yet.</p>}
          <ul className="space-y-1.5" onMouseLeave={() => onGhost(null)}>
            {out.results.map((r, n) => (
              <li
                key={r.product.id}
                className={`rounded-md border px-2.5 py-2 text-xs ${r.fits ? "border-zinc-200 hover:border-blue-300 hover:bg-blue-50/40" : "border-zinc-100 bg-zinc-50 text-zinc-500"}`}
                onMouseEnter={() => preview(r)}
                onFocus={() => preview(r)}
              >
                <div className="flex items-start gap-2">
                  <span className="text-zinc-400">{n + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <a className="truncate font-medium text-zinc-900 hover:underline" href={r.product.sourceUrl} target="_blank" rel="noreferrer">
                        {r.product.label.split(",")[0]}
                      </a>
                      <span className="ml-auto shrink-0 font-medium">{money(r.product.price)}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-zinc-500">
                      <span>{cm(r.product.dimensions)}</span>
                      <span className={`rounded px-1 ${r.source === "live" ? "bg-violet-100 text-violet-700" : "bg-zinc-100 text-zinc-600"}`}>{r.source}</span>
                      <span>{r.product.merchant}</span>
                      {r.assetUrl && <span>{r.assetUrl.split("/").pop()}</span>}
                    </div>
                    <div className="mt-0.5">
                      {r.fits ? (
                        <span className="text-emerald-700">
                          Fits{wall(r.placement?.againstWallId ?? null) ? ` against the ${wall(r.placement!.againstWallId)}` : r.placement && r.placement.distanceM > 0.3 ? `, ${r.placement.distanceM} m from the spot` : " right there"}
                        </span>
                      ) : (
                        <span className="text-red-700">{r.problems[0] ?? "Doesn't fit"}</span>
                      )}
                      {r.withinBudget === false && r.overBudgetUsd !== null && <span className="ml-2 text-amber-700">over budget by ${r.overBudgetUsd.toFixed(2)}</span>}
                    </div>
                  </div>
                  {r.fits && (
                    <button className="btn shrink-0" onClick={() => void add(r)}>
                      Add to room
                    </button>
                  )}
                </div>
                {msg?.key === r.product.id && <Note kind={msg.kind} text={msg.text} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Note({ kind, text }: { kind: "ok" | "err"; text: string }) {
  return <p className={`mt-1.5 rounded-md px-2 py-1.5 text-xs ${kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{text}</p>;
}
