import type { Evidence, PointXZ, RoomAppearance, RoomGeometry, RoomPlan } from "../../backend/contracts";

export const MAX_ROOM_IMPORT_BYTES = 2 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function fail(message: string): never { throw new Error(`Room file: ${message}`); }
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object.");
  const record = value as Record<string, unknown>;
  if (required.some((key) => !(key in record)) || Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))) fail("unsupported or missing fields.");
  return record;
}
function list(value: unknown, maximum: number, minimum = 0): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail("an array exceeds the supported size.");
  return value;
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) fail("invalid text.");
  return value;
}
function id(value: unknown): string { const result = text(value, 64); if (!SAFE_ID.test(result)) fail("invalid ID."); return result; }
function number(value: unknown, low: number, high: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) fail("a number is outside its supported range.");
  return value;
}
function point(value: unknown): [number, number] {
  const values = list(value, 2, 2); return [number(values[0], -10000, 10000), number(values[1], -10000, 10000)];
}
function unique(values: string[]) { if (new Set(values).size !== values.length) fail("duplicate IDs."); return values; }
function refs(value: unknown, known: Set<string>): string[] {
  const result = unique(list(value, 2048).map(id));
  if (result.some((entry) => !known.has(entry))) fail("an evidence reference is missing.");
  return result;
}
const cross = (a: PointXZ, b: PointXZ, c: PointXZ) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function onSegment(a: PointXZ, b: PointXZ, c: PointXZ) {
  return Math.abs(cross(a, b, c)) < 1e-8 && c[0] >= Math.min(a[0], b[0]) - 1e-8 && c[0] <= Math.max(a[0], b[0]) + 1e-8 && c[1] >= Math.min(a[1], b[1]) - 1e-8 && c[1] <= Math.max(a[1], b[1]) + 1e-8;
}
function intersect(a: PointXZ, b: PointXZ, c: PointXZ, d: PointXZ) {
  return (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0)
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function polygon(value: unknown): [number, number][] {
  const points = list(value, 257, 3).map(point);
  if (points.length > 3 && Math.hypot(points[0][0] - points.at(-1)![0], points[0][1] - points.at(-1)![1]) < 1e-8) points.pop();
  if (points.length > 256) fail("too many floor vertices.");
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-8) fail("a floor edge has zero length.");
    const c = points[(i + 2) % points.length];
    if (onSegment(a, b, c)) fail("adjacent floor edges overlap.");
    area += a[0] * b[1] - b[0] * a[1];
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (intersect(a, b, points[j], points[(j + 1) % points.length])) fail("a floor polygon intersects itself.");
    }
  }
  if (Math.abs(area) < 1e-8) fail("a floor has no usable area.");
  return points;
}
function evidence(value: unknown): Evidence[] {
  const result = list(value, 2048).map((raw) => {
    const entry = object(raw, ["id", "sourceUrl", "privateAssetId", "observedAt", "claim", "dimensionStatus", "confirmedByUserAt"]);
    const sourceUrl = entry.sourceUrl === null ? null : text(entry.sourceUrl, 4096);
    if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) fail("evidence links must use HTTP or HTTPS.");
    if (!["measured", "source_dimension", "inferred", null].includes(entry.dimensionStatus as string | null)) fail("invalid dimension status.");
    return { id: id(entry.id), sourceUrl, privateAssetId: entry.privateAssetId === null ? null : text(entry.privateAssetId),
      observedAt: text(entry.observedAt, 128), claim: text(entry.claim, 16000), dimensionStatus: entry.dimensionStatus as Evidence["dimensionStatus"],
      confirmedByUserAt: entry.confirmedByUserAt === null ? null : text(entry.confirmedByUserAt, 128) };
  });
  unique(result.map((entry) => entry.id)); return result;
}
function geometry(value: unknown, known: Set<string>): RoomGeometry {
  const raw = object(value, ["units", "coordinateSystem", "rooms", "walls", "openings"]);
  if (raw.units !== "m" || raw.coordinateSystem !== "right-handed-y-up") fail("use meters with right-handed Y-up coordinates.");
  let vertices = 0;
  const rooms: RoomGeometry["rooms"] = list(raw.rooms, 32, 1).map((value) => {
    const entry = object(value, ["id", "label", "floorPolygon", "height", "evidenceIds"]);
    const floorPolygon = polygon(entry.floorPolygon); vertices += floorPolygon.length;
    return { id: id(entry.id), label: text(entry.label), floorPolygon, height: number(entry.height, 1e-6, 1000), evidenceIds: refs(entry.evidenceIds, known) };
  });
  if (vertices > 2048) fail("too many floor vertices.");
  const walls: RoomGeometry["walls"] = list(raw.walls, 512, 3).map((value) => {
    const entry = object(value, ["id", "start", "end", "height", "thickness", "evidenceIds"]);
    const start = point(entry.start), end = point(entry.end);
    if (Math.hypot(start[0] - end[0], start[1] - end[1]) <= 1e-8) fail("a wall has zero length.");
    return { id: id(entry.id), start, end, height: number(entry.height, 1e-6, 1000), thickness: number(entry.thickness, 1e-6, 10), evidenceIds: refs(entry.evidenceIds, known) };
  });
  const wallMap = new Map(walls.map((wall) => [wall.id, wall]));
  const perWall = new Map<string, RoomGeometry["openings"]>();
  const openings: RoomGeometry["openings"] = list(raw.openings, 256).map((value) => {
    const entry = object(value, ["id", "wallId", "kind", "offset", "width", "height", "sillHeight", "evidenceIds"]);
    const wallId = id(entry.wallId), wall = wallMap.get(wallId);
    if (!wall || !["door", "window"].includes(entry.kind as string)) fail("invalid opening wall or kind.");
    const result = { id: id(entry.id), wallId, kind: entry.kind as "door" | "window", offset: number(entry.offset, 0, 1000),
      width: number(entry.width, 1e-6, 1000), height: number(entry.height, 1e-6, 1000), sillHeight: number(entry.sillHeight, 0, 1000), evidenceIds: refs(entry.evidenceIds, known) };
    if (result.offset + result.width > Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]) + 1e-8 || result.sillHeight + result.height > wall.height + 1e-8) fail("an opening exceeds its wall.");
    const others = perWall.get(wallId) ?? [];
    if (others.length >= 32 || others.some((other) => Math.min(other.offset + other.width, result.offset + result.width) - Math.max(other.offset, result.offset) > 1e-8 && Math.min(other.sillHeight + other.height, result.sillHeight + result.height) - Math.max(other.sillHeight, result.sillHeight) > 1e-8)) fail("openings overlap or exceed the wall limit.");
    others.push(result); perWall.set(wallId, others); return result;
  });
  unique([...rooms, ...walls, ...openings].map((entry) => entry.id));
  return { units: "m", coordinateSystem: "right-handed-y-up", rooms, walls, openings };
}
function appearance(value: unknown, shape: RoomGeometry, known: Set<string>): RoomAppearance {
  const raw = object(value, ["schemaVersion", "reviewRequired", "scope", "sources", "surfaces", "notes"]);
  if (raw.schemaVersion !== "room-appearance/1.0" || raw.reviewRequired !== true || !["captured_room", "exact_unit", "building_reference", "unknown"].includes(raw.scope as string)) fail("invalid photo appearance profile.");
  const sources = list(raw.sources, 8).map((value) => {
    const entry = object(value, ["evidenceId", "sha256"]), evidenceId = id(entry.evidenceId);
    if (!known.has(evidenceId) || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail("invalid photo source hash or evidence ID.");
    return { evidenceId, sha256: entry.sha256 };
  });
  unique(sources.map((entry) => entry.evidenceId));
  const sourceIds = new Set(sources.map((entry) => entry.evidenceId));
  const entities = new Set([...shape.rooms, ...shape.walls].map((entry) => entry.id));
  const surfaces: RoomAppearance["surfaces"] = list(raw.surfaces, 544).map((value) => {
    const entry = object(value, ["entityId", "finish", "color", "roughness", "tileMeters", "rotationDegrees", "confidence", "evidenceIds"]);
    const entityId = id(entry.entityId), evidenceIds = refs(list(entry.evidenceIds, 8, 1), sourceIds);
    if (!entities.has(entityId) || !["wood", "paint", "tile", "carpet"].includes(entry.finish as string) || !["low", "medium", "high"].includes(entry.confidence as string) || typeof entry.color !== "string" || !/^#[a-fA-F0-9]{6}$/.test(entry.color) || !evidenceIds.length) fail("invalid photo surface estimate.");
    return { entityId, finish: entry.finish as RoomAppearance["surfaces"][number]["finish"], color: entry.color,
      roughness: number(entry.roughness, .04, 1), tileMeters: number(entry.tileMeters, .1, 10), rotationDegrees: number(entry.rotationDegrees, -360, 360),
      confidence: entry.confidence as "low" | "medium" | "high", evidenceIds };
  });
  unique(surfaces.map((entry) => entry.entityId));
  const used = new Set(surfaces.flatMap((entry) => entry.evidenceIds));
  if (used.size !== sourceIds.size) fail("the photo source list must match the surfaces' evidence.");
  return { schemaVersion: "room-appearance/1.0", reviewRequired: true, scope: raw.scope as RoomAppearance["scope"], sources, surfaces, notes: list(raw.notes, 64).map((entry) => text(entry, 2000)) };
}

/** Local data only: no furniture URLs, scripts, model downloads, or geometry execution. */
export function parseRoomImport(source: string): RoomPlan {
  if (new TextEncoder().encode(source).byteLength > MAX_ROOM_IMPORT_BYTES) fail("maximum file size is 2 MiB.");
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { fail("choose a valid reconstruction JSON file."); }
  const raw = object(parsed, ["jobId", "projectId", "inputRevision", "geometry", "evidence"], ["appearance"]);
  id(raw.jobId); const projectId = id(raw.projectId), revision = number(raw.inputRevision, 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(revision)) fail("revision must be an integer.");
  const observations = evidence(raw.evidence), known = new Set(observations.map((entry) => entry.id));
  const shape = geometry(raw.geometry, known);
  const plan: RoomPlan = { schemaVersion: "0.1-scaffold", projectId, revision, geometry: shape, evidence: observations,
    items: [], products: [], constraints: { budget: null, minimumSeats: null } };
  if (raw.appearance !== undefined) plan.appearance = appearance(raw.appearance, shape, known);
  return plan;
}
