import type { ApplyResult, PlanProposal, RoomPlan } from "@/backend/contracts";

/**
 * Browser-safe implementations of the voice agent's client tools. They call
 * the same routes as the UI and return plain sentences, which is what the
 * agent hears. Pass the result to ElevenLabs' `clientTools`:
 *
 *   const tools = voiceClientTools({ projectId, getSelectedItemId: () => selected, onPlan: setPlan });
 *   <ConversationProvider clientTools={tools}> ... startSession({ conversationToken })
 *
 * Get the token from GET /api/voice/token.
 */

const dollars = (minor: number) => `$${Math.round(minor / 100).toLocaleString("en-US")}`;

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json as T;
}

export function voiceClientTools(opts: {
  projectId: string;
  getSelectedItemId: () => string | null;
  /** Called with the new plan after an applied change, so the viewer updates. */
  onPlan?: (plan: RoomPlan) => void;
  /** Called with each proposal so the UI can show the diff while it's read aloud. */
  onProposal?: (proposal: PlanProposal) => void;
}) {
  const base = `/api/projects/${opts.projectId}`;
  const proposals = new Map<string, PlanProposal>();

  return {
    get_room: async () => {
      const res = await fetch(base);
      if (!res.ok) return "I couldn't load the room.";
      const { plan, cost } = (await res.json()) as { plan: RoomPlan; cost: { knownSubtotal: { amountMinor: number } } };
      const selected = opts.getSelectedItemId();
      const lines = plan.items.map((i) => {
        const price = plan.products.find((p) => p.id === i.productId)?.price;
        const tag = i.origin === "existing_owned" ? "owned" : price ? dollars(price.amountMinor) : "price unknown";
        return `${i.label} (${tag}${i.locked ? ", locked" : ""}${i.seats ? `, seats ${i.seats}` : ""}${i.id === selected ? ", selected" : ""})`;
      });
      const budget = plan.constraints.budget;
      return `Items: ${lines.join("; ")}. New purchases total ${dollars(cost.knownSubtotal.amountMinor)}${
        budget ? ` of a ${dollars(budget.amountMinor)} budget` : ""
      }. Needs to seat ${plan.constraints.minimumSeats ?? "any number of"} people.`;
    },

    propose_change: async ({ request }: { request: string }) => {
      try {
        const p = await post<PlanProposal>(`${base}/proposals`, { intent: request, selectedItemId: opts.getSelectedItemId() });
        proposals.set(p.id, p);
        opts.onProposal?.(p);
        const failed = p.validations.filter((v) => v.status === "fail");
        const diff = p.costBefore.knownSubtotal.amountMinor - p.costAfter.knownSubtotal.amountMinor;
        if (p.changes.length === 0) return `No change proposed. ${p.summary}`;
        return `Proposal ${p.id}. ${p.summary} ${
          failed.length ? `It fails these checks: ${failed.map((f) => f.message).join(" ")}` : "It passes every check."
        } New purchases go from ${dollars(p.costBefore.knownSubtotal.amountMinor)} to ${dollars(p.costAfter.knownSubtotal.amountMinor)}${
          diff > 0 ? `, saving ${dollars(diff)}` : ""
        }.`;
      } catch (e) {
        return `Planning failed: ${(e as Error).message}`;
      }
    },

    apply_proposal: async ({ proposal_id }: { proposal_id: string }) => {
      const p = proposals.get(proposal_id);
      if (!p) return "I don't have that proposal anymore. Ask me to plan it again.";
      try {
        const r = await post<ApplyResult>(`${base}/proposals/${proposal_id}/apply`, { expectedRevision: p.baseRevision });
        if (r.ok) {
          opts.onPlan?.(r.plan);
          return "ok: the room is updated.";
        }
        if (r.reason === "stale_revision") return "Not applied: the room changed since this was planned. Ask me to plan it again.";
        return `Not applied: ${r.validations.filter((v) => v.status === "fail").map((v) => v.message).join(" ")}`;
      } catch (e) {
        return `Not applied: ${(e as Error).message}`;
      }
    },
  };
}
