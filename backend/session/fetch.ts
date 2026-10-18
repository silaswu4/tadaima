import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RoomPlan } from "../contracts";
import { cartOf } from "../checkout/cart";
import { getPlan, getProposal, projectKv } from "../plan/store";
import { getShopJob } from "../shopping/shop";
import { authorizeRoomProject, RoomSessionError } from "./service";
import type { FetchPreview, FetchRoomStatus } from "./fetch-types";

const CODE_SECONDS = 10 * 60, SESSION_SECONDS = 60 * 60;
const namespace = "fetch-pairings";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Binding = { id: string; expiresAt: number; sender: string | null; tokenHash: string | null; proposalId?: string; jobId?: string; preview?: FetchPreview };
type Locator = { projectId: string; id: string };
export type FetchAccess = Locator & { tokenHash: string };
const empty: FetchRoomStatus = { status: "disconnected", expiresAt: null, sender: null, proposal: null, job: null, preview: null };
const read = (projectId: string) => projectKv.get<Binding>(projectId, "fetch-binding");
const active = (binding: Binding | null): binding is Binding => !!binding && binding.expiresAt > Date.now();

/** The browser owner initiates/revokes pairing; an agent bearer can never do so. */
export async function createFetchPairing(req: Request, projectId: string) {
  await authorizeRoomProject(req, projectId);
  if (!projectId.startsWith("proj_room_")) throw new RoomSessionError("connect a saved room first", 400);
  const code = randomBytes(16).toString("hex"), id = randomUUID();
  const binding: Binding = { id, expiresAt: Date.now() + CODE_SECONDS * 1000, sender: null, tokenHash: null };
  // Changing the active id revokes all previous codes and credentials, even if redeem races it.
  await projectKv.set(projectId, "fetch-binding", binding, SESSION_SECONDS);
  await projectKv.set(namespace, `code:${hash(code)}`, { projectId, id }, CODE_SECONDS);
  return { ...empty, status: "waiting" as const, expiresAt: binding.expiresAt, code };
}
export async function revokeFetchPairing(req: Request, projectId: string) {
  await authorizeRoomProject(req, projectId);
  await projectKv.set(projectId, "fetch-binding", { id: randomUUID(), expiresAt: 0, sender: null, tokenHash: null }, SESSION_SECONDS);
  return empty;
}
export async function redeemFetchPairing(code: string, sender: string) {
  const locator = await projectKv.get<Locator>(namespace, `code:${hash(code)}`);
  if (!locator) throw new RoomSessionError("pairing code expired or already used", 404);
  const binding = await read(locator.projectId);
  if (!active(binding) || binding.id !== locator.id || binding.tokenHash) throw new RoomSessionError("pairing code expired or already used", 404);
  const token = `tadaima_fetch_${randomBytes(32).toString("hex")}`;
  const connected: Binding = { ...binding, sender, tokenHash: hash(token), expiresAt: Date.now() + SESSION_SECONDS * 1000 };
  if (!await projectKv.compareAndSet(locator.projectId, "fetch-binding", binding, connected)) throw new RoomSessionError("pairing code expired or already used", 404);
  await projectKv.set(namespace, `token:${connected.tokenHash}`, locator, SESSION_SECONDS);
  return { projectId: locator.projectId, token, expiresAt: connected.expiresAt };
}

export async function requireFetchAccess(req: Request): Promise<FetchAccess> {
  const token = req.headers.get("authorization")?.match(/^Bearer (tadaima_fetch_[a-f0-9]{64})$/)?.[1];
  if (!token) throw new RoomSessionError("Fetch pairing required", 401);
  const tokenHash = hash(token);
  const locator = await projectKv.get<Locator>(namespace, `token:${tokenHash}`);
  const binding = locator && await read(locator.projectId);
  if (!locator || !active(binding) || binding.id !== locator.id || binding.tokenHash !== tokenHash) throw new RoomSessionError("Fetch pairing expired or disconnected; reconnect from the room", 401);
  return { ...locator, tokenHash };
}

