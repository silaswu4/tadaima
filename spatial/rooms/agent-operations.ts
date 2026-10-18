import type { PlanProposal, RoomPlan } from "../../backend/contracts";
import type { RoomClient } from "../../backend/client";
import { mutationMessage } from "../../backend/room-session-client";
import { blocking } from "../../backend/plan/rules";

export class AgentRevisionConflict extends Error {}
export const roomProposalBlockers = (plan: RoomPlan, proposal: PlanProposal) => blocking(plan, proposal.changes, proposal.result, proposal.validations);

export async function requestRoomProposal(client: Pick<RoomClient, "propose">, plan: RoomPlan, request: string, selectedId: string | null) {
  const intent = request.trim();
  if (!intent || intent.length > 500) throw new Error("Describe a room change in 1–500 characters.");
  if (selectedId && !plan.items.some((item) => item.id === selectedId && !item.stored)) throw new Error("Select a piece that is still in this room.");
  const proposal = await client.propose(intent, selectedId);
  if (proposal.projectId !== plan.projectId || proposal.result.projectId !== plan.projectId) throw new Error("The agent returned a proposal for another room.");
  if (proposal.baseRevision !== plan.revision) throw new AgentRevisionConflict("The room changed while planning. Ask for a new proposal.");
  return proposal;
}

/** Only reviewed proposals for this exact canonical room/revision can be applied. */
export async function applyRoomProposal(client: Pick<RoomClient, "apply">, plan: RoomPlan, proposal: PlanProposal): Promise<RoomPlan> {
  if (proposal.projectId !== plan.projectId || proposal.result.projectId !== plan.projectId) throw new Error("This proposal belongs to another room.");
  if (proposal.baseRevision !== plan.revision) throw new AgentRevisionConflict("The room changed. Ask for a new proposal before applying it.");
  if (!proposal.changes.length) throw new Error("This proposal has no changes to apply.");
  if (roomProposalBlockers(plan, proposal).length) throw new Error("This proposal fails room checks. Ask for a revised plan.");
  const result = await client.apply(proposal);
  if (!result.ok) {
    if (result.reason === "stale_revision") throw new AgentRevisionConflict(mutationMessage(result));
    throw new Error(mutationMessage(result));
  }
  if (result.plan.projectId !== plan.projectId) throw new Error("The agent returned an update for another room.");
  return result.plan;
}
