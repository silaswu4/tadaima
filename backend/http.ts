import "server-only";

import { z } from "zod";
import { CheckoutRefused } from "@/backend/checkout/service";
import { PaymentsUnavailable } from "@/backend/payments/stripe";
import { NotFound, Unprocessable } from "@/backend/plan/operations";

/** Shared error mapping so every route answers the same way. */
export async function handle(fn: () => Promise<unknown>) {
  try {
    return Response.json(await fn());
  } catch (e) {
    if (e instanceof NotFound) return Response.json({ error: e.message }, { status: 404 });
    if (e instanceof Unprocessable) return Response.json({ error: e.message }, { status: 422 });
    if (e instanceof CheckoutRefused) return Response.json({ error: e.message, refused: true }, { status: 409 });
    if (e instanceof PaymentsUnavailable) return Response.json({ error: e.message }, { status: 503 });
    if (e instanceof z.ZodError) return Response.json({ error: "bad request", issues: e.issues }, { status: 400 });
    console.error(e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const money = z.object({ amountMinor: z.number().int(), currency: z.string().length(3) });

const finite = z.number().finite();
export const FloorSpotSchema = z.object({
  position: z.tuple([finite, finite, finite]),
  rotationY: finite.nullable().optional(),
  roomId: z.string().max(80).nullable().optional(),
});

export const PlanChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove"), itemId: z.string() }),
  z.object({ kind: z.literal("replace"), itemId: z.string(), productId: z.string() }),
  z.object({ kind: z.literal("move"), itemId: z.string(), position: vec3, rotationY: z.number() }),
  z.object({ kind: z.literal("lock"), itemId: z.string(), locked: z.boolean() }),
  z.object({ kind: z.literal("store"), itemId: z.string() }),
  z.object({ kind: z.literal("take_out"), itemId: z.string(), position: vec3, rotationY: z.number() }),
  z.object({
    kind: z.literal("set_constraints"),
    constraints: z.object({ budget: money.nullable(), minimumSeats: z.number().int().nullable(), clearance: z.number().min(0) }).partial(),
  }),
]);
