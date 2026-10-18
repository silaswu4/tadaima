"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FurnitureCategory, Job, PlanChange, PlanProposal, RoomPlan, ShopJobOutput, ShopRequest, ShopResult } from "../../backend/contracts";
import type { RoomCapabilities } from "../../backend/room-session-client";
import { roomProposalBlockers } from "../rooms/agent-operations";
import "./RoomAssistant.css";
import { RoomFetch } from "./RoomFetch";
import type { RoomFetchConnection } from "../rooms/use-room-fetch";

const money = (minor: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
const categories: FurnitureCategory[] = ["sofa", "chair", "table", "storage", "desk", "bed", "rug", "lamp", "decor"];
type Props = {
  plan: RoomPlan; capabilities: RoomCapabilities; selectedId: string | null;
  busy: boolean; job: Job<ShopJobOutput> | null; results: ShopResult[];
  onClose(): void; onBasket(): void; onRefresh(): Promise<unknown>;
  onPropose(request: string): Promise<PlanProposal>; onApply(proposal: PlanProposal): Promise<void>;
  onSearch(request: Omit<ShopRequest, "spot">): Promise<void>; onPreview(result: ShopResult): boolean;
  proposal: PlanProposal | null; onProposal(proposal: PlanProposal | null): void;
  fetchConnection: RoomFetchConnection; onFetchPreview(job: Job<ShopJobOutput>, productId: string): Promise<boolean>;
};

function changeText(change: PlanChange, plan: RoomPlan) {
  const label = "itemId" in change ? plan.items.find((item) => item.id === change.itemId)?.label ?? "Piece" : "";
  switch (change.kind) {
    case "move": return `Move ${label} to ${change.position[0].toFixed(2)} m, ${change.position[2].toFixed(2)} m.`;
    case "replace": return `Replace ${label} with ${plan.products.find((product) => product.id === change.productId)?.label ?? "the proposed product"}.`;
    case "remove": return `Remove ${label}.`;
    case "store": return `Put ${label} away.`;
    case "take_out": return `Bring ${label} back into the room.`;
    case "lock": return `${change.locked ? "Lock" : "Unlock"} ${label}.`;
    case "add": return `Add ${change.item.label}.`;
    case "add_products": return `Add ${change.products.length} researched products to the catalog.`;
    case "set_constraints": return [change.constraints.budget ? `Set budget to ${money(change.constraints.budget.amountMinor, change.constraints.budget.currency)}.` : "", change.constraints.minimumSeats != null ? `Keep seating for ${change.constraints.minimumSeats}.` : "", change.constraints.clearance != null ? `Keep ${change.constraints.clearance} m clearance.` : ""].filter(Boolean).join(" ") || "Update room requirements.";
  }
}

export function RoomAssistant(props: Props) {
  const dialogRef = useRef<HTMLDivElement>(null), closeRef = useRef<HTMLButtonElement>(null);
  const active = useRef(true), current = useRef(props);
  useLayoutEffect(() => { current.current = props; });
  const [mode, setMode] = useState<"search" | "plan" | "fetch">("search");
  const [request, setRequest] = useState("");
  const [category, setCategory] = useState<FurnitureCategory>("chair");
  const [cap, setCap] = useState("300"), [merchant, setMerchant] = useState<"IKEA" | "Target">("IKEA");
  const proposal = props.proposal;
  const setProposal = (next: PlanProposal | null) => current.current.onProposal(next);
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { active.current = true; closeRef.current?.focus({ preventScroll: true }); return () => { active.current = false; }; }, []);

  async function propose(text: string) {
    setPending(true); setError(""); setProposal(null); setMessage("Planning a change for this room…");
    try { const next = await current.current.onPropose(text); if (active.current) { setProposal(next); setMessage("Review the proposal. Your room has not changed yet."); } return next; }
    catch (cause) { if (active.current) { setError(cause instanceof Error ? cause.message : "Planning could not finish."); setMessage(""); } throw cause; }
    finally { if (active.current) setPending(false); }
  }
  const busy = props.busy || pending;
  const stale = !!proposal && (proposal.projectId !== props.plan.projectId || proposal.baseRevision !== props.plan.revision);
  const blockers = useMemo(() => proposal ? roomProposalBlockers(props.plan, proposal) : [], [props.plan, proposal]);

  async function search() {
    const amount = cap.trim() ? Number(cap) : undefined;
    if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0 || amount > 100000)) { setError("Choose a price cap between $0.01 and $100,000."); return; }
    setError(""); setPending(true); setMessage("Finding furniture for your floor spot…");
    try { await props.onSearch({ category, merchant, maxPriceUsd: amount, request: request.trim().slice(0, 300) || undefined, live: props.capabilities.liveSearch }); }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : "Search could not finish."); }
    finally { if (active.current) setPending(false); }
  }
  async function apply() {
    if (!proposal || busy || stale) return;
    setPending(true); setError("");
    try { await props.onApply(proposal); if (active.current) { setProposal(null); setMessage("Changes applied to this room and saved."); } }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : "The proposal was not applied."); }
    finally { if (active.current) setPending(false); }
  }

  return <div ref={dialogRef} className="room-x__panel" data-open="true" role="dialog" aria-modal="true" aria-label="Room assistant" onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') ?? [])].filter((element) => element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
  }}>
    <div className="room-x__panel-head"><div><h2 className="room-x__panel-title">Ask Tadaima</h2><p className="room-x__panel-sub">Find furniture for this spot or plan a change to your room.</p></div><button ref={closeRef} type="button" className="room-x__icon-btn" onClick={props.onClose} aria-label="Close assistant">×</button></div>
    <div className="room-agent__body">
      <p className="room-agent__context">{props.selectedId ? `Selected: ${props.plan.items.find((item) => item.id === props.selectedId)?.label ?? "piece"}` : "Shopping where you’re looking, or at your selected floor spot."}</p>
      <div className="room-agent__tabs" role="group" aria-label="Assistant task"><button className="room-x__chip" aria-pressed={mode === "search"} onClick={() => setMode("search")}>Find furniture</button><button className="room-x__chip" aria-pressed={mode === "plan"} onClick={() => setMode("plan")}>Change the room</button><button className="room-x__chip" aria-pressed={mode === "fetch"} onClick={() => setMode("fetch")}>Fetch chat</button></div>
      {mode !== "fetch" ? <form className="room-agent__form" onSubmit={(event) => { event.preventDefault(); if (!busy) { if (mode === "search") void search(); else if (props.capabilities.planning) void propose(request).catch(() => undefined); } }}>
        <label>{mode === "search" ? "What should it be like?" : "What would you like to change?"}<textarea value={request} maxLength={mode === "search" ? 300 : 500} rows={3} onChange={(event) => setRequest(event.target.value)} placeholder={mode === "search" ? "Warm wood, comfortable, easy to clean…" : "Keep my sofa, move the desk, and keep room for four people…"} /></label>
        {mode === "search" ? <><div className="room-agent__fields"><label>Furniture<select value={category} onChange={(event) => setCategory(event.target.value as FurnitureCategory)}>{categories.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label>Under $<input inputMode="decimal" type="number" min="0.01" max="100000" step="0.01" value={cap} onChange={(event) => setCap(event.target.value)} /></label><label>Store<select value={merchant} onChange={(event) => setMerchant(event.target.value as "IKEA" | "Target")}><option>IKEA</option><option>Target</option></select></label></div><p className="room-agent__note">{props.capabilities.liveSearch ? "Saved catalog results first, then live retailer research." : "Searching saved catalog observations. Live store research is unavailable here."}</p></> : <p className="room-agent__note">{props.capabilities.planning ? "The agent proposes changes; you review cost and room checks before applying them." : "Room planning is unavailable here. Furniture search still works."}</p>}
        <button className="room-x__chip-btn room-x__chip-btn--ink" disabled={busy || (mode === "plan" && (!props.capabilities.planning || !request.trim()))}>{busy ? "Working…" : mode === "search" ? "Find furniture that fits" : "Plan changes"}</button>
      </form> : null}
      {error ? <p className="room-agent__error" role="alert">{error}</p> : null}
      <p className="room-agent__note" role="status">{props.job && mode === "search" ? `${props.job.stage}${props.job.output?.live === "failed" ? " · live search unavailable" : ""}` : message}</p>
      {mode === "search" && props.job ? <ul className="room-agent__results" aria-label="Assistant furniture results">{props.results.map((result, index) => <li key={result.product.id}><div><strong>{index + 1}. {result.product.label}</strong><p>{result.product.price ? money(result.product.price.amountMinor, result.product.price.currency) : "Price unknown"} · {result.source === "live" ? "live observation" : "saved catalog"}</p><p>{result.fits ? result.withinBudget === false ? "Fits, but exceeds your room budget." : "Fits this spot." : result.problems.join(" ") || "Fit unverified."}</p></div><button className="room-x__chip-btn" disabled={busy || !result.fits || !result.placement} onClick={() => props.onPreview(result)}>Preview</button></li>)}</ul> : null}
      {proposal && mode === "plan" ? <section className="room-agent__proposal" aria-label="Review proposed room changes"><h3>Review changes</h3><p>{proposal.summary}</p><ul>{proposal.changes.map((change, index) => <li key={index}>{changeText(change, props.plan)}</li>)}</ul><p>New purchases: {money(proposal.costBefore.knownSubtotal.amountMinor, proposal.costBefore.knownSubtotal.currency)} → {money(proposal.costAfter.knownSubtotal.amountMinor, proposal.costAfter.knownSubtotal.currency)}. Shipping and tax are unknown.</p>{proposal.costAfter.unknownPriceItemIds.length ? <p>Some proposed pieces have unknown prices.</p> : null}<ul>{proposal.validations.filter((check) => check.status !== "pass").map((check, i) => <li key={i}>{blockers.includes(check) ? "Blocked" : check.status === "fail" ? "Existing issue" : "Unverified"}: {check.message}</li>)}</ul>{stale ? <p role="status">The room changed. Ask for a fresh proposal.</p> : null}<div className="room-agent__actions"><button className="room-x__chip-btn" disabled={busy} onClick={() => setProposal(null)}>Discard</button><button className="room-x__chip-btn room-x__chip-btn--ink" disabled={busy || stale || !proposal.changes.length || blockers.length > 0} onClick={() => void apply()}>Apply changes</button></div></section> : null}
      {mode !== "fetch" ? <section className="room-agent__voice"><h3>Talk it through</h3><p className="room-agent__note">{props.capabilities.voice ? "Use Talk in the room tools to search, draft changes and rearrange unlocked pieces. Voice stays connected while you review proposals and placement previews. Apply changes, confirm placements and review payments on screen." : "Voice is unavailable here. Text and touch controls still work."}</p></section> : null}
      {mode === "fetch" ? <RoomFetch connection={props.fetchConnection} busy={busy} onPreview={props.onFetchPreview} onReview={(next) => { setProposal(next); setMode("plan"); setMessage("Review the proposal from your Fetch chat."); }} /> : null}
      <button className="room-x__text-btn" onClick={props.onBasket}>Review basket</button>
    </div>
  </div>;
}
