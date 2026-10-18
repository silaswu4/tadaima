import "server-only";

import { Redis } from "@upstash/redis";
import type { Job, PlanProposal, RoomPlan } from "@/backend/contracts";
import { demoPlan } from "@/backend/fixtures/demo-room";

/**
 * Canonical plan storage. One JSON document per project in Upstash Redis
 * (provisioned through Vercel; reads KV_REST_API_URL / KV_REST_API_TOKEN).
 *
 * Without those env vars, local dev falls back to process memory so the app
 * still runs before the database is linked. Production refuses to.
 */

const PROPOSAL_TTL_S = 60 * 60;

interface Backend {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlS?: number): Promise<void>;
  setIfAbsent(key: string, value: unknown, ttlS?: number): Promise<boolean>;
  compareAndSet(key: string, expected: unknown, next: unknown): Promise<boolean>;
  /** Write `next` only if the stored plan's revision is still `expected`. Returns the stored revision. */
  casPlan(key: string, expected: number, next: RoomPlan): Promise<{ ok: boolean; revision: number }>;
}

// compare-and-set in one round trip so two devices can't both apply against the same revision
const CAS = `
local cur = redis.call("GET", KEYS[1])
if not cur then return {0, -1} end
local rev = cjson.decode(cur).revision
if rev ~= tonumber(ARGV[1]) then return {0, rev} end
redis.call("SET", KEYS[1], ARGV[2])
return {1, rev + 1}
`;

function redisBackend(redis: Redis): Backend {
  return {
    get: (key) => redis.get(key),
    async set(key, value, ttlS) {
      if (ttlS) await redis.set(key, value, { ex: ttlS });
      else await redis.set(key, value);
    },
    async setIfAbsent(key, value, ttlS) {
      return (ttlS ? await redis.set(key, value, { nx: true, ex: ttlS }) : await redis.set(key, value, { nx: true })) === "OK";
    },
    async compareAndSet(key, expected, next) {
      const script = `local cur = redis.call("GET", KEYS[1]); if (not cur and ARGV[1] == "null") or cur == ARGV[1] then redis.call("SET", KEYS[1], ARGV[2]); return 1 end; return 0`;
      return (await redis.eval(script, [key], [JSON.stringify(expected), JSON.stringify(next)])) === 1;
    },
    async casPlan(key, expected, next) {
      const [ok, revision] = await redis.eval<[string, string], [number, number]>(CAS, [key], [String(expected), JSON.stringify(next)]);
      return { ok: ok === 1, revision };
    },
  };
}

function memoryBackend(): Backend {
  const g = globalThis as unknown as { __tadaimaStore?: Map<string, unknown>; __tadaimaStoreExpiry?: Map<string, number> };
  const mem = (g.__tadaimaStore ??= new Map());
  const expiry = (g.__tadaimaStoreExpiry ??= new Map());
  const expire = (key: string) => { if ((expiry.get(key) ?? Infinity) <= Date.now()) { mem.delete(key); expiry.delete(key); } };
  const put = (key: string, value: unknown, ttlS?: number) => { mem.set(key, structuredClone(value)); if (ttlS) expiry.set(key, Date.now() + ttlS * 1000); else expiry.delete(key); };
  return {
    async get<T>(key: string) {
      expire(key);
      return (structuredClone(mem.get(key)) as T) ?? null;
    },
    async set(key, value, ttlS) { put(key, value, ttlS); },
    async setIfAbsent(key, value, ttlS) {
      expire(key);
      if (mem.has(key)) return false;
      put(key, value, ttlS);
      return true;
    },
    async compareAndSet(key, expected, next) {
      expire(key);
      if (JSON.stringify(mem.get(key) ?? null) !== JSON.stringify(expected)) return false;
      put(key, next);
      return true;
    },
    async casPlan(key, expected, next) {
      const cur = mem.get(key) as RoomPlan | undefined;
      if (!cur) return { ok: false, revision: -1 };
      if (cur.revision !== expected) return { ok: false, revision: cur.revision };
      mem.set(key, structuredClone(next));
      return { ok: true, revision: next.revision };
    },
  };
}

