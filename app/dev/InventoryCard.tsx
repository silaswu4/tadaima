"use client";

import { useState } from "react";
import type { FloorSpot, PlaceResult, RoomPlan } from "@/backend/contracts";
import { api, money } from "./api";

/** Pieces put away: off the floor, out of the cart. Bring one back at the picked floor spot. */
export function InventoryCard({
  base,
  plan,
  spot,
  onChanged,
}: {
  base: string;
  plan: RoomPlan;
  spot: FloorSpot | null;
  onChanged: () => Promise<void>;
}) {
  const stored = plan.items.filter((i) => i.stored);
  const [msg, setMsg] = useState<{ id: string; kind: "ok" | "err"; text: string; locked?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function takeOut(itemId: string, unlock = false) {
    if (!spot) return;
    setBusy(itemId);
    const r = await api<PlaceResult>("POST", `${base}/items/${encodeURIComponent(itemId)}/move-to`, { spot, unlock });
    setBusy(null);
    const res = r.data;
    if (!res) setMsg({ id: itemId, kind: "err", text: r.error ?? "failed" });
    else if (res.ok) setMsg({ id: itemId, kind: "ok", text: `Back in the room${res.placement.againstWallId ? ` against ${res.placement.againstWallId.replace("wall_", "the ")} wall` : ""}.` });
    else if (res.reason === "locked") setMsg({ id: itemId, kind: "err", text: res.message, locked: true });
    else if (res.reason === "no_fit") setMsg({ id: itemId, kind: "err", text: res.message });
    else if (res.reason === "stale_revision") setMsg({ id: itemId, kind: "err", text: "The room just changed. Try again." });
    else setMsg({ id: itemId, kind: "err", text: res.validations.filter((v) => v.status === "fail").map((v) => v.message).join(" ") });
    await onChanged();
  }

  return (
    <section className="card">
      <div className="card-title">Inventory</div>
      {stored.length === 0 ? (
        <p className="text-xs text-zinc-400">Nothing put away. Select a piece and choose Put away, or say &ldquo;put the lamp away&rdquo;.</p>
      ) : (
        <ul className="space-y-2">
          {stored.map((i) => {
            const price = plan.products.find((p) => p.id === i.productId)?.price;
            return (
              <li key={i.id} className="rounded-md border border-zinc-200 px-2.5 py-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{i.label}</div>
                    <div className="text-[11px] text-zinc-500">
                      {i.origin === "existing_owned" ? "owned" : `${money(price)}, not in the cart while put away`}
                      {i.locked ? " · locked" : ""}
                    </div>
                  </div>
                  <button className="btn" disabled={!spot || busy === i.id} title={spot ? undefined : "Click the floor on the map to pick a spot"} onClick={() => takeOut(i.id)}>
                    {busy === i.id ? "Placing..." : "Take out here"}
                  </button>
                </div>
                {msg?.id === i.id && (
                  <div className={`mt-1.5 flex items-center gap-2 text-xs ${msg.kind === "ok" ? "text-emerald-700" : "text-red-700"}`}>
                    <span>{msg.text}</span>
                    {msg.locked && (
                      <button className="btn" onClick={() => takeOut(i.id, true)}>
                        Take out anyway (unlock)
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {stored.length > 0 && !spot && <p className="mt-2 text-xs text-zinc-400">Click the floor on the map to pick where it goes.</p>}
      {msg && !stored.some((i) => i.id === msg.id) && <p className={`mt-2 text-xs ${msg.kind === "ok" ? "text-emerald-700" : "text-red-700"}`}>{msg.text}</p>}
    </section>
  );
}
