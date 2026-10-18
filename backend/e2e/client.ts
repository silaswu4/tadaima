/**
 * Tiny HTTP client for end-to-end tests against a running server.
 *   E2E_BASE      default http://localhost:3009
 *   E2E_BYPASS    Vercel protection bypass secret, for protected deploys
 */
import type { ApplyResult, Job, PlanChange, PlanProposal, ResearchJobOutput, RoomPlan, ValidationResult } from "@/backend/contracts";
import type { ShoppingBrief } from "@/backend/shopping/roomBrief";

export const BASE = (process.env.E2E_BASE ?? "http://localhost:3009").replace(/\/$/, "");
const headers: Record<string, string> = { "content-type": "application/json" };
if (process.env.E2E_BYPASS) headers["x-vercel-protection-bypass"] = process.env.E2E_BYPASS;

export const newProjectId = () => `proj_test_${Math.random().toString(36).slice(2, 12)}`;

export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json: json as T };
}

export type ProjectView = { plan: RoomPlan; cost: { knownSubtotal: { amountMinor: number } }; validations: ValidationResult[] };

export const api = (projectId: string) => {
  const p = `/api/projects/${projectId}`;
  return {
    reset: () => call<RoomPlan>("POST", `${p}/reset`),
    get: () => call<ProjectView>("GET", p),
    brief: (itemId: string) => call<ShoppingBrief>("GET", `${p}/brief?itemId=${encodeURIComponent(itemId)}`),
    change: (expectedRevision: number, changes: PlanChange[] | unknown) => call<ApplyResult>("POST", `${p}/changes`, { expectedRevision, changes }),
    propose: (intent: string, selectedItemId: string | null = null) => call<PlanProposal>("POST", `${p}/proposals`, { intent, selectedItemId }),
    apply: (proposalId: string, expectedRevision: number) => call<ApplyResult>("POST", `${p}/proposals/${proposalId}/apply`, { expectedRevision }),
    research: (itemId: string, request?: string) => call<Job<ResearchJobOutput>>("POST", `${p}/research`, { itemId, request }),
    job: (jobId: string) => call<Job<ResearchJobOutput>>("GET", `${p}/jobs/${jobId}`),
  };
};

export const failing = (v: ValidationResult[]) => v.filter((x) => x.status === "fail");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
