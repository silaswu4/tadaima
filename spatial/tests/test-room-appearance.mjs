import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { planWindowDaylight } from "../room/window-daylight.ts";
import { MAX_ROOM_IMPORT_BYTES, parseRoomImport } from "../room/import-room.ts";
import { setMetricSurfaceUVs } from "../room/lighting.ts";

function geometry(polygon = [[0, 0], [6, 0], [6, 4], [0, 4]]) {
  return { units: "m", coordinateSystem: "right-handed-y-up",
    rooms: [{ id: "room", label: "Room", floorPolygon: polygon, height: 3, evidenceIds: [] }],
    walls: polygon.map((start, index) => ({ id: `wall-${index}`, start, end: polygon[(index + 1) % polygon.length], height: 3, thickness: .12, evidenceIds: [] })),
    openings: [{ id: "window", wallId: "wall-0", kind: "window", offset: 1, width: 2, height: 1.4, sillHeight: .9, evidenceIds: [] }] };
}
function request() { return { jobId: "test", projectId: "test-project", inputRevision: 1, geometry: geometry(), evidence: [] }; }
function appearanceRequest() {
  const value = request();
  value.evidence.push({ id: "photo", sourceUrl: "https://example.com/photo.jpg", privateAssetId: null, observedAt: "2026-10-18T00:00:00Z", claim: "Room photo", dimensionStatus: null, confirmedByUserAt: null });
  value.appearance = { schemaVersion: "room-appearance/1.0", reviewRequired: true, scope: "building_reference", sources: [{ evidenceId: "photo", sha256: "a".repeat(64) }],
    surfaces: [{ entityId: "room", finish: "wood", color: "#b4afa8", roughness: .72, tileMeters: 1.2, rotationDegrees: 90, confidence: "medium", evidenceIds: ["photo"] }], notes: ["Unit unverified"] };
  return value;
}

test("window light uses aperture position, size, outside offset, and inward direction", () => {
  const [light] = planWindowDaylight(geometry());
  assert.equal(light.id, "window"); assert.deepEqual(light.position, [2, 1.6, -.08499999999999999]);
  assert.deepEqual(light.inward, [-0, 0, 1]); assert.equal(light.width, 2); assert.equal(light.height, 1.4);
});

test("reversed wall endpoints preserve physical inward direction", () => {
  const value = geometry();
  [value.walls[0].start, value.walls[0].end] = [value.walls[0].end, value.walls[0].start];
  value.openings[0].offset = 3;
  const [light] = planWindowDaylight(value);
  assert.equal(light.position[0], 2); assert.equal(light.inward[2], 1);
});

test("concave reentrant walls point into the floor instead of toward bbox center", () => {
  const value = geometry([[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]]);
  value.openings[0].wallId = "wall-3"; value.openings[0].offset = .5; value.openings[0].width = 1;
  const [light] = planWindowDaylight(value);
  assert.deepEqual(light.inward, [-1, 0, 0]); assert.ok(light.position[0] > 2);
});

test("shared partitions, doors, and ungrounded windows are not daylight sources", () => {
  const value = geometry();
  value.rooms.push({ id: "other", label: "Other", floorPolygon: [[0, -4], [6, -4], [6, 0], [0, 0]], height: 3, evidenceIds: [] });
  assert.deepEqual(planWindowDaylight(value), []);
  value.rooms.pop(); value.openings[0].kind = "door"; assert.deepEqual(planWindowDaylight(value), []);
  value.openings[0].kind = "window"; value.walls[0].start = [10, 10]; value.walls[0].end = [16, 10]; assert.deepEqual(planWindowDaylight(value), []);
});

test("daylight limits prefer area then stable ID without mutating input", () => {
  const value = geometry();
  value.openings = Array.from({ length: 12 }, (_, index) => ({ ...value.openings[0], id: `window-${String(index).padStart(2, "0")}`, width: index === 11 ? 3 : 1 }));
  const before = structuredClone(value), lights = planWindowDaylight(value, 4);
  assert.equal(lights.length, 4); assert.equal(lights[0].id, "window-11"); assert.equal(lights[1].id, "window-00");
  assert.equal(planWindowDaylight(value, 100).length, 8); assert.deepEqual(value, before);
});

