import "server-only";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ApplyResult, RoomPlan } from "@/backend/contracts";
import { demoPlan, realCatalog } from "@/backend/fixtures/demo-room";
import { createPlan, getPlan, persistenceMode, projectKv, savePlan } from "@/backend/plan/store";
import { InvalidRoomSync, normalizeRegisteredPlan, reconcileRoomSnapshot } from "./sync";

export const ROOM_SESSION_COOKIE = "tadaima_room_session";
const COOKIE_SECONDS = 60 * 60 * 24 * 30;
export class RoomSessionError extends Error { constructor(message: string, readonly status = 403) { super(message); } }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const ownerId = (token: string) => `room_owner_${digest(token)}`;
export function readRoomSession(req: Request): string | null {
  const raw = req.headers.get("cookie")?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(`${ROOM_SESSION_COOKIE}=`))?.slice(ROOM_SESSION_COOKIE.length + 1);
  return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}
export function assertSameOrigin(req: Request, required = true) {
  const origin = req.headers.get("origin");
  const url = new URL(req.url);
  // Next development normalizes request.url to localhost even when the browser
  // opened 127.0.0.1. The incoming Host is the browser's same-origin authority.
  const authority = req.headers.get("host") ?? url.host;
  let matches = false;
  try { const parsed = new URL(origin ?? ""); matches = parsed.host === authority && parsed.protocol === url.protocol && parsed.origin === origin; } catch { /* absent/malformed Origin is refused */ }
  if ((!origin && required) || (origin && !matches) || req.headers.get("sec-fetch-site") === "cross-site") throw new RoomSessionError("room requests must come from this website");
}
export async function authorizeRoomProject(req: Request, projectId: string) {
  if (!projectId.startsWith("proj_room_")) return;
  if (!/^proj_room_[a-f0-9]{32}$/.test(projectId)) throw new RoomSessionError("no room session", 404);
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) assertSameOrigin(req);
  const token = readRoomSession(req);
  const expectedOwner = token && ownerId(token);
  const owner = await projectKv.get<string>(projectId, "room-owner");
  if (!expectedOwner || !owner || expectedOwner.length !== owner.length || !timingSafeEqual(Buffer.from(expectedOwner), Buffer.from(owner))) throw new RoomSessionError("no room session", 404);
}
export function sessionCapabilities() {
  const stripe = process.env.STRIPE_SECRET_KEY ?? "";
  const liveSearch = Boolean(process.env.BROWSER_USE_API_KEY);
  return { liveSearch, testPayments: /^(sk|rk)_test_/.test(stripe), persistence: persistenceMode(), ...(!liveSearch ? { liveSearchReason: "live retailer search is not configured; saved catalog search is available" } : {}) };
}
export async function registerRoomSession(req: Request, roomId: string, input: RoomPlan) {
  assertSameOrigin(req);
  const existingToken = readRoomSession(req);
  const token = existingToken ?? randomBytes(32).toString("hex");
  const owner = ownerId(token);
  const mappingKey = `room:${digest(roomId)}`;
  let projectId = await projectKv.get<string>(owner, mappingKey);
  const resumed = Boolean(projectId);
  if (!projectId) {
    const proposedId = `proj_room_${randomUUID().replaceAll("-", "")}`;
    await projectKv.setIfAbsent(owner, mappingKey, proposedId);
    projectId = (await projectKv.get<string>(owner, mappingKey))!;
  }
  await projectKv.setIfAbsent(projectId, "room-owner", owner);
  let plan = await getPlan(projectId);
  if (!plan) {
    const initial = normalizeRegisteredPlan(input, projectId, realCatalog, demoPlan.evidence.filter((entry) => realCatalog.some((product) => product.evidenceIds.includes(entry.id))));
    await createPlan(initial);
    plan = await getPlan(projectId);
  }
  if (!plan) throw new Error("room session registration failed");
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return { payload: { plan, resumed, capabilities: sessionCapabilities() }, cookie: `${ROOM_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_SECONDS}${secure}` };
}
export async function syncRoomSession(req: Request, projectId: string, expectedRevision: number, snapshot: RoomPlan): Promise<ApplyResult> {
  if (!projectId.startsWith("proj_room_")) throw new RoomSessionError("no room session", 404);
  await authorizeRoomProject(req, projectId);
  const current = await getPlan(projectId);
  if (!current) throw new RoomSessionError("no room session", 404);
  if (current.revision !== expectedRevision) return { ok: false, reason: "stale_revision", currentRevision: current.revision };
  const reconciled = reconcileRoomSnapshot(current, snapshot);
  if (reconciled.blocked) return { ok: false, reason: "validation_failed", validations: reconciled.validations };
  const saved = await savePlan(projectId, expectedRevision, reconciled.plan);
  return saved.ok ? { ok: true, plan: { ...reconciled.plan, revision: saved.revision } } : { ok: false, reason: "stale_revision", currentRevision: saved.revision };
}
export { InvalidRoomSync };
