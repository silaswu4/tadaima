import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FurnitureCategory, PlacedItem, Vector3Meters } from "@/backend/contracts";
import { canShare, collides, validate } from "@/backend/plan/rules";
import { demoPlan } from "@/backend/fixtures/demo-room";
import { dragCheck } from "@/backend/shopping/drag";

const piece = (id: string, category: FurnitureCategory, dimensions: Vector3Meters, x: number, z: number, rotationY = 0): PlacedItem => ({
  id, roomId: "room_living", label: id, category, origin: "existing_owned", productId: null, assetUrl: null,
  position: [x, 0, z], rotationY, dimensions, seats: null, locked: false,
});
const diningTable = piece("table", "table", [1.4, 0.75, 0.8], 2.5, 2.0);
const coffeeTable = piece("coffee", "table", [0.9, 0.4, 0.55], 2.5, 2.0);
const chair = piece("chair", "chair", [0.5, 0.78, 0.57], 2.5, 2.25);
const desk = piece("desk", "desk", [1.2, 0.75, 0.6], 1.0, 0.32);
const vase = piece("vase", "decor", [0.2, 0.4, 0.2], 2.5, 2.0);
const sofa = piece("sofa", "sofa", [2.1, 0.85, 0.95], 2.5, 2.5);
const lamp = piece("lamp", "lamp", [0.6, 1.6, 0.6], 3.75, 2.5);

describe("realistic collisions", () => {
  test("a chair tucks under a dining table or a desk", () => {
    assert.equal(collides(chair, diningTable), false);
    assert.equal(collides({ ...chair, position: [1.0, 0, 0.5] }, desk), false);
    assert.ok(canShare(diningTable, chair), "either order");
  });
  test("but not under a coffee table, which is too low", () => {
    assert.equal(collides(chair, coffeeTable), true);
  });
  test("decor sits on tables and shelves, not on a sofa", () => {
    assert.equal(collides(vase, diningTable), false);
    assert.equal(collides(vase, coffeeTable), false);
    assert.equal(collides({ ...vase, position: [2.5, 0, 2.5] }, sofa), true);
  });
  test("a floor lamp only blocks its base, so its shade can hang over a sofa arm", () => {
    // the sofa's arm ends at x=3.55; the 0.6 m shade reaches back to 3.45, the 0.32 m base only to 3.59
    assert.equal(collides(lamp, sofa), false);
    assert.equal(collides({ ...lamp, position: [3.45, 0, 2.5] }, sofa), true, "the base itself still can't go into the sofa");
  });
  test("two sofas still can't overlap", () => {
    assert.equal(collides(sofa, { ...sofa, position: [3.0, 0, 2.6] }), true);
  });
  test("the validator agrees: a chair under a dining table passes", () => {
    const plan = { ...demoPlan, items: [diningTable, chair], constraints: { ...demoPlan.constraints, clearance: 0.03, minimumSeats: null, budget: null } };
    assert.equal(validate(plan).find((v) => v.rule === "no_overlap")?.status, "pass");
  });
  test("carrying: problems only name what the held piece bumps into, never old overlaps elsewhere", () => {
    const a = piece("a", "sofa", [2.0, 0.8, 0.9], 1.2, 3.6), b = piece("b", "sofa", [2.0, 0.8, 0.9], 1.6, 3.6); // already overlapping
    const plan = { ...demoPlan, items: [a, b, diningTable, { ...chair, position: [3.6, 0, 2.0] as Vector3Meters }], constraints: { ...demoPlan.constraints, clearance: 0.03 } };
    const d = dragCheck(plan, "chair", [2.5, 0, 2.2], 0);
    assert.ok(d.fits, `tucked under the table: ${d.problems.join(" ")}`);
    const bad = dragCheck(plan, "chair", [1.4, 0, 3.6], 0);
    assert.equal(bad.fits, false);
    assert.equal(bad.problems.length, 1);
    assert.match(bad.problems[0], /^Bumps into (a|b)( and (a|b))?\.$/);
  });
});