/** Narrow allowlist. A Fetch token never approves an edit, unlocks an item or pays. */
export async function authorizeFetchProject(req: Request, projectId: string): Promise<FetchAccess | null> {
  if (!req.headers.has("authorization")) return null;
  const access = await requireFetchAccess(req);
  if (access.projectId !== projectId) throw new RoomSessionError("no room session", 404);
  const prefix = `/api/projects/${projectId}`;
  const path = new URL(req.url).pathname;
  const suffix = path.startsWith(prefix) ? path.slice(prefix.length) : "!";
  const allowed = req.method === "GET" ? /^(|\/brief|\/shop\/[^/]+|\/jobs\/[^/]+)$/.test(suffix)
    : req.method === "POST" && ["/shop", "/research", "/proposals"].includes(suffix);
  if (!allowed) throw new RoomSessionError("review and confirm this action on the room website", 403);
  return access;
}

async function update(access: FetchAccess, patch: Partial<Binding>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const binding = await read(access.projectId);
    if (!active(binding) || binding.id !== access.id || binding.tokenHash !== access.tokenHash) return;
    if (await projectKv.compareAndSet(access.projectId, "fetch-binding", binding, { ...binding, ...patch })) return;
  }
  throw new RoomSessionError("room activity changed; retry this request", 409);
}

/** Keep references, not provider copies, so the website reads canonical results. */
export async function recordFetchResult(req: Request, access: FetchAccess, result: unknown) {
  if (req.method !== "POST" || !result || typeof result !== "object") return;
  const value = result as { id?: string; type?: string; baseRevision?: number };
  if (!value.id) return;
  if (value.baseRevision != null) await update(access, { proposalId: value.id });
  else if (value.type === "shop_at_spot") await update(access, { jobId: value.id });
}

export async function fetchPairingStatus(req: Request, projectId: string): Promise<FetchRoomStatus> {
  await authorizeRoomProject(req, projectId);
  const binding = await read(projectId);
  if (!active(binding)) return empty;
  const proposal = binding.proposalId ? await getProposal(projectId, binding.proposalId) : null;
  const job = binding.jobId ? await getShopJob(projectId, binding.jobId).catch(() => null) : null;
  return { status: binding.tokenHash ? "connected" : "waiting", sender: binding.sender, expiresAt: binding.expiresAt, proposal, job, preview: binding.preview ?? null };
}
export async function fetchCart(req: Request) {
  const access = await requireFetchAccess(req), plan = await getPlan(access.projectId);
  if (!plan) throw new RoomSessionError("no room session", 404);
  return { cart: cartOf(plan) };
}
export async function requestFetchPreview(req: Request, input: { productId: string; jobId: string }) {
  const access = await requireFetchAccess(req);
  const job = await getShopJob(access.projectId, input.jobId);
  const result = job.output?.results.find((entry) => entry.product.id === input.productId);
  if (!result?.fits || !result.placement || !job.output) throw new RoomSessionError("search for a fitting product in this room first", 422);
  const preview: FetchPreview = { id: randomUUID(), productId: input.productId, jobId: job.id, spot: job.output.request.spot, revision: job.output.checkedAtRevision };
  await update(access, { jobId: job.id, preview });
  return { reviewRequired: true, message: "Preview requested. Confirm placement on the room website.", ...preview };
}

/** External agents get physical context and public products, never private scan media. */
export function redactFetchMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFetchMedia);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (object.schemaVersion === "0.2" && object.geometry && object.items) {
    const plan = object as unknown as RoomPlan;
    return { ...plan, appearance: undefined, evidence: [], items: plan.items.map((item) => ({ ...item, assetUrl: null, evidenceIds: [] })) };
  }
  return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, redactFetchMedia(entry)]));
}
