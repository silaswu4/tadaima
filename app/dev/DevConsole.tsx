"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApplyResult, Job, PlanChange, PlanProposal, ResearchJobOutput, RoomPlan, ValidationResult } from "@/backend/contracts";
import { api, failingIds, meters, money, seatsOf, type ProjectView } from "./api";
import { RoomMap } from "./RoomMap";
import { VoicePanel } from "./VoicePanel";
import { CheckoutPanel } from "./CheckoutPanel";

interface LogEntry {
  id: number;
  at: string;
  method: string;
  path: string;
  status: number | "ERR";
  ms: number;
}

interface Brief {
  text: string;
  space: { maxWidthM: number | null; maxDepthM: number | null };
  budget: { maxPriceUsd: number | null };
  seatsRequired: number;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function applyMessage(r: ApplyResult | null, error: string | null): { kind: "ok" | "err"; text: string } {
  if (!r) return { kind: "err", text: `Request failed: ${error}` };
  if (r.ok) return { kind: "ok", text: `Applied. Now at revision ${r.plan.revision}.` };
  if (r.reason === "stale_revision")
    return { kind: "err", text: `stale_revision: the room changed since this was planned (server is at revision ${r.currentRevision}). Propose again.` };
  const fails = r.validations.filter((v) => v.status === "fail").map((v) => v.message);
  return { kind: "err", text: `validation_failed: ${fails.join(" ") || "a check did not pass"}` };
}

export function DevConsole() {
  const [projectId, setProjectId] = useState("proj_dev");
  const [draftId, setDraftId] = useState("proj_dev");
  const [view, setView] = useState<ProjectView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<PlanProposal | null>(null);
  const [mapMode, setMapMode] = useState<"current" | "proposed">("current");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // log every same-origin /api call, including the ones voice tools make
  useEffect(() => {
    const orig = window.fetch;
    let n = 0;
    window.fetch = async (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return orig(input, init);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const t0 = performance.now();
      const push = (status: number | "ERR") =>
        setLog((l) => [
          { id: ++n + Date.now(), at: new Date().toLocaleTimeString(), method, path: url.pathname + url.search, status, ms: Math.round(performance.now() - t0) },
          ...l.slice(0, 199),
        ]);
      try {
        const res = await orig(input, init);
        push(res.status);
        return res;
      } catch (e) {
        push("ERR");
        throw e;
      }
    };
    return () => {
      window.fetch = orig;
    };
  }, []);

  const base = `/api/projects/${encodeURIComponent(projectId)}`;

  const refresh = useCallback(async () => {
    const r = await api<ProjectView>("GET", base);
    if (r.ok && r.data) {
      setView(r.data);
      setLoadErr(null);
    } else {
      setView(null);
      setLoadErr(r.error);
    }
  }, [base]);

  useEffect(() => {
    // initial load and project switches
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const plan = view?.plan ?? null;
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  const showProposal = mapMode === "proposed" && proposal != null;
  const mapPlan = showProposal ? proposal.result : plan;
  const mapValidations = showProposal ? proposal.validations : (view?.validations ?? []);

  async function reset() {
    if (!confirm(`Reset ${projectId} to its fixture plan?`)) return;
    const r = await api<RoomPlan>("POST", `${base}/reset`);
    setNotice(r.ok ? { kind: "ok", text: `Reset to revision ${r.data?.revision}` } : { kind: "err", text: `Reset failed: ${r.error}` });
    setProposal(null);
    setMapMode("current");
    await refresh();
  }

  function onApply(r: ApplyResult | null, error: string | null) {
    setNotice(applyMessage(r, error));
  }

  return (
    <div className="dev-console">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-5 py-3">
          <h1 className="text-[15px] font-semibold">Backend console</h1>
          <span className="text-xs text-zinc-400">dev only</span>
          <form
            className="ml-4 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setProjectId(draftId.trim());
              setSelectedId(null);
              setProposal(null);
              setMapMode("current");
            }}
          >
            <label className="text-xs text-zinc-500" htmlFor="pid">
              Project
            </label>
            <input id="pid" className="field w-36" value={draftId} onChange={(e) => setDraftId(e.target.value)} />
            <button className="btn">Load</button>
          </form>
          <button className="btn" onClick={() => void refresh()}>
            Refresh
          </button>
          {plan && <span className="text-sm text-zinc-500">revision {plan.revision}</span>}
          <button className="btn btn-danger ml-auto" onClick={reset}>
            Reset project
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-4 px-5 py-4">
        {notice && (
          <div
            className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-sm ${
              notice.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            <span className="flex-1">{notice.text}</span>
            <button className="text-xs opacity-60 hover:opacity-100" onClick={() => setNotice(null)}>
              dismiss
            </button>
          </div>
        )}
        {loadErr && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">Could not load {projectId}: {loadErr}</div>}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-4">
            <section className="card">
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <div className="card-title mb-0">Room map</div>
                <Legend />
                {proposal && (
                  <div className="ml-auto flex overflow-hidden rounded-md border border-zinc-300 text-xs">
                    {(["current", "proposed"] as const).map((m) => (
                      <button
                        key={m}
                        className={`px-3 py-1.5 ${mapMode === m ? "bg-zinc-900 text-white" : "bg-white text-zinc-700 hover:bg-zinc-50"}`}
                        onClick={() => setMapMode(m)}
                      >
                        {m === "current" ? "Current plan" : "Proposed plan"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {mapPlan ? (
                <div className="mx-auto max-w-[860px]">
                  <RoomMap
                    plan={mapPlan}
                    basePlan={showProposal ? plan : null}
                    failing={failingIds(mapValidations)}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                </div>
              ) : (
                <p className="py-20 text-center text-sm text-zinc-400">{loadErr ? "No plan" : "Loading..."}</p>
              )}
            </section>

            <RequestCard
              base={base}
              plan={plan}
              selectedId={selectedId}
              proposal={proposal}
              onProposal={(p) => {
                setProposal(p);
                setMapMode(p ? "proposed" : "current");
              }}
              onApplied={async (r, err) => {
                onApply(r, err);
                if (r?.ok) {
                  setProposal(null);
                  setMapMode("current");
                }
                await refresh();
              }}
            />
          </div>

          <div className="space-y-4">
            {view && <StatusCard view={view} proposal={showProposal ? proposal : null} />}
            {plan && selectedId && (
              <ItemCard
                key={`${projectId}:${selectedId}`}
                base={base}
                plan={mapPlan ?? plan}
                livePlan={plan}
                itemId={selectedId}
                validations={mapValidations}
                onChanged={async (r, err) => {
                  if (r && !r.ok) onApply(r, err);
                  else if (!r) setNotice({ kind: "err", text: err ?? "failed" });
                  await refresh();
                }}
                onResearchDone={refresh}
              />
            )}
            <section className="card">
              <div className="card-title">Voice</div>
              <VoicePanel
                projectId={projectId}
                getSelectedItemId={() => selectedRef.current}
                onPlan={() => void refresh()}
                onProposal={(p) => {
                  setProposal(p);
                  setMapMode("proposed");
                }}
              />
            </section>
          </div>
        </div>

        <CheckoutPanel key={base} base={base} plan={plan} onPlanChanged={refresh} />

        <ActivityLog log={log} onClear={() => setLog([])} />
      </main>
    </div>
  );
}

function Legend() {
  const sw = (cls: string) => <span className={`inline-block h-3 w-4 rounded-[3px] border ${cls}`} />;
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
      <span className="flex items-center gap-1">{sw("border-zinc-600 bg-zinc-300")} owned</span>
      <span className="flex items-center gap-1">{sw("border-emerald-600 bg-emerald-100")} to buy</span>
      <span className="flex items-center gap-1">{sw("border-red-600 border-2")} failing</span>
      <span className="flex items-center gap-1">{sw("border-violet-600 border-dashed")} changed</span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-0.5 w-4 bg-amber-700" /> door
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-0.5 w-4 bg-sky-600" /> window
      </span>
    </div>
  );
}

function ValidationList({ vs }: { vs: ValidationResult[] }) {
  const color = { pass: "bg-emerald-100 text-emerald-800", fail: "bg-red-100 text-red-800", unknown: "bg-amber-100 text-amber-800" };
  const order = { fail: 0, unknown: 1, pass: 2 };
  return (
    <ul className="space-y-1.5">
      {[...vs]
        .sort((a, b) => order[a.status] - order[b.status])
        .map((v, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px] leading-snug">
            <span className={`mt-px shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase ${color[v.status]}`}>{v.status}</span>
            <span>
              <span className="text-zinc-400">{v.rule} </span>
              {v.message}
            </span>
          </li>
        ))}
    </ul>
  );
}

function StatusCard({ view, proposal }: { view: ProjectView; proposal: PlanProposal | null }) {
  const plan = proposal?.result ?? view.plan;
  const cost = proposal?.costAfter ?? view.cost;
  const vs = proposal?.validations ?? view.validations;
  const budget = plan.constraints.budget;
  const seats = seatsOf(plan);
  const min = plan.constraints.minimumSeats;
  const over = budget && cost.knownSubtotal.amountMinor > budget.amountMinor;
  return (
    <section className="card">
      <div className="card-title">{proposal ? "Proposed plan status" : "Plan status"}</div>
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Revision" value={String(plan.revision)} />
        <Stat label="New purchases" value={money(cost.knownSubtotal)} sub={budget ? `of ${money(budget)}` : "no cap"} bad={!!over} />
        <Stat label="Seats" value={String(seats)} sub={min != null ? `min ${min}` : "no min"} bad={min != null && seats < min} />
      </div>
      {cost.unknownPriceItemIds.length > 0 && <p className="mb-2 text-xs text-amber-700">Unknown prices: {cost.unknownPriceItemIds.join(", ")}</p>}
      <ValidationList vs={vs} />
    </section>
  );
}

function Stat({ label, value, sub, bad }: { label: string; value: string; sub?: string; bad?: boolean }) {
  return (
    <div className="rounded-md bg-zinc-50 px-2.5 py-2">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${bad ? "text-red-600" : ""}`}>{value}</div>
      {sub && <div className="text-[11px] text-zinc-400">{sub}</div>}
    </div>
  );
}

function ItemCard({
  base,
  plan,
  livePlan,
  itemId,
  validations,
  onChanged,
  onResearchDone,
}: {
  base: string;
  plan: RoomPlan;
  livePlan: RoomPlan;
  itemId: string;
  validations: ValidationResult[];
  onChanged: (r: ApplyResult | null, err: string | null) => Promise<void>;
  onResearchDone: () => Promise<void>;
}) {
  const item = plan.items.find((i) => i.id === itemId) ?? livePlan.items.find((i) => i.id === itemId);
  const inLive = livePlan.items.some((i) => i.id === itemId);
  const [brief, setBrief] = useState<{ data: Brief | null; error: string | null } | null>(null);
  const [request, setRequest] = useState("");
  const [merchant, setMerchant] = useState<"IKEA" | "Target">("IKEA");
  const [job, setJob] = useState<Job<ResearchJobOutput> | null>(null);
  const [jobErr, setJobErr] = useState<string | null>(null);

  useEffect(() => {
    if (!inLive) return;
    let stale = false;
    void api<Brief>("GET", `${base}/brief?itemId=${encodeURIComponent(itemId)}`).then((r) => {
      if (!stale) setBrief({ data: r.data, error: r.error });
    });
    return () => {
      stale = true;
    };
  }, [base, itemId, inLive, livePlan.revision]);

  // reopen the last research job for this item after a page reload
  const jobKey = `devconsole:job:${base}:${itemId}`;
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(jobKey);
    } catch {}
    if (!saved) return;
    let stale = false;
    void api<Job<ResearchJobOutput>>("GET", `${base}/jobs/${saved}`).then((r) => {
      if (!stale && r.ok && r.data) setJob((j) => j ?? r.data);
    });
    return () => {
      stale = true;
    };
  }, [base, jobKey]);

  const jobId = job?.id;
  const jobDone = job ? TERMINAL.has(job.state) : true;
  useEffect(() => {
    if (!jobId || jobDone) return;
    let alive = true;
    const t = setInterval(async () => {
      const r = await api<Job<ResearchJobOutput>>("GET", `${base}/jobs/${jobId}`);
      if (!alive) return;
      if (!r.ok || !r.data) return setJobErr(r.error);
      setJob(r.data);
      if (r.data.state === "succeeded") void onResearchDone();
    }, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [base, jobId, jobDone, onResearchDone]);

  if (!item) return null;
  const product = plan.products.find((p) => p.id === item.productId) ?? livePlan.products.find((p) => p.id === item.productId);
  const fails = validations.filter((v) => v.status === "fail" && v.itemIds.includes(item.id));

  async function toggleLock() {
    const live = livePlan.items.find((i) => i.id === itemId);
    if (!live) return;
    const change: PlanChange = { kind: "lock", itemId, locked: !live.locked };
    const r = await api<ApplyResult>("POST", `${base}/changes`, { expectedRevision: livePlan.revision, changes: [change] });
    await onChanged(r.data, r.error);
  }

  async function shop() {
    setJobErr(null);
    setJob(null);
    const r = await api<Job<ResearchJobOutput>>("POST", `${base}/research`, { itemId, request: request.trim() || null, merchant });
    if (r.ok && r.data) {
      setJob(r.data);
      try {
        sessionStorage.setItem(jobKey, r.data.id);
      } catch {}
    } else setJobErr(r.error);
  }

  const out = job?.output;
  return (
    <section className="card">
      <div className="card-title">Selected item</div>
      <div className="mb-3">
        <div className="text-[15px] font-semibold leading-snug">{item.label}</div>
        <div className="mt-0.5 text-xs text-zinc-500">
          {item.id} · {item.category} · {item.origin === "existing_owned" ? "owned" : "to buy"}
          {item.seats ? ` · seats ${item.seats}` : ""}
        </div>
      </div>
      <dl className="mb-3 grid grid-cols-[80px_1fr] gap-x-2 gap-y-1 text-[13px]">
        <dt className="text-zinc-500">Size</dt>
        <dd>{meters(item.dimensions)}</dd>
        <dt className="text-zinc-500">Position</dt>
        <dd>
          x {item.position[0].toFixed(2)}, z {item.position[2].toFixed(2)}, rot {((item.rotationY * 180) / Math.PI).toFixed(0)}°
        </dd>
        <dt className="text-zinc-500">Price</dt>
        <dd>{item.origin === "existing_owned" ? "owned" : money(product?.price)}</dd>
        {product && (
          <>
            <dt className="text-zinc-500">Product</dt>
            <dd className="min-w-0">
              <a href={product.sourceUrl} target="_blank" rel="noreferrer" className="break-words text-blue-700 underline-offset-2 hover:underline">
                {product.merchant}: {product.label}
              </a>
              {product.availability !== "available" && <span className="ml-1 text-amber-700">({product.availability})</span>}
            </dd>
          </>
        )}
      </dl>
      {fails.length > 0 && (
        <div className="mb-3 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-800">
          {fails.map((f, i) => (
            <p key={i}>{f.message}</p>
          ))}
        </div>
      )}

      {inLive ? (
        <button className="btn mb-3" onClick={toggleLock}>
          {livePlan.items.find((i) => i.id === itemId)?.locked ? "Unlock" : "Lock"}
        </button>
      ) : (
        <p className="mb-3 text-xs text-violet-700">Only in the proposal. Apply it to edit or shop for this item.</p>
      )}

      {inLive && (
        <>
          <div className="mb-1 text-xs font-medium text-zinc-500">Shopping brief</div>
          <p className="mb-3 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2 text-xs leading-relaxed text-zinc-700">
            {brief == null ? "Loading..." : brief.data ? brief.data.text : `Brief failed: ${brief.error}`}
          </p>

          <div className="mb-1 text-xs font-medium text-zinc-500">Shop for this</div>
          <div className="flex gap-2">
            <input
              className="field min-w-0 flex-1"
              placeholder="optional, e.g. something green"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !(job && !jobDone) && void shop()}
            />
            <select className="field" value={merchant} onChange={(e) => setMerchant(e.target.value as "IKEA" | "Target")}>
              <option>IKEA</option>
              <option>Target</option>
            </select>
            <button className="btn btn-primary" disabled={!!job && !jobDone} onClick={shop}>
              Shop
            </button>
          </div>
          {jobErr && <p className="mt-2 text-xs text-red-700">{jobErr}</p>}
          {job && (
            <div className="mt-2 space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={`rounded px-1.5 py-px font-semibold uppercase ${
                    job.state === "succeeded" ? "bg-emerald-100 text-emerald-800" : job.state === "failed" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {job.state}
                </span>
                <span className="text-zinc-600">{job.stage}</span>
                {!jobDone && <span className="ml-auto animate-pulse text-zinc-400">polling</span>}
              </div>
              {job.error && <p className="text-xs text-red-700">{job.error}</p>}
              {out && (
                <>
                  <p className="text-xs text-zinc-500">
                    {out.results.length} found at {out.merchant}
                    {out.addedAtRevision != null ? `, fitting ones added at revision ${out.addedAtRevision}` : ""}
                    {out.costUsd != null ? `, run cost $${out.costUsd.toFixed(3)}` : ""}
                  </p>
                  <ul className="space-y-2">
                    {out.results.map(({ product: p, fits, problems }) => (
                      <li key={p.id} className="flex gap-2 rounded-md border border-zinc-200 p-2">
                        {p.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={p.imageUrl} alt="" className="size-14 shrink-0 rounded object-cover" />
                        ) : (
                          <div className="size-14 shrink-0 rounded bg-zinc-100" />
                        )}
                        <div className="min-w-0 text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className={`rounded px-1 py-px text-[10px] font-semibold ${fits ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>
                              {fits ? "FITS" : "NO FIT"}
                            </span>
                            <span className="font-medium">{money(p.price)}</span>
                          </div>
                          <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="block truncate text-blue-700 hover:underline">
                            {p.label}
                          </a>
                          <div className="text-zinc-500">{meters(p.dimensions)}</div>
                          {problems.length > 0 && <div className="text-red-700">{problems.join("; ")}</div>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RequestCard({
  base,
  plan,
  selectedId,
  proposal,
  onProposal,
  onApplied,
}: {
  base: string;
  plan: RoomPlan | null;
  selectedId: string | null;
  proposal: PlanProposal | null;
  onProposal: (p: PlanProposal | null) => void;
  onApplied: (r: ApplyResult | null, err: string | null) => Promise<void>;
}) {
  const [intent, setIntent] = useState("");
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState<{ id: string; kind: "ok" | "err"; text: string } | null>(null);

  async function propose() {
    if (!intent.trim()) return;
    setPending(true);
    setErr(null);
    const r = await api<PlanProposal>("POST", `${base}/proposals`, { intent: intent.trim(), selectedItemId: selectedId });
    setPending(false);
    if (r.ok && r.data) onProposal(r.data);
    else setErr(r.error);
  }

  async function apply() {
    if (!proposal) return;
    setApplying(true);
    const r = await api<ApplyResult>("POST", `${base}/proposals/${proposal.id}/apply`, { expectedRevision: proposal.baseRevision });
    setApplying(false);
    setApplyMsg({ id: proposal.id, ...applyMessage(r.data, r.error) });
    await onApplied(r.data, r.error);
  }

  const before = proposal?.costBefore.knownSubtotal.amountMinor ?? 0;
  const after = proposal?.costAfter.knownSubtotal.amountMinor ?? 0;
  return (
    <section className="card">
      <div className="card-title">Ask for a change</div>
      <div className="flex gap-2">
        <input
          className="field min-w-0 flex-1"
          placeholder="e.g. Keep my sofa and desk, make the room $300 cheaper, keep seating for four"
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !pending && void propose()}
        />
        <button className="btn btn-primary" disabled={pending || !intent.trim() || !plan} onClick={propose}>
          {pending ? "Planning..." : "Propose"}
        </button>
      </div>
      <p className="mt-1.5 text-xs text-zinc-400">
        Sent with selectedItemId: {selectedId ?? "none"}. Planning takes about 10 seconds.
      </p>
      {err && <p className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">{err}</p>}

      {proposal && (
        <div className="mt-4 space-y-3 border-t border-zinc-100 pt-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-xs text-zinc-400">
              {proposal.id} · base revision {proposal.baseRevision}
              {plan && plan.revision !== proposal.baseRevision ? ` (plan is now at ${plan.revision})` : ""}
            </span>
          </div>
          <p className="text-sm leading-relaxed">{proposal.summary}</p>
          <div className="flex flex-wrap gap-4 text-sm">
            <span>
              <span className="text-zinc-500">Cost </span>
              {money(proposal.costBefore.knownSubtotal)} to <span className="font-semibold">{money(proposal.costAfter.knownSubtotal)}</span>
              {before !== after && (
                <span className={after < before ? "text-emerald-700" : "text-red-700"}>
                  {" "}
                  ({after < before ? "-" : "+"}
                  {money({ amountMinor: Math.abs(after - before), currency: "USD" })})
                </span>
              )}
            </span>
            <span>
              <span className="text-zinc-500">Seats </span>
              {seatsOf(proposal.result)}
            </span>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-zinc-500">Changes ({proposal.changes.length})</div>
            {proposal.changes.length === 0 ? (
              <p className="text-xs text-zinc-500">No changes proposed.</p>
            ) : (
              <ul className="space-y-1 text-[13px]">
                {proposal.changes.map((c, i) => (
                  <li key={i} className="rounded bg-zinc-50 px-2 py-1">
                    {describe(c, plan, proposal.result)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-zinc-500">Validations</div>
            <ValidationList vs={proposal.validations} />
          </div>
          {applyMsg?.id === proposal.id && (
            <p className={`rounded-md px-2 py-1.5 text-sm ${applyMsg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>{applyMsg.text}</p>
          )}
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={applying || proposal.changes.length === 0} onClick={apply}>
              {applying ? "Applying..." : "Apply"}
            </button>
            <button className="btn" onClick={() => onProposal(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function describe(c: PlanChange, plan: RoomPlan | null, result: RoomPlan) {
  const label = (id: string) => plan?.items.find((i) => i.id === id)?.label ?? result.items.find((i) => i.id === id)?.label ?? id;
  const prod = (id: string) => {
    const p = result.products.find((x) => x.id === id);
    return p ? `${p.label} (${money(p.price)})` : id;
  };
  switch (c.kind) {
    case "replace":
      return (
        <>
          <b className="font-medium">Replace</b> {label(c.itemId)} with {prod(c.productId)}
        </>
      );
    case "remove":
      return (
        <>
          <b className="font-medium">Remove</b> {label(c.itemId)}
        </>
      );
    case "add":
      return (
        <>
          <b className="font-medium">Add</b> {c.item.label}
        </>
      );
    case "move":
      return (
        <>
          <b className="font-medium">Move</b> {label(c.itemId)} to x {c.position[0].toFixed(2)}, z {c.position[2].toFixed(2)}
        </>
      );
    case "lock":
      return (
        <>
          <b className="font-medium">{c.locked ? "Lock" : "Unlock"}</b> {label(c.itemId)}
        </>
      );
    case "add_products":
      return (
        <>
          <b className="font-medium">Add products</b> {c.products.length}
        </>
      );
    case "set_constraints":
      return (
        <>
          <b className="font-medium">Constraints</b> {JSON.stringify(c.constraints)}
        </>
      );
  }
}

function ActivityLog({ log, onClear }: { log: LogEntry[]; onClear: () => void }) {
  return (
    <section className="card">
      <div className="mb-2 flex items-center">
        <div className="card-title mb-0">Activity</div>
        <span className="ml-2 text-xs text-zinc-400">{log.length} calls</span>
        <button className="btn ml-auto" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full table-fixed text-left text-[13px] tabular-nums">
          <thead className="sticky top-0 bg-white text-xs text-zinc-400">
            <tr>
              <th className="w-28 py-1 pr-3 font-medium">Time</th>
              <th className="w-20 py-1 pr-3 font-medium">Method</th>
              <th className="py-1 pr-3 font-medium">Path</th>
              <th className="w-20 py-1 pr-3 font-medium">Status</th>
              <th className="w-20 py-1 text-right font-medium">ms</th>
            </tr>
          </thead>
          <tbody>
            {log.map((e) => (
              <tr key={e.id} className="border-t border-zinc-100">
                <td className="py-1 pr-3 text-zinc-400">{e.at}</td>
                <td className="py-1 pr-3 font-medium">{e.method}</td>
                <td className="truncate py-1 pr-3 text-zinc-700">{e.path}</td>
                <td className={`py-1 pr-3 ${e.status === "ERR" || e.status >= 400 ? "text-red-600" : "text-emerald-700"}`}>{e.status}</td>
                <td className="py-1 text-right text-zinc-500">{e.ms}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {log.length === 0 && <p className="py-3 text-center text-xs text-zinc-400">No calls yet</p>}
      </div>
    </section>
  );
}
