"use client";

import dynamic from "next/dynamic";
import { useLayoutEffect, useRef } from "react";
import type { FloorSpot, Job, PlanProposal, RoomPlan, ShopJobOutput, ShopRequest, ShopResult } from "../../backend/contracts";
import { createRoomAgentTools } from "../rooms/agent-tools";
import "./RoomVoice.css";

const Session = dynamic(() => import("./RoomAgentVoice"), { ssr: false });
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
  onApply(proposalId: string): Promise<void>;
  onSetBudget(amountMinor: number): Promise<unknown>;
  getProposal(): PlanProposal | null;
  onSearch(request: Omit<ShopRequest, "spot">): Promise<void>;
  onPreview(result: ShopResult): boolean;
  onPlace(result: ShopResult, job: Job<ShopJobOutput>): Promise<void>;
  onMove(itemId: string, spot: FloorSpot, unlock: boolean): Promise<void>;
  onStore(itemId: string, unlock: boolean): Promise<void>;
};

/** The room's one voice session: always there once the room is connected, push to talk. */
export function RoomVoice(props: Props) {
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const projectId = props.plan?.projectId;
  const getTools = () => {
    const initial = current.current;
    if (!initial.plan) throw new Error("Connect the room before starting voice.");
    const id = initial.plan.projectId;
    const p = () => current.current;
    return createRoomAgentTools({
      projectId: id,
      active: () => p().plan?.projectId === id,
      context: () => {
        const value = p();
        if (!value.plan) throw new Error("This room is no longer connected.");
        return { plan: value.plan, selectedId: value.selectedId, job: value.job, results: value.results };
      },
      refresh: () => p().onRefresh(),
      propose: (request) => p().onPropose(request),
      apply: (proposalId) => p().onApply(proposalId),
      proposal: () => p().getProposal(),
      setBudget: async (amountMinor) => {
        await p().onSetBudget(amountMinor);
      },
      search: (request) => p().onSearch(request),
      preview: (result) => p().onPreview(result),
      place: (result, job) => p().onPlace(result, job),
      spot: () => p().getSpot(),
      move: (itemId, spot, unlock) => p().onMove(itemId, spot, unlock),
      store: (itemId, unlock) => p().onStore(itemId, unlock),
      liveSearch: initial.liveSearch,
    });
  };

  // a live search that just finished is worth telling the shopper about, once
  const output = props.job?.output;
  const finished = props.job && props.job.projectId === projectId && output && output.live !== "running" && output.live !== "skipped";
  const update = finished
    ? {
        id: `${props.job!.id}:final`,
        text: `[app update] The live search finished. ${props.results
          .slice(0, 5)
          .map(
            (r, i) =>
              `${i + 1}) ${r.product.label}, ${r.product.price ? `$${Math.round(r.product.price.amountMinor / 100)}` : "price unknown"}, ${r.fits ? "fits" : "doesn't fit"}${r.withinBudget === false ? ", over budget" : ""}${r.source === "live" ? ", just found" : ""}`,
          )
          .join("; ")}.`,
      }
    : undefined;

  if (!projectId || !props.available) return null;
  return <Session key={projectId} projectId={projectId} getTools={getTools} update={update} disabled={props.disabled} />;
}
