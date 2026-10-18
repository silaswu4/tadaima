import "server-only";

import { z } from "zod";
import { NotFound } from "@/backend/plan/operations";

/** Shared error mapping so every route answers the same way. */
export async function handle(fn: () => Promise<unknown>) {
  try {
    return Response.json(await fn());
  } catch (e) {
    if (e instanceof NotFound) return Response.json({ error: e.message }, { status: 404 });
    if (e instanceof z.ZodError) return Response.json({ error: "bad request", issues: e.issues }, { status: 400 });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const money = z.object({ amountMinor: z.number().int(), currency: z.string().length(3) });

export const PlanChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove"), itemId: z.string() }),
  z.object({ kind: z.literal("replace"), itemId: z.string(), productId: z.string() }),
  z.object({ kind: z.literal("move"), itemId: z.string(), position: vec3, rotationY: z.number() }),
  z.object({ kind: z.literal("lock"), itemId: z.string(), locked: z.boolean() }),
  z.object({
    kind: z.literal("set_constraints"),
    constraints: z.object({ budget: money.nullable(), minimumSeats: z.number().int().nullable(), clearance: z.number().min(0) }).partial(),
  }),
]);
