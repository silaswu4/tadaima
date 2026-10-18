import "server-only";

import { Redis } from "@upstash/redis";
import type { PlanProposal, RoomPlan } from "@/backend/contracts";
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
    async casPlan(key, expected, next) {
      const [ok, revision] = await redis.eval<[string, string], [number, number]>(CAS, [key], [String(expected), JSON.stringify(next)]);
      return { ok: ok === 1, revision };
    },
  };
}

function memoryBackend(): Backend {
  const g = globalThis as unknown as { __tadaimaStore?: Map<string, unknown> };
  const mem = (g.__tadaimaStore ??= new Map());
  return {
    async get<T>(key: string) {
      return (structuredClone(mem.get(key)) as T) ?? null;
    },
    async set(key, value) {
      mem.set(key, structuredClone(value));
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
const SEEDS: Record<string, RoomPlan> = { proj_demo: demoPlan };

export async function getPlan(projectId: string): Promise<RoomPlan | null> {
  const plan = await db().get<RoomPlan>(planKey(projectId));
  if (plan) return plan;
  const seed = SEEDS[projectId];
  if (!seed) return null;
  await db().set(planKey(projectId), seed);
  return structuredClone(seed);
}

export async function resetPlan(projectId: string): Promise<RoomPlan | null> {
  const seed = SEEDS[projectId];
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

export async function getProposal(projectId: string, id: string) {
  return db().get<PlanProposal>(proposalKey(projectId, id));
}
