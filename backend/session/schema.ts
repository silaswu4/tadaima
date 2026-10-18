import { z } from "zod";
import type { RoomPlan } from "@/backend/contracts";

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const text = z.string().max(1000);
const finite = z.number().finite().min(-10000).max(10000);
const size = z.number().finite().positive().max(1000);
const xz = z.tuple([finite, finite]);
const vector = z.tuple([finite, finite, finite]);
const dimensions = z.tuple([size, size, size]);
const ids = z.array(id).max(4096);
const money = z.object({ amountMinor: z.number().int().min(0).max(1000000000), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
const category = z.enum(["sofa", "chair", "table", "desk", "storage", "bed", "rug", "lamp", "decor", "other"]);
const url = z.string().max(4000).refine((value) => { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } }, "expected an HTTP URL");
const evidence = z.object({ id, sourceUrl: url.nullable(), privateAssetId: text.nullable(), observedAt: text, claim: z.string().max(8000), dimensionStatus: z.enum(["measured", "source_dimension", "inferred"]).nullable(), confirmedByUserAt: text.nullable() }).strict();
const product = z.object({ id, category, merchant: text, sourceUrl: url, variantId: text.nullable(), label: text, dimensions: dimensions.nullable(), seats: z.number().int().min(0).max(100).nullable(), price: money.nullable(), availability: z.enum(["available", "unavailable", "unknown"]), imageUrl: url.nullable(), observedAt: text, evidenceIds: ids, fixture: z.boolean() }).strict();
const item = z.object({ id, roomId: id, label: text, category, origin: z.enum(["existing_owned", "proposed_purchase"]), productId: id.nullable(), assetUrl: z.string().max(1000).regex(/^\/models\/[A-Za-z0-9_./%-]+$/).refine((value) => !value.includes("..") && !/%(?:2e|2f|5c)/i.test(value), "model path cannot escape its folder").nullable(), position: vector, rotationY: finite, dimensions: dimensions.nullable(), seats: z.number().int().min(0).max(100).nullable(), locked: z.boolean(), stored: z.boolean().optional(), evidenceIds: ids.optional(), collision: z.array(z.tuple([finite, finite, finite, size, size, size])).max(64).nullable().optional() }).strict();

/** The HTTP boundary accepts metric plan data only, never raw photos or model payloads. */
export const RoomPlanSchema: z.ZodType<RoomPlan> = z.object({
  schemaVersion: z.literal("0.2"), projectId: id, revision: z.number().int().min(0).max(1000000000),
  geometry: z.object({ units: z.literal("m"), coordinateSystem: z.literal("right-handed-y-up"),
    rooms: z.array(z.object({ id, label: text, floorPolygon: z.array(xz).min(3).max(256), height: size, evidenceIds: ids }).strict()).min(1).max(64),
    walls: z.array(z.object({ id, start: xz, end: xz, height: size, thickness: size, evidenceIds: ids }).strict()).max(512),
    openings: z.array(z.object({ id, wallId: id, kind: z.enum(["door", "window"]), offset: z.number().finite().min(0).max(10000), width: size, height: size, sillHeight: z.number().finite().min(0).max(1000), evidenceIds: ids }).strict()).max(512),
  }).strict(),
  appearance: z.object({ schemaVersion: z.literal("room-appearance/1.0"), reviewRequired: z.literal(true), scope: z.enum(["captured_room", "exact_unit", "building_reference", "unknown"]), sources: z.array(z.object({ evidenceId: id, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(4096), surfaces: z.array(z.object({ entityId: id, finish: z.enum(["wood", "paint", "tile", "carpet"]), color: z.string().regex(/^#[a-fA-F0-9]{6}$/), roughness: z.number().min(0).max(1), tileMeters: size, rotationDegrees: finite, confidence: z.enum(["low", "medium", "high"]), evidenceIds: ids }).strict()).max(1024), notes: z.array(text).max(512) }).strict().optional(),
  evidence: z.array(evidence).max(4096), items: z.array(item).max(512), products: z.array(product).max(1024),
  constraints: z.object({ budget: money.nullable(), minimumSeats: z.number().int().min(0).max(1000).nullable(), clearance: z.number().finite().min(0).max(5) }).strict(),
}).strict().superRefine((plan, ctx) => {
  const unique = (values: { id: string }[], name: string) => { if (new Set(values.map((entry) => entry.id)).size !== values.length) ctx.addIssue({ code: "custom", message: `duplicate ${name} ids` }); };
  for (const [name, entries] of Object.entries({ rooms: plan.geometry.rooms, walls: plan.geometry.walls, openings: plan.geometry.openings, items: plan.items, products: plan.products, evidence: plan.evidence })) unique(entries, name);
  const rooms = new Map(plan.geometry.rooms.map((room) => [room.id, room]));
  for (const entry of plan.items) if (!rooms.has(entry.roomId) || entry.position[1] < -0.001 || entry.position[1] > rooms.get(entry.roomId)!.height) ctx.addIssue({ code: "custom", message: "item must belong to a room and have a valid height" });
  const walls = new Map(plan.geometry.walls.map((wall) => [wall.id, wall]));
  for (const opening of plan.geometry.openings) {
    const wall = walls.get(opening.wallId);
    if (!wall || opening.offset + opening.width > Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]) + 0.01 || opening.sillHeight + opening.height > wall.height + 0.01) ctx.addIssue({ code: "custom", message: "opening exceeds its wall" });
  }
  for (const room of plan.geometry.rooms) {
    const polygon = room.floorPolygon;
    let twiceArea = 0;
    for (let index = 0; index < polygon.length; index++) { const next = polygon[(index + 1) % polygon.length]; twiceArea += polygon[index][0] * next[1] - next[0] * polygon[index][1]; }
    if (Math.abs(twiceArea) < 0.5) ctx.addIssue({ code: "custom", message: "room needs a nonzero floor area" });
    const cross = (a: readonly number[], b: readonly number[], c: readonly number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    let intersects = false;
    for (let a = 0; a < polygon.length; a++) for (let b = a + 2; b < polygon.length; b++) {
      if (a === 0 && b === polygon.length - 1) continue;
      const p = polygon[a], q = polygon[(a + 1) % polygon.length], r = polygon[b], s = polygon[(b + 1) % polygon.length];
      if (cross(p, q, r) * cross(p, q, s) < 0 && cross(r, s, p) * cross(r, s, q) < 0) intersects = true;
    }
    if (intersects) ctx.addIssue({ code: "custom", message: "room outline cannot cross itself" });
  }
});

export const RegisterRoomSchema = z.object({ roomId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/), plan: RoomPlanSchema }).strict();
export const SyncRoomSchema = z.object({ expectedRevision: z.number().int().min(0), plan: RoomPlanSchema }).strict();
