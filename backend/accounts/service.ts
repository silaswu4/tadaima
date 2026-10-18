import "server-only";

import type { Evidence, FurnitureCategory, PlacedItem, ProductCandidate, RoomPlan } from "@/backend/contracts";
import { applyPlanChanges, getProject } from "@/backend/plan/operations";
import { demoPlan, realCatalog } from "@/backend/fixtures/demo-room";
import { getTadaimaRooms } from "@/spatial/fixtures/roomsCatalog";
import { costOf, validate } from "@/backend/plan/rules";
import { accountKv, createPlan, getPlan, savePlan } from "@/backend/plan/store";

/**
 * Tadaima accounts as the ASI:One agent sees them. A user is created from chat
 * and bound to the ASI:One sender address that created it; every room they make
 * becomes a project they own. One sender maps to one user.
 */

export interface User {
  id: string;
  name: string;
  email: string;
  /** ASI:One sender address that created the account. */
  sender: string;
  roomIds: string[];
  createdAt: string;
}

export interface Room {
  projectId: string;
  userId: string;
  label: string;
  address: string;
  unit: string | null;
  /** draft until the user confirms dimensions, what they own and the brief. */
  status: "draft" | "ready";
  style: string | null;
  createdAt: string;
}

export class AccountError extends Error {}

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

export async function userForSender(sender: string): Promise<User | null> {
  const userId = await accountKv.get<string>(`sender:${sender}`);
  return userId ? accountKv.get<User>(`user:${userId}`) : null;
}

export async function createUser(sender: string, name: string, email: string): Promise<User> {
  const existing = await userForSender(sender);
  if (existing) return existing;
  const user: User = { id: id("usr"), name, email: email.toLowerCase(), sender, roomIds: [], createdAt: new Date().toISOString() };
  await accountKv.set(`user:${user.id}`, user);
  await accountKv.set(`sender:${sender}`, user.id);
  return user;
}

async function mustOwn(sender: string, projectId: string): Promise<{ user: User; room: Room }> {
  const user = await userForSender(sender);
  if (!user) throw new AccountError("no account for this chat yet");
  const room = await accountKv.get<Room>(`room:${projectId}`);
  if (!room || room.userId !== user.id) throw new AccountError(`no room ${projectId} on this account`);
  return { user, room };
}

export async function listRooms(sender: string) {
  const user = await userForSender(sender);
  if (!user) return { user: null, rooms: [] };
  const rooms = await Promise.all(
    user.roomIds.map(async (projectId) => {
      const [room, plan] = await Promise.all([accountKv.get<Room>(`room:${projectId}`), getPlan(projectId)]);
      return room && plan ? { ...room, revision: plan.revision, cost: costOf(plan), itemCount: plan.items.length } : null;
    }),
  );
  return { user, rooms: rooms.filter((r) => r !== null) };
}

/** The demo rooms from the website's room gallery, usable as a starting room in chat. */
export function roomTemplates() {
  return getTadaimaRooms().map((r) => {
    const xs = r.plan.geometry.rooms[0]?.floorPolygon.map((p) => p[0]) ?? [0];
    const zs = r.plan.geometry.rooms[0]?.floorPolygon.map((p) => p[1]) ?? [0];
    return {
      slug: r.slug,
      label: r.label,
      widthM: Math.round((Math.max(...xs) - Math.min(...xs)) * 10) / 10,
      depthM: Math.round((Math.max(...zs) - Math.min(...zs)) * 10) / 10,
      itemCount: r.plan.items.length,
    };
  });
}

function templatePlan(slug: string | null): RoomPlan {
  if (!slug) return structuredClone(demoPlan);
  const room = getTadaimaRooms().find((r) => r.slug === slug);
  if (!room) throw new AccountError(`no demo room ${slug}`);
  const plan = structuredClone(room.plan);
  // every room shops the same real retailer catalog
  const known = new Set(plan.products.map((p) => p.id));
  return { ...plan, products: [...plan.products, ...realCatalog.filter((p) => !known.has(p.id))] };
}

/** Starts a room as an unconfirmed draft: from the prepared floor plan for an address, or from a demo room. */
export async function createRoom(sender: string, address: string, unit: string | null, label = "Living room", template: string | null = null) {
  const user = await userForSender(sender);
  if (!user) throw new AccountError("no account for this chat yet");
  const projectId = id("proj_u");
  const base = templatePlan(template);
  const plan: RoomPlan = { ...base, projectId, revision: 1, constraints: { ...base.constraints, clearance: base.constraints.clearance ?? 0.3 } };
  if (template) label = getTadaimaRooms().find((r) => r.slug === template)!.label;
  if (!(await createPlan(plan))) throw new AccountError("room id collision, try again");
  const room: Room = { projectId, userId: user.id, label, address, unit, status: "draft", style: null, createdAt: new Date().toISOString() };
  await accountKv.set(`room:${projectId}`, room);
  await accountKv.set(`user:${user.id}`, { ...user, roomIds: [...user.roomIds, projectId] });
  return { room, plan };
}

