"use client";

import type { RoomPlan } from "@/backend/contracts";
import { describeChange, diffPlans, dimensionSource, validatePlan, type PlanIssue } from "@/spatial/room/plan";
import type { ItemRenderState } from "@/spatial/room/viewer";

// the same pieces as the 3D view, as a plain list. works with a keyboard, a
// screen reader, or a touch screen, and never needs hover to show details.

export interface RoomInventoryProps {
  plan: RoomPlan;
  previousPlan?: RoomPlan | null;
  showChanges?: boolean;
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  itemStates?: Record<string, ItemRenderState>;
  className?: string;
}

const cm = (m: number) => Math.round(m * 100);

const DRAWN: Record<ItemRenderState["kind"], string> = {
  loading: "Loading model",
  model: "Model",
  proxy: "Sized stand-in",
  marker: "Marker only",
};

export function RoomInventory({
  plan,
  previousPlan = null,
  showChanges = true,
  selectedItemId,
  onSelectItem,
  itemStates = {},
  className = "",
}: RoomInventoryProps) {
  const changes = previousPlan && showChanges ? diffPlans(previousPlan, plan).changes : [];
  const removed = changes.filter((c) => c.kind === "removed");

  return (
    <section aria-label="Pieces in this room" className={`text-[13px] text-ink ${className}`}>
      <ul className="divide-y divide-ink/10 border-y border-ink/10">
        {plan.items.map((item) => {
          const source = dimensionSource(plan, item);
          const state = itemStates[item.id];
          const change = changes.find((c) => c.id === item.id);
          const selected = item.id === selectedItemId;
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelectItem(selected ? null : item.id)}
                className={`flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition-colors ${selected ? "bg-ink text-surface-soft" : "hover:bg-ink/5"}`}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span>{item.label}</span>
                  <span className={selected ? "text-surface-soft/60" : "text-ink-soft"}>
                    {source.kind === "unknown"
                      ? "Size unknown"
                      : `${cm(source.size[0])} x ${cm(source.size[2])} x ${cm(source.size[1])} cm`}
                  </span>
                </span>
                <span className={`flex flex-wrap gap-x-3 text-[12px] ${selected ? "text-surface-soft/60" : "text-ink-soft"}`}>
                  <span>{item.origin === "existing_owned" ? "Owned" : "Proposed purchase"}</span>
                  {item.locked && <span>Locked</span>}
                  {state && <span>{state.failed ? `${DRAWN[state.kind]}, model failed` : DRAWN[state.kind]}</span>}
                  {change && <span className={selected ? "" : "text-accent-deep"}>{describeChange(change)}</span>}
                </span>
              </button>
            </li>
          );
        })}
        {removed.map((c) => (
          <li key={c.id} className="flex items-baseline justify-between gap-3 px-3 py-2.5 text-ink-soft">
            <span className="line-through">{c.item.label}</span>
            <span className="text-[12px] text-accent-deep">Removed in revision {plan.revision}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PlanIssues({ plan, className = "" }: { plan: RoomPlan; className?: string }) {
  const issues: PlanIssue[] = validatePlan(plan);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  if (!issues.length) return <p className={`text-[13px] text-ink-soft ${className}`}>No geometry or evidence gaps found.</p>;
  return (
    <section aria-label="Plan gaps" className={`text-[13px] ${className}`}>
      <p className="text-ink-soft">
        {errors.length ? `${errors.length} must be fixed before this plan can be trusted. ` : ""}
        {warnings.length} {warnings.length === 1 ? "thing is" : "things are"} unknown or unverified.
      </p>
      <ul className="mt-2 space-y-1">
        {[...errors, ...warnings].map((issue, i) => (
          <li key={`${issue.code}-${issue.entityId}-${i}`} className={issue.severity === "error" ? "text-accent-deep" : "text-ink"}>
            {issue.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
