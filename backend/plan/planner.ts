import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { PlanChange, RoomPlan, ValidationResult } from "@/backend/contracts";
import { applyChanges, costOf, PlanChangeError, validate, passes } from "@/backend/plan/rules";

/**
 * Turns "make it $300 cheaper, keep the sofa, seat 4" into PlanChange[].
 * Claude proposes; rules.ts decides. If the proposal breaks a rule, Claude
 * gets the failures back and one more try.
 */

const MODEL = "claude-opus-5-5";
const MAX_ATTEMPTS = 3;

const client = new Anthropic();

// flat shape keeps structured output simple; converted to the PlanChange union below
const ChangeSchema = z.object({
  kind: z.enum(["replace", "remove", "move", "lock", "set_budget", "set_minimum_seats"]),
  itemId: z.string().nullable().describe("Target item id for replace/remove/move/lock"),
  productId: z.string().nullable().describe("Catalog product id for replace"),
  x: z.number().nullable().describe("New footprint center x in meters, for move"),
  z: z.number().nullable().describe("New footprint center z in meters, for move"),
  rotationY: z.number().nullable().describe("Radians about +Y, for move"),
  locked: z.boolean().nullable(),
  dollars: z.number().nullable().describe("New budget cap in dollars, for set_budget"),
  seats: z.number().nullable().describe("New minimum seats, for set_minimum_seats"),
});

const ProposalSchema = z.object({
  changes: z.array(ChangeSchema),
  summary: z.string().describe("One or two plain sentences for the shopper: what changed and why. No marketing tone."),
  feasible: z.boolean().describe("False if the request can't be met under the hard rules"),
});

type RawChange = z.infer<typeof ChangeSchema>;

function toChange(c: RawChange, plan: RoomPlan): PlanChange {
  const need = <T>(v: T | null, what: string): T => {
    if (v === null) throw new PlanChangeError(`${c.kind} needs ${what}`);
    return v;
  };
  switch (c.kind) {
    case "replace":
      return { kind: "replace", itemId: need(c.itemId, "itemId"), productId: need(c.productId, "productId") };
    case "remove":
      return { kind: "remove", itemId: need(c.itemId, "itemId") };
    case "move": {
      const item = plan.items.find((i) => i.id === c.itemId);
      return {
        kind: "move",
        itemId: need(c.itemId, "itemId"),
        position: [need(c.x, "x"), 0, need(c.z, "z")],
        rotationY: c.rotationY ?? item?.rotationY ?? 0,
      };
    }
    case "lock":
      return { kind: "lock", itemId: need(c.itemId, "itemId"), locked: need(c.locked, "locked") };
    case "set_budget":
      return {
        kind: "set_constraints",
        constraints: { budget: { amountMinor: Math.round(need(c.dollars, "dollars") * 100), currency: plan.constraints.budget?.currency ?? "USD" } },
      };
    case "set_minimum_seats":
      return { kind: "set_constraints", constraints: { minimumSeats: need(c.seats, "seats") } };
  }
}

const dollars = (minor: number | undefined) => (minor === undefined ? null : minor / 100);

/** Compact, model-friendly view of the plan. Ids are what the model must use. */
function describe(plan: RoomPlan) {
  const priceOf = (productId: string | null) => dollars(plan.products.find((p) => p.id === productId)?.price?.amountMinor);
  const cost = costOf(plan);
  return {
    rooms: plan.geometry.rooms.map((r) => ({ id: r.id, label: r.label, floorPolygon: r.floorPolygon, height: r.height })),
    openings: plan.geometry.openings.map((o) => ({ wallId: o.wallId, kind: o.kind, offset: o.offset, width: o.width })),
    walls: plan.geometry.walls.map((w) => ({ id: w.id, start: w.start, end: w.end })),
    items: plan.items.map((i) => ({
      id: i.id,
      label: i.label,
      category: i.category,
      owned: i.origin === "existing_owned",
      locked: i.locked,
      productId: i.productId,
      priceDollars: i.origin === "proposed_purchase" ? priceOf(i.productId) : 0,
      seats: i.seats,
      sizeWHD: i.dimensions,
      center: [i.position[0], i.position[2]],
      rotationY: Number(i.rotationY.toFixed(4)),
    })),
    catalog: plan.products.map((p) => ({
      id: p.id,
      label: p.label,
      category: p.category,
      priceDollars: dollars(p.price?.amountMinor),
      seats: p.seats,
      sizeWHD: p.dimensions,
      availability: p.availability,
    })),
    constraints: {
      budgetDollars: dollars(plan.constraints.budget?.amountMinor),
      minimumSeats: plan.constraints.minimumSeats,
      clearanceMeters: plan.constraints.clearance,
    },
    newPurchasesTotalDollars: dollars(cost.knownSubtotal.amountMinor),
  };
}

