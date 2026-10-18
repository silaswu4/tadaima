import type { CostSummary, Money, RoomPlan, ValidationResult } from "@/backend/contracts";

export interface ProjectView {
  plan: RoomPlan;
  cost: CostSummary;
  validations: ValidationResult[];
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

/** JSON call to our own API. Logging happens in the fetch wrapper the console installs. */
export async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, data: null, error: json?.error ?? `HTTP ${res.status}` };
    return { ok: true, status: res.status, data: json as T, error: null };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: (e as Error).message };
  }
}

export const money = (m: Money | null | undefined) =>
  m ? `$${(m.amountMinor / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : "n/a";

export const meters = (d: readonly number[] | null) => (d ? d.map((v) => v.toFixed(2)).join(" x ") + " m" : "size unknown");

export const seatsOf = (plan: RoomPlan) => plan.items.reduce((n, i) => n + (i.seats ?? 0), 0);

/** Item ids named by failing validations. */
export const failingIds = (vs: ValidationResult[]) => new Set(vs.filter((v) => v.status === "fail").flatMap((v) => v.itemIds));