test("legacy local requests import as geometry-only plans", () => {
  const raw = request(), before = structuredClone(raw), result = parseRoomImport(JSON.stringify(raw));
  assert.deepEqual(result.geometry, raw.geometry); assert.deepEqual(result.items, []); assert.equal(result.appearance, undefined);
  assert.deepEqual(raw, before);
});

test("photo appearance preserves scope, evidence hashes and per-surface parameters", () => {
  const raw = appearanceRequest(), result = parseRoomImport(JSON.stringify(raw));
  assert.deepEqual(result.appearance, raw.appearance);
});

test("imports reject asset URLs, scripts, nonfinite coordinates, huge files and self-intersections", () => {
  for (const mutate of [
    (value) => { value.items = [{ assetUrl: "https://example.com/evil.glb" }]; },
    (value) => { value.script = "alert(1)"; },
    (value) => { value.geometry.rooms[0].floorPolygon[0][0] = null; },
    (value) => { value.geometry.rooms[0].floorPolygon = [[0, 0], [4, 4], [0, 4], [4, 0]]; },
    (value) => { value.geometry.openings[0].width = 100; },
    (value) => { value.geometry.walls[1].id = value.geometry.walls[0].id; },
    (value) => { value.geometry.rooms[0].evidenceIds = ["missing"]; },
  ]) { const raw = request(); mutate(raw); assert.throws(() => parseRoomImport(JSON.stringify(raw)), /Room file:/); }
  assert.throws(() => parseRoomImport(" ".repeat(MAX_ROOM_IMPORT_BYTES + 1)), /2 MiB/);
  assert.throws(() => parseRoomImport('{"jobId":"a","inputRevision":1e999}'), /Room file:/);
});

test("appearance import rejects missing sources, unrelated entities, unsafe links and unsupported finish values", () => {
  for (const mutate of [
    (value) => { value.appearance.surfaces[0].entityId = "window"; },
    (value) => { value.appearance.surfaces[0].evidenceIds = []; },
    (value) => { value.appearance.sources[0].sha256 = "not-a-hash"; },
    (value) => { value.appearance.surfaces[0].finish = "script"; },
    (value) => { value.appearance.surfaces[0].color = "url(https://example.com)"; },
    (value) => { value.appearance.surfaces[0].roughness = 0; },
    (value) => { value.appearance.surfaces[0].tileMeters = .001; },
    (value) => { value.appearance.surfaces[0].rotationDegrees = 361; },
    (value) => { value.evidence[0].sourceUrl = "javascript:alert(1)"; },
  ]) { const raw = appearanceRequest(); mutate(raw); assert.throws(() => parseRoomImport(JSON.stringify(raw)), /Room file:/); }
});

test("UV phase stays continuous across wall fragments with scaled and rotated grains", () => {
  const a = new THREE.BoxGeometry(2, 1, .1), b = a.clone();
  setMetricSurfaceUVs(a, 2, 90, [3, 1]); setMetricSurfaceUVs(b, 2, 0, [3, 1]);
  const auv = a.getAttribute("uv"), buv = b.getAttribute("uv");
  for (let i = 0; i < auv.count; i++) { assert.ok(Math.abs(auv.getX(i) + buv.getY(i)) < 1e-6); assert.ok(Math.abs(auv.getY(i) - buv.getX(i)) < 1e-6); }
  a.dispose(); b.dispose();
});

test("saved room fixture can be imported without the Blender process", () => {
  const raw = JSON.parse(readFileSync(new URL("../../reconstruction/fixtures/living-room.request.json", import.meta.url), "utf8"));
  assert.ok(parseRoomImport(JSON.stringify(raw)).geometry.rooms.length);
});