const SYSTEM = `You plan furniture changes for one room. You get the current plan as JSON and a shopper's request, and you return a list of changes.

Hard rules, checked by code after you answer:
- Locked items never change: no replace, remove, move, or unlock unless the shopper explicitly asks to unlock that item.
- Every item stays fully inside the room polygon, with at least clearanceMeters between any two non-rug items' footprints.
- Total seats (sum of item seats) stays at or above minimumSeats.
- New purchases (priceDollars of non-owned items) stay within budgetDollars.
- Only use catalog products whose availability is "available". Never use a product with unknown size (sizeWHD null) when fit matters.
- Use ids exactly as given. Replace swaps an item to a catalog product and keeps its position and rotation, so check the new size still fits there; add a move if it doesn't.

Geometry: x and z are meters on the floor, center is the footprint center, sizeWHD is [width, height, depth] before rotation, rotationY is radians about +Y (at pi/2 or -pi/2 width and depth swap on the floor).

Make the smallest set of changes that satisfies the request. Prefer swaps over removals. When the shopper says "cheaper by $N", the new purchases total must drop by at least N. If the request can't be met, return no changes, feasible false, and say in the summary which rule blocks it and what would unblock it.`;

export interface PlannerResult {
  changes: PlanChange[];
  result: RoomPlan;
  validations: ValidationResult[];
  summary: string;
  feasible: boolean;
  attempts: number;
}

export async function planChanges(plan: RoomPlan, intent: string, selectedItemId: string | null): Promise<PlannerResult> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Current plan:\n${JSON.stringify(describe(plan))}\n\n${
        selectedItemId ? `The shopper has selected item "${selectedItemId}"; words like "this" or "that" refer to it.\n\n` : ""
      }Request: ${intent}`,
    },
  ];

  let last: PlannerResult | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: "medium", format: zodOutputFormat(ProposalSchema) },
      messages,
    });
    const u = response.usage;
    // opus 5.5: $4 / $20 per million tokens in / out
    console.log(`[planner] attempt ${attempt}: ${u.input_tokens} in, ${u.output_tokens} out, ~$${((u.input_tokens * 4 + u.output_tokens * 20) / 1e6).toFixed(3)}`);
    if (response.stop_reason === "refusal") throw new Error("planner declined the request");
    const out = response.parsed_output;
    if (!out) throw new Error(`planner returned no parseable output (stop_reason ${response.stop_reason})`);

    let changes: PlanChange[] = [];
    let result = plan;
    let problem: string | null = null;
    try {
      changes = out.changes.map((c) => toChange(c, plan));
      result = applyChanges(plan, changes);
    } catch (e) {
      if (!(e instanceof PlanChangeError)) throw e;
      problem = e.message;
    }
    const validations = validate(result, plan);
    last = { changes, result, validations, summary: out.summary, feasible: out.feasible, attempts: attempt };

    const failures = validations.filter((v) => v.status === "fail");
    if (!problem && (passes(validations) || (!out.feasible && changes.length === 0))) return last;

    // hand the failures back and let it fix its own answer
    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: `That proposal was rejected by the checker:\n${
        problem ? `- ${problem}\n` : ""
      }${failures.map((f) => `- ${f.rule}: ${f.message}`).join("\n")}\nReturn a corrected full list of changes against the original plan.`,
    });
  }
  return last!;
}
