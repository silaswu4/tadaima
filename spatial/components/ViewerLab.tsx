"use client";

import { useState } from "react";
import type { RoomPlan, Vector3Meters } from "@/backend/contracts";
import { DEMO_PLAN_R1, DEMO_PLAN_R2 } from "@/spatial/fixtures/demoRoom";
import { dimensionSource } from "@/spatial/room/plan";
import type { AssetBenchmark } from "@/spatial/room/benchmark";
import { RoomViewer, type ItemRenderState, type PlacementProposal } from "@/spatial/components/RoomViewer";
import { PlanIssues, RoomInventory } from "@/spatial/components/RoomInventory";

// a working bench for the spatial viewer. it stands in for Angelina's screens and
// Matthew's backend: proposals are accepted here, in memory, so the revision
// flow can be exercised before the real operations exist.

type LogEntry = { at: string; text: string };

const cm = (m: number) => Math.round(m * 100);

export function ViewerLab() {
  const [revisions, setRevisions] = useState<RoomPlan[]>([DEMO_PLAN_R1, DEMO_PLAN_R2]);
  const [index, setIndex] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  const [states, setStates] = useState<Record<string, ItemRenderState>>({});
  const [log, setLog] = useState<LogEntry[]>([]);

  const plan = revisions[index];
  const previous = index > 0 ? revisions[index - 1] : null;
  const latest = index === revisions.length - 1;

  const note = (text: string) =>
    setLog((l) => [{ at: new Date().toLocaleTimeString([], { hour12: false }), text }, ...l].slice(0, 12));

  function select(id: string | null) {
    setSelected(id);
    note(`select ${id ?? "none"}`);
  }

  // stands in for the backend: accept against the expected revision, or refuse
  function accept(proposal: PlacementProposal) {
    note(`propose ${proposal.itemId} on revision ${proposal.baseRevision}`);
    const head = revisions[revisions.length - 1];
    if (proposal.baseRevision !== head.revision) {
      note(`refused: revision ${proposal.baseRevision} is stale, latest is ${head.revision}`);
      return;
    }
    const item = head.items.find((i) => i.id === proposal.itemId);
    if (!item || item.locked) {
      note(`refused: ${proposal.itemId} is locked or missing`);
      return;
    }
    const next: RoomPlan = {
      ...head,
      revision: head.revision + 1,
      items: head.items.map((i) => (i.id === proposal.itemId ? { ...i, position: proposal.position, rotationY: proposal.rotationY } : i)),
    };
    setRevisions((r) => [...r, next]);
    setIndex(revisions.length);
    note(`accepted locally as revision ${next.revision}`);
  }

  return (
    <main className="flex min-h-[100dvh] flex-col bg-surface text-ink lg:h-[100dvh] lg:flex-row">
      <div className="relative h-[62dvh] min-h-[380px] shrink-0 border-b border-ink/10 lg:h-auto lg:flex-1 lg:border-r lg:border-b-0">
        <RoomViewer
          plan={plan}
          previousPlan={previous}
          showChanges={showChanges}
          selectedItemId={selected}
          onSelectItem={select}
          onProposePlacement={latest ? accept : undefined}
          onItemStates={setStates}
          className="h-full w-full"
        />
        <p className="pointer-events-none absolute top-3 left-3 bg-surface/90 px-2 py-1 text-[12px] text-ink-soft">
          Synthetic fixture, revision {plan.revision}
          {latest ? "" : ", read only"}
        </p>
      </div>

      <aside className="flex w-full flex-col gap-6 overflow-y-auto px-4 py-5 lg:w-[400px] lg:px-5">
        <header className="space-y-1.5">
          <h1 className="text-[18px] font-medium">Spatial lab</h1>
          <p className="text-[13px] leading-relaxed text-ink-soft">
            The room viewer driven by a sample plan. Nothing here talks to a backend. Moves you propose are accepted on this page only, so the
            revision flow can be tried end to end.
          </p>
        </header>

        <section className="space-y-2 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            {revisions.map((r, i) => (
              <button
                key={r.revision}
                type="button"
                aria-pressed={i === index}
                onClick={() => setIndex(i)}
                className={`border px-2.5 py-1 ${i === index ? "border-ink bg-ink text-surface-soft" : "border-ink/20 hover:bg-ink/5"}`}
              >
                Revision {r.revision}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-ink-soft">
            <input type="checkbox" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} />
            Show changes since the previous revision
          </label>
          <p className="text-ink-soft">
            Budget target {plan.constraints.budget ? `$${(plan.constraints.budget.amountMinor / 100).toFixed(0)}` : "not set"}, seats for{" "}
            {plan.constraints.minimumSeats ?? "any number"}.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-[13px] text-ink-soft">Pieces</h2>
          <RoomInventory
            plan={plan}
            previousPlan={previous}
            showChanges={showChanges}
            selectedItemId={selected}
            onSelectItem={select}
            itemStates={states}
          />
          <p className="text-[12px] leading-relaxed text-ink-soft">
            Select a piece, then drag it, or focus the view and use the arrow keys (Shift for 1 cm) and Q or E to turn. Locked pieces stay put.
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-[13px] text-ink-soft">What the viewer sends</h2>
          <pre className="overflow-x-auto border border-ink/10 px-3 py-2 text-[12px] leading-[1.6]">
            {`selectedItemId: ${selected ? `"${selected}"` : "null"}\nrevision: ${plan.revision}`}
          </pre>
          <ol className="space-y-0.5 text-[12px] text-ink-soft">
            {log.length ? log.map((entry, i) => <li key={i}>{`${entry.at}  ${entry.text}`}</li>) : <li>No events yet.</li>}
          </ol>
        </section>

        <section className="space-y-2">
          <h2 className="text-[13px] text-ink-soft">Plan gaps</h2>
          <PlanIssues plan={plan} />
        </section>

        <AssetBench plan={plan} />
      </aside>
    </main>
  );
}

