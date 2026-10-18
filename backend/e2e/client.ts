/**
 * Tiny HTTP client for end-to-end tests against a running server.
 *   E2E_BASE      default http://localhost:3009
 *   E2E_BYPASS    Vercel protection bypass secret, for protected deploys
 */
import type { ApplyResult, Cart, FloorSpot, Job, Mandate, Order, PaymentMethod, PlaceResult, PlanChange, PlanProposal, Recheck, ResearchJobOutput, RoomPlan, ShopJobOutput, ShopRequest, ValidationResult } from "@/backend/contracts";

import type { ShoppingBrief } from "@/backend/shopping/roomBrief";

export type CheckoutView = { cart: Cart; recheck: Recheck | null; paymentMethods: PaymentMethod[]; mandate: Mandate | null; orders: Order[]; blockers: string[] };

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
    checkout: () => call<CheckoutView>("GET", `${p}/checkout`),
    recheck: () => call<CheckoutView>("POST", `${p}/checkout/recheck`),
    testCard: () => call<PaymentMethod & { error?: string }>("POST", `${p}/checkout/card/test`),
    approve: (cartDigest: string, paymentMethodId: string) => call<Mandate & { error?: string }>("POST", `${p}/checkout/approve`, { cartDigest, paymentMethodId }),
    execute: () => call<Order & { error?: string; refused?: boolean }>("POST", `${p}/checkout/execute`),
    shop: (req: ShopRequest | Record<string, unknown>) => call<Job<ShopJobOutput>>("POST", `${p}/shop`, req),
    shopJob: (jobId: string) => call<Job<ShopJobOutput>>("GET", `${p}/shop/${jobId}`),
    place: (productId: string, spot: FloorSpot, expectedRevision?: number, jobId?: string) => call<PlaceResult>("POST", `${p}/place`, { productId, spot, expectedRevision, jobId }),
    moveTo: (itemId: string, spot: FloorSpot, unlock?: boolean) => call<PlaceResult>("POST", `${p}/items/${itemId}/move-to`, { spot, unlock }),
  };
};

export const failing = (v: ValidationResult[]) => v.filter((x) => x.status === "fail");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
