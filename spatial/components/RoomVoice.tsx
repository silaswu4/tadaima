"use client";

import dynamic from "next/dynamic";
import { useLayoutEffect, useRef, useState } from "react";
import { VoiceBeam, getAudioContext } from "voice-glow";
import type { FloorSpot, Job, PlanProposal, RoomPlan, ShopJobOutput, ShopRequest, ShopResult } from "../../backend/contracts";
import { createRoomAgentTools } from "../rooms/agent-tools";
import "./RoomVoice.css";

const Session = dynamic(() => import("./RoomAgentVoice"), { ssr: false, loading: () => <span role="status">Loading voice…</span> });
type Props = {
  plan: RoomPlan | null;
  selectedId: string | null;
  job: Job<ShopJobOutput> | null;
  results: ShopResult[];
  liveSearch: boolean;
  available: boolean;
  disabled?: boolean;
  getSpot(): FloorSpot;
  onRefresh(): Promise<unknown>;
  onPropose(request: string): Promise<PlanProposal>;
  onSearch(request: Omit<ShopRequest, "spot">): Promise<void>;
  onPreview(result: ShopResult): boolean;
  onMove(itemId: string, spot: FloorSpot): Promise<void>;
  onStore(itemId: string): Promise<void>;
};

/** One room-level voice session, shared with every screen and review panel.
 * Only the shopper's Talk click loads the SDK and starts microphone setup. */
export function RoomVoice(props: Props) {
  const current = useRef(props);
  useLayoutEffect(() => { current.current = props; });
  const [enabled, setEnabled] = useState(false);
  const projectId = props.plan?.projectId;
  const getTools = () => {
    const initial = current.current;
    if (!initial.plan) throw new Error("Connect the room before starting voice.");
    const id = initial.plan.projectId;
    return createRoomAgentTools({
      projectId: id,
      active: () => current.current.plan?.projectId === id,
      context: () => {
        const value = current.current;
        if (!value.plan) throw new Error("This room is no longer connected.");
        return { plan: value.plan, selectedId: value.selectedId, job: value.job, results: value.results };
      },
      refresh: () => current.current.onRefresh(), propose: (request) => current.current.onPropose(request),
      search: (request) => current.current.onSearch(request), preview: (result) => current.current.onPreview(result),
      spot: () => current.current.getSpot(), move: (id, spot) => current.current.onMove(id, spot),
      store: (id) => current.current.onStore(id), liveSearch: initial.liveSearch,
    });
  };
  const output = props.job?.output;
  const update = props.job && props.job.projectId === projectId ? {
    id: `${props.job.id}:${props.job.updatedAt}`,
    text: `[app update] ${props.job.stage}. ${output?.live === "failed" ? "Live research failed; saved catalog observations remain." : output?.live === "skipped" ? "Catalog search only." : ""} ${props.results.slice(0, 6).map((result, i) => `${i + 1}) ${result.product.label}, ${result.product.price ? new Intl.NumberFormat("en-US", { style: "currency", currency: result.product.price.currency }).format(result.product.price.amountMinor / 100) : "price unknown"}, ${result.fits ? "fits" : "does not fit"}${result.withinBudget === false ? ", over budget" : ""}`).join("; ")} Previews require on-screen confirmation.`,
  } : undefined;

  if (enabled && projectId) return <Session key={projectId} projectId={projectId} getTools={getTools} update={update} disabled={props.disabled || !props.available} autoStart />;
  return <div className="room-voice"><VoiceBeam type="pill" theme="light" colorVariant="sunset" level={() => 0} active={false} className="room-voice__beam">
    <button type="button" className="room-x__pill room-voice__btn" disabled={props.disabled || !props.available || !projectId} title={!props.available ? "Voice is unavailable on this server" : "Talk to the room"} aria-label="Talk to the room" onClick={() => { getAudioContext(); setEnabled(true); }}>
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><rect x="7" y="2.5" width="6" height="10" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" /></svg><span>Talk</span>
    </button>
  </VoiceBeam></div>;
}