/**
 * An owned item the user doesn't actually have becomes a planned purchase:
 * the cheapest available catalog product of the same category that fits the
 * same footprint. With no such product it is removed.
 */
function replaceUnowned(plan: RoomPlan, item: PlacedItem): PlacedItem | null {
  const [w, , d] = item.dimensions ?? [0, 0, 0];
  const fits = (p: ProductCandidate) =>
    p.category === item.category && p.availability === "available" && p.price && p.dimensions && p.dimensions[0] <= w + 0.05 && p.dimensions[2] <= d + 0.05;
  const pick = plan.products.filter(fits).sort((a, b) => a.price!.amountMinor - b.price!.amountMinor)[0];
  if (!pick) return null;
  return {
    ...item,
    label: pick.label,
    origin: "proposed_purchase",
    productId: pick.id,
    dimensions: pick.dimensions,
    seats: pick.seats,
    locked: false,
  };
}

export async function confirmRoom(
  sender: string,
  projectId: string,
  brief: { ownedItemIds: string[]; budgetUsd: number | null; minimumSeats: number | null; style: string | null },
) {
  const { room } = await mustOwn(sender, projectId);
  const plan = await getPlan(projectId);
  if (!plan) throw new AccountError(`no plan for ${projectId}`);
  const owned = new Set(brief.ownedItemIds);
  const items = plan.items.flatMap((i) => {
    if (i.origin !== "existing_owned" || owned.has(i.id)) return [i];
    const swapped = replaceUnowned(plan, i);
    return swapped ? [swapped] : [];
  });
  const next: RoomPlan = {
    ...plan,
    items,
    constraints: {
      ...plan.constraints,
      budget: brief.budgetUsd === null ? plan.constraints.budget : { amountMinor: Math.round(brief.budgetUsd * 100), currency: "USD" },
      minimumSeats: brief.minimumSeats ?? plan.constraints.minimumSeats,
    },
  };
  const saved = await savePlan(projectId, plan.revision, next);
  if (!saved.ok) throw new AccountError("the room changed while confirming, try again");
  await accountKv.set(`room:${projectId}`, { ...room, status: "ready", style: brief.style });
  const result = { ...next, revision: saved.revision };
  return { plan: result, cost: costOf(result), validations: validate(result) };
}

export async function getRoom(sender: string, projectId: string) {
  return (await mustOwn(sender, projectId)).room;
}

export interface ResearchedProduct {
  id: string;
  category: FurnitureCategory;
  merchant: string;
  label: string;
  sourceUrl: string;
  imageUrl: string | null;
  priceUsd: number | null;
  dimensions: [number, number, number] | null;
  seats: number | null;
  availability: ProductCandidate["availability"];
  observedAt: string;
}

/** Adds live observations to the plan's catalog (one evidence record each). Products already in the catalog are skipped. */
export async function addResearchedProducts(projectId: string, found: ResearchedProduct[], source: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { plan } = await getProject(projectId);
    const known = new Set(plan.products.map((p) => p.id));
    const fresh = found.filter((p) => !known.has(p.id));
    if (!fresh.length) return { added: 0, revision: plan.revision };
    const evidence: Evidence[] = fresh.map((p) => ({
      id: `ev_${p.id}`.slice(0, 120),
      sourceUrl: p.sourceUrl,
      privateAssetId: null,
      observedAt: p.observedAt,
      claim: `${source} observed price, size and stock on the product page`,
      dimensionStatus: p.dimensions ? "source_dimension" : null,
      confirmedByUserAt: null,
    }));
    const products: ProductCandidate[] = fresh.map((p, i) => ({
      id: p.id,
      category: p.category,
      merchant: p.merchant,
      sourceUrl: p.sourceUrl,
      variantId: null,
      label: p.label,
      dimensions: p.dimensions,
      seats: p.seats,
      price: p.priceUsd === null ? null : { amountMinor: Math.round(p.priceUsd * 100), currency: "USD" },
      availability: p.availability,
      imageUrl: p.imageUrl,
      observedAt: p.observedAt,
      evidenceIds: [evidence[i].id],
      fixture: false,
    }));
    const r = await applyPlanChanges(projectId, plan.revision, [{ kind: "add_products", products, evidence }]);
    if (r.ok) return { added: products.length, revision: r.plan.revision };
    if (r.reason !== "stale_revision") throw new AccountError("couldn't add those products to the room");
  }
  throw new AccountError("the room kept changing, try again");
}
