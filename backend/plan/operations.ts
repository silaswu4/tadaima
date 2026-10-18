import "server-only";

import type { ApplyResult, PlanChange, PlanProposal, RoomPlan } from "@/backend/contracts";
import { planChanges } from "@/backend/plan/planner";
import { applyChanges, costOf, passes, PlanChangeError, validate, validateChanges } from "@/backend/plan/rules";
import { getPlan, getProposal, resetPlan, savePlan, saveProposal } from "@/backend/plan/store";

/**
 * The one set of plan operations. Web routes, the voice agent and the Fetch
 * agent all call these; none of them touch the store or rules directly.
 */

export class NotFound extends Error {}

async function mustGetPlan(projectId: string) {
  const plan = await getPlan(projectId);
  if (!plan) throw new NotFound(`no project ${projectId}`);
  return plan;
}

export async function getProject(projectId: string) {
  const plan = await mustGetPlan(projectId);
  return { plan, cost: costOf(plan), validations: validate(plan) };
}

export async function resetProject(projectId: string) {
  const plan = await resetPlan(projectId);
  if (!plan) throw new NotFound(`no fixture for ${projectId}`);
  return plan;
}

export async function proposePlanChange(projectId: string, intent: string, selectedItemId: string | null = null): Promise<PlanProposal> {
  const plan = await mustGetPlan(projectId);
  const out = await planChanges(plan, intent, selectedItemId);
  const proposal: PlanProposal = {
    id: `prop_${crypto.randomUUID().slice(0, 8)}`,
    projectId,
    baseRevision: plan.revision,
    intent,
    changes: out.changes,
    result: out.result,
    validations: out.validations,
    costBefore: costOf(plan),
    costAfter: costOf(out.result),
    summary: out.summary,
    createdAt: new Date().toISOString(),
  };
  await saveProposal(proposal);
  return proposal;
}

/** Re-applies the proposal's changes to the current plan rather than trusting its stored result. */
export async function applyProposal(projectId: string, proposalId: string, expectedRevision: number): Promise<ApplyResult> {
  const proposal = await getProposal(projectId, proposalId);
  if (!proposal) throw new NotFound(`no proposal ${proposalId} (they expire after an hour)`);
  if (proposal.baseRevision !== expectedRevision) {
    const plan = await mustGetPlan(projectId);
    return { ok: false, reason: "stale_revision", currentRevision: plan.revision };
  }
  return applyPlanChanges(projectId, expectedRevision, proposal.changes);
}

/** Direct edits from the UI (drag, lock, a picked swap). Same validation as proposals. */
export async function applyPlanChanges(projectId: string, expectedRevision: number, changes: PlanChange[]): Promise<ApplyResult> {
  const plan = await mustGetPlan(projectId);
  if (plan.revision !== expectedRevision) return { ok: false, reason: "stale_revision", currentRevision: plan.revision };
  let next: RoomPlan;
  try {
    next = applyChanges(plan, changes);
  } catch (e) {
    if (e instanceof PlanChangeError) {
      return { ok: false, reason: "validation_failed", validations: [{ rule: "product_known", status: "fail", itemIds: [], message: e.message }] };
    }
    throw e;
  }
  const validations = validateChanges(plan, changes, next);
  if (!passes(validations)) return { ok: false, reason: "validation_failed", validations };

  const saved = await savePlan(projectId, expectedRevision, next);
  if (!saved.ok) return { ok: false, reason: "stale_revision", currentRevision: saved.revision };
  return { ok: true, plan: { ...next, revision: saved.revision } };
}
