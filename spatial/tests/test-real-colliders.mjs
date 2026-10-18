// Realism check with colliders the engine derived from the real models
// (spatial/tests/fixtures/real-colliders.json), through the shared backend rule.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collides } from "../../backend/plan/rules.ts";

const { pieces } = JSON.parse(readFileSync(new URL("./fixtures/real-colliders.json", import.meta.url), "utf8"));
const GAP = 0.015; // half of the 3 cm plan clearance
const at = (piece, x, z, rotationY = 0) => ({ ...piece, position: [x, 0, z], rotationY });
const footprintOnly = (piece) => ({ ...piece, collision: null });
const top = (piece) => Math.max(...piece.collision.map((b) => b[1] + b[4] / 2));

/** Push a chair facing the table straight at its long side; returns how far its center gets past the edge. */
function tuck(chair, table) {
  const edge = table.dimensions[2] / 2;
  let reached = null;
  for (let d = edge + chair.dimensions[2] / 2 + 0.2; d > 0; d -= 0.01) {
    // chair on the table's +Z side, its front (+Z) toward the table
    if (collides(at(chair, 0, d, Math.PI), at(table, 0, 0), GAP)) break;
    reached = d;
  }
  return { edge, reached };
}

test("a real dining chair slides under the real dining table until its backrest meets the tabletop edge", () => {
  const { diningChair: chair, diningTable: table } = pieces;
  const { edge, reached } = tuck(chair, table);
  const seatFront = reached - chair.dimensions[2] / 2;
  assert.ok(seatFront < edge - 0.25, `seat goes well under the top (front at ${seatFront.toFixed(2)}, edge ${edge.toFixed(2)})`);
  // the backrest (the chair's rear, local -Z) stops at the edge
  const back = Math.max(...chair.collision.filter((b) => b[1] - b[4] / 2 > 0.5).map((b) => -(b[2] - b[5] / 2)));
  assert.ok(Math.abs(reached + back - edge) < 0.06, `backrest rear ${(reached + back).toFixed(2)} vs edge ${edge.toFixed(2)}`);
  // the old footprint rule (category "other" from a scan) would stop it at the edge
  assert.equal(collides(at(footprintOnly(chair), 0, reached, Math.PI), at(footprintOnly(table), 0, 0), GAP), true);
});

test("the same chair also tucks under a desk", () => {
  const { edge, reached } = tuck(pieces.diningChair, pieces.desk);
  assert.ok(reached < edge, `center ${reached.toFixed(2)} gets past the desk edge ${edge.toFixed(2)}`);
});

test("a floor lamp's shade can hang over a sofa arm, its base cannot stand in it", () => {
  const { floorLamp: lamp, sofa } = pieces;
  assert.ok(Math.min(...lamp.collision.filter((b) => b[1] > 1).map((b) => b[1] - b[4] / 2)) > top(sofa), "shade is above the sofa");
  const side = sofa.dimensions[0] / 2;
  const base = Math.max(...lamp.collision.filter((b) => b[1] + b[4] / 2 < 0.1).map((b) => Math.abs(b[0]) + b[3] / 2));
  const shade = Math.max(...lamp.collision.filter((b) => b[1] > 1).map((b) => Math.abs(b[0]) + b[3] / 2));
  assert.ok(shade > base, "the shade is wider than the base");
  // the base just clear of the arm: the shade overlaps the sofa on the floor plan, yet nothing touches
  const x = side + base + 2 * GAP + 0.005;
  assert.equal(collides(at(lamp, x, 0), at(sofa, 0, 0), GAP), false);
  // the footprint rules alone would have refused this spot
  assert.equal(collides(at(footprintOnly(lamp), x, 0), at(footprintOnly(sofa), 0, 0), GAP), true);
  // the base inside the arm is refused
  assert.equal(collides(at(lamp, side - 0.05, 0), at(sofa, 0, 0), GAP), true);
});

test("two sofas can't overlap", () => {
  const { sofa, scannedSofa } = pieces;
  const touching = sofa.dimensions[0] / 2 + scannedSofa.dimensions[0] / 2;
  assert.equal(collides(at(sofa, 0, 0), at(scannedSofa, touching - 0.1, 0), GAP), true);
  assert.equal(collides(at(sofa, 0, 0), at(sofa, 0.3, 0.2, 0.4), GAP), true);
  assert.equal(collides(at(sofa, 0, 0), at(scannedSofa, touching + 0.1, 0), GAP), false);
});

test("a chair can't go under a coffee table", () => {
  const { diningChair: chair, coffeeTable: table } = pieces;
  const edge = table.dimensions[2] / 2 + chair.dimensions[2] / 2;
  assert.equal(collides(at(chair, 0, edge - 0.08, Math.PI), at(table, 0, 0), GAP), true);
  assert.equal(collides(at(pieces.loungeChair, 0, table.dimensions[2] / 2 + pieces.loungeChair.dimensions[2] / 2 - 0.08, Math.PI), at(table, 0, 0), GAP), true);
});

test("every real collider stays inside its piece's size", () => {
  for (const [name, piece] of Object.entries(pieces)) {
    const [w, h, d] = piece.dimensions;
    assert.ok(piece.collision.length >= 1 && piece.collision.length <= 24, `${name} has ${piece.collision.length} parts`);
    for (const [cx, cy, cz, bw, bh, bd] of piece.collision) {
      assert.ok(Math.abs(cx) + bw / 2 <= w / 2 + 0.01 && Math.abs(cz) + bd / 2 <= d / 2 + 0.01 && cy - bh / 2 >= -0.002 && cy + bh / 2 <= h + 0.01, `${name} part inside its size`);
    }
  }
});
