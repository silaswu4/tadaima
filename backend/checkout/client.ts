import type { Mandate, Order, PaymentMethod } from "@/backend/contracts";
import type { CheckoutView } from "@/backend/checkout/types";

export class CheckoutRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CheckoutRequestError";
  }
}

/** Same-origin, cookie-authorized checkout; mutations are always explicit calls. */
export function checkoutClient(projectId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/checkout`;
  async function request<T>(method: "GET" | "POST", suffix = "", body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${base}${suffix}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new CheckoutRequestError(typeof data?.error === "string" ? data.error : "checkout request failed", response.status);
    if (!data || typeof data !== "object") throw new CheckoutRequestError("the checkout server returned an unreadable response", response.status);
    return data as T;
  }
  return {
    get: (signal?: AbortSignal) => request<CheckoutView>("GET", "", undefined, signal),
    recheck: (signal?: AbortSignal) => request<CheckoutView>("POST", "/recheck", undefined, signal),
    connectTestCard: (signal?: AbortSignal) => request<PaymentMethod>("POST", "/card/test", undefined, signal),
    approve: (cartDigest: string, paymentMethodId: string, signal?: AbortSignal) =>
      request<Mandate>("POST", "/approve", { cartDigest, paymentMethodId }, signal),
    revoke: (signal?: AbortSignal) => request<CheckoutView>("POST", "/revoke", undefined, signal),
    execute: (signal?: AbortSignal) => request<Order>("POST", "/execute", undefined, signal),
  };
}