let backend: Backend | null = null;
function db(): Backend {
  if (backend) return backend;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (url && token) {
    backend = redisBackend(new Redis({ url, token }));
  } else if (process.env.NODE_ENV === "production") {
    throw new Error("KV_REST_API_URL / KV_REST_API_TOKEN are not set");
  } else {
    console.warn("[plan store] no Upstash env vars, using in-memory store (dev only)");
    backend = memoryBackend();
  }
  return backend;
}

const planKey = (projectId: string) => `plan:${projectId}`;
const proposalKey = (projectId: string, id: string) => `proposal:${projectId}:${id}`;

/** Fixture-backed projects seed themselves on first read. */
const SEEDS: Record<string, RoomPlan> = { proj_demo: demoPlan, proj_dev: { ...demoPlan, projectId: "proj_dev" } };
/**
 * `proj_demo_<suffix>` (one per ASI:One chat) and `proj_test_<suffix>` (end-to-end
 * tests) each get their own copy of the demo room on first read.
 */
const seedFor = (projectId: string): RoomPlan | null =>
  SEEDS[projectId] ?? (/^proj_(demo|test)_[a-z0-9]{6,40}$/.test(projectId) ? { ...demoPlan, projectId } : null);

export const persistenceMode = () => process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN ? "redis" as const : "memory" as const;

/** Registration never overwrites an existing canonical plan. */
export async function createPlan(plan: RoomPlan): Promise<boolean> {
  return db().setIfAbsent(planKey(plan.projectId), plan);
}

export async function getPlan(projectId: string): Promise<RoomPlan | null> {
  const plan = await db().get<RoomPlan>(planKey(projectId));
  if (plan) return plan;
  const seed = seedFor(projectId);
  if (!seed) return null;
  await db().setIfAbsent(planKey(projectId), seed);
  return db().get<RoomPlan>(planKey(projectId));
}

export async function resetPlan(projectId: string): Promise<RoomPlan | null> {
  const seed = seedFor(projectId);
  if (!seed) return null;
  await db().set(planKey(projectId), seed);
  return structuredClone(seed);
}

/** Saves `next` as revision expected + 1, unless someone else saved first. */
export async function savePlan(projectId: string, expectedRevision: number, next: RoomPlan) {
  return db().casPlan(planKey(projectId), expectedRevision, { ...next, revision: expectedRevision + 1 });
}

export async function saveProposal(p: PlanProposal) {
  await db().set(proposalKey(p.projectId, p.id), p, PROPOSAL_TTL_S);
}

/** Small per-project records (checkout state). Keys are namespaced by project. */
/** Account records (users, sender links, room inventory). */
export const accountKv = {
  get: <T>(key: string) => db().get<T>(`acct:${key}`),
  set: (key: string, value: unknown) => db().set(`acct:${key}`, value),
};

export const projectKv = {
  get: <T>(projectId: string, name: string) => db().get<T>(`kv:${projectId}:${name}`),
  compareAndSet: <T>(projectId: string, name: string, expected: T | null, next: T) => db().compareAndSet(`kv:${projectId}:${name}`, expected, next),
  claim: (projectId: string, name: string, value: unknown, ttlS?: number) => db().setIfAbsent(`kv:${projectId}:${name}`, value, ttlS),
  setIfAbsent: (projectId: string, name: string, value: unknown) => db().setIfAbsent(`kv:${projectId}:${name}`, value),
  set: (projectId: string, name: string, value: unknown, ttlS?: number) => db().set(`kv:${projectId}:${name}`, value, ttlS),
};

const jobKey = (projectId: string, id: string) => `job:${projectId}:${id}`;
const JOB_TTL_S = 24 * 60 * 60;

export async function saveJob(job: Job) {
  await db().set(jobKey(job.projectId, job.id), job, JOB_TTL_S);
}

export async function getJob<Output = unknown>(projectId: string, id: string) {
  return db().get<Job<Output>>(jobKey(projectId, id));
}

export async function getProposal(projectId: string, id: string) {
  return db().get<PlanProposal>(proposalKey(projectId, id));
}