const VERDICT: Record<AssetBenchmark["scale"], string> = {
  matches: "Matches listed size",
  differs: "Differs from listed size",
  unit_error_likely: "Likely exported in cm or mm",
  implausible: "Implausible size",
  unchecked: "No size to compare",
};

function AssetBench({ plan }: { plan: RoomPlan }) {
  const [rows, setRows] = useState<AssetBenchmark[] | null>(null);
  const [running, setRunning] = useState(false);
  const [url, setUrl] = useState("");
  const [expected, setExpected] = useState("");

  async function run(entries: Array<{ url: string; expected: Vector3Meters | null }>) {
    setRunning(true);
    const { benchmarkAssets } = await import("@/spatial/room/benchmark");
    setRows(await benchmarkAssets(entries));
    setRunning(false);
  }

  function planEntries() {
    const seen = new Set<string>();
    const out: Array<{ url: string; expected: Vector3Meters | null }> = [];
    for (const item of plan.items) {
      if (!item.assetUrl || seen.has(item.assetUrl)) continue;
      seen.add(item.assetUrl);
      const source = dimensionSource(plan, item);
      out.push({ url: item.assetUrl, expected: source.kind === "unknown" ? null : source.size });
    }
    return out;
  }

  function customEntry() {
    // width, height, depth in centimeters, like "210 85 95"
    const parts = expected.trim().split(/[\s,x]+/).filter(Boolean).map(Number);
    const size = parts.length === 3 && parts.every((n) => n > 0) ? (parts.map((n) => n / 100) as unknown as Vector3Meters) : null;
    return [{ url: url.trim(), expected: size }];
  }

  return (
    <section className="space-y-3 pb-6 text-[13px]">
      <h2 className="text-ink-soft">Asset check</h2>
      <p className="text-[12px] leading-relaxed text-ink-soft">
        Fetch and parse time, size, and scale for each model, measured in this browser. Run it in the Quest browser for headset numbers.
      </p>
      <button type="button" disabled={running} onClick={() => run(planEntries())} className="bg-ink px-3 py-1.5 text-surface-soft disabled:opacity-40">
        {running ? "Measuring" : "Check this plan's models"}
      </button>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) run(customEntry());
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="/models/your-room.glb"
          aria-label="Model URL"
          className="border border-ink/20 px-2 py-1.5"
        />
        <input
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
          placeholder="Expected w h d in cm (optional)"
          aria-label="Expected width, height and depth in centimeters"
          className="border border-ink/20 px-2 py-1.5"
        />
        <button type="submit" disabled={running || !url.trim()} className="self-start border border-ink/20 px-3 py-1.5 disabled:opacity-40">
          Check one model
        </button>
      </form>
      {rows && (
        <ul className="divide-y divide-ink/10 border-y border-ink/10 text-[12px]">
          {rows.map((r) => (
            <li key={r.url} className="space-y-0.5 py-2">
              <div className="break-all">{r.url}</div>
              {r.ok ? (
                <>
                  <div className="text-ink-soft">
                    {((r.bytes ?? 0) / 1024).toFixed(0)} KB &middot; fetch {r.fetchMs?.toFixed(0)} ms &middot; parse {r.parseMs?.toFixed(0)} ms
                  </div>
                  <div className="text-ink-soft">
                    {r.triangles.toLocaleString()} triangles &middot; {r.meshes} meshes &middot; {r.materials} materials &middot; {r.textures} textures
                    {r.maxTexture ? ` up to ${r.maxTexture}px` : ""}
                  </div>
                  {r.bounds && (
                    <div className="text-ink-soft">
                      Bounds {cm(r.bounds[0])} w &middot; {cm(r.bounds[2])} d &middot; {cm(r.bounds[1])} h cm
                    </div>
                  )}
                  <div className={r.scale === "matches" || r.scale === "unchecked" ? "text-ink" : "text-accent-deep"}>
                    {VERDICT[r.scale]}
                    {r.ratio ? ` (${r.ratio.map((x) => `${Math.round(x * 100)}%`).join(", ")} of w, h, d)` : ""}
                  </div>
                </>
              ) : (
                <div className="text-accent-deep">Failed: {r.error}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
