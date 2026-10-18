import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FurnitureCategory, RoomPlan, Vector3Meters } from "@/backend/contracts";
import { demoPlan, realCatalog } from "@/backend/fixtures/demo-room";
import { applyChanges, validate } from "@/backend/plan/rules";
import { placeAt } from "@/backend/shopping/placement";

const loveseat = { category: "sofa" as const, dimensions: [1.47, 0.772, 0.791] as Vector3Meters };
const at = (x: number, z: number, rotationY?: number) => ({ position: [x, 0, z] as Vector3Meters, rotationY });
const close = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

/** The placement, added to the plan, must pass the validator's own fit rules. */
function assertValid(plan: RoomPlan, piece: { category: FurnitureCategory; dimensions: Vector3Meters | null }, placement: { position: Vector3Meters; rotationY: number; roomId: string }, ignore?: string) {
  const items = ignore ? plan.items.filter((i) => i.id !== ignore) : plan.items;
  const next = applyChanges({ ...plan, items }, [
    {
      kind: "add",
      item: { id: "new", roomId: placement.roomId, label: "new", category: piece.category, origin: "existing_owned", productId: null, assetUrl: null, position: placement.position, rotationY: placement.rotationY, dimensions: piece.dimensions, seats: null, locked: false },
    },
  ]);
  for (const v of validate(next)) {
    if ((v.rule === "in_room" || v.rule === "no_overlap") && v.itemIds.includes("new")) assert.fail(`${v.rule}: ${v.message} at ${JSON.stringify(placement)}`);
  }
}

describe("placeAt", () => {
  test("a loveseat near the back wall snaps flush to it, facing into the room", () => {
    const r = placeAt(demoPlan, loveseat, at(3.0, 0.6));
    assert.ok(r.ok);
    assert.equal(r.placement.rotationY, 0);
    assert.ok(close(r.placement.position[2], 0.791 / 2 + 0.01), `z ${r.placement.position[2]}`);
    assert.equal(r.placement.position[0], 3);
    assert.equal(r.placement.againstWallId, "wall_back");
  });

  test("each wall gives the facing that points into the room", () => {
    const empty: RoomPlan = { ...demoPlan, items: [] };
    const cases: Array<[number, number, number, string]> = [
      [2.5, 0.3, 0, "wall_back"],
      [4.8, 2.1, -Math.PI / 2, "wall_right"],
      [2.5, 4.0, Math.PI, "wall_front"],
      [0.2, 2.1, Math.PI / 2, "wall_left"],
    ];
    for (const [x, z, rot, wall] of cases) {
      const r = placeAt(empty, loveseat, at(x, z));
      assert.ok(r.ok, `${wall}`);
      assert.ok(close(r.placement.rotationY, rot), `${wall}: ${r.placement.rotationY}`);
      assert.equal(r.placement.againstWallId, wall);
    }
  });

  test("blocked spot slides along the wall rather than off it", () => {
    // right up against the desk at the back wall: it has to slide right
    const r = placeAt(demoPlan, loveseat, at(1.6, 0.4));
    assert.ok(r.ok);
    assert.equal(r.placement.againstWallId, "wall_back");
    assert.ok(r.placement.position[0] > 1.6);
    assertValid(demoPlan, loveseat, r.placement);
  });

  test("out in the open a sofa faces the middle, squared to the walls", () => {
    const r = placeAt(demoPlan, loveseat, at(3.0, 1.5));
    assert.ok(r.ok);
    assert.equal(r.placement.againstWallId, null);
    assert.ok([0, Math.PI / 2, -Math.PI / 2, Math.PI].some((q) => close(r.placement.rotationY, q)));
  });

  test("an explicit facing is kept when it fits", () => {
    const r = placeAt(demoPlan, { category: "chair", dimensions: [0.7, 0.8, 0.7] }, at(2.5, 1.2, Math.PI / 2));
    assert.ok(r.ok);
    assert.ok(close(r.placement.rotationY, Math.PI / 2));
    assert.equal(r.placement.distanceM, 0);
  });

  test("off the floor, unsized and too big are told apart", () => {
    const off = placeAt(demoPlan, loveseat, at(9, 9));
    assert.ok(!off.ok && off.reason === "off_floor");
    const unsized = placeAt(demoPlan, { category: "chair", dimensions: null }, at(2.5, 1.2));
    assert.ok(!unsized.ok && unsized.reason === "no_size");
    const huge = placeAt(demoPlan, { category: "sofa", dimensions: [6, 0.8, 1] }, at(2.5, 2));
    assert.ok(!huge.ok && huge.reason === "too_big");
  });

  test("a full corner says how far away the nearest fit is, and that fit is valid", () => {
    const r = placeAt(demoPlan, loveseat, at(4.8, 4.0));
    assert.ok(!r.ok && r.reason === "no_room_nearby");
    assert.ok(r.nearest && r.nearest.distanceM > 1.2);
    assertValid(demoPlan, loveseat, r.nearest);
  });

  test("a piece being moved doesn't block itself", () => {
    const chair = demoPlan.items.find((i) => i.id === "item_armchair")!;
    const r = placeAt(demoPlan, chair, at(chair.position[0], chair.position[2], chair.rotationY), { ignoreItemId: chair.id });
    assert.ok(r.ok);
    assert.equal(r.placement.distanceM, 0);
  });

  test("rugs go under furniture", () => {
    const r = placeAt(demoPlan, { category: "rug", dimensions: [1.5, 0.01, 2.1] }, at(2.5, 2.5));
    assert.ok(r.ok);
    assert.equal(r.placement.distanceM, 0);
  });

  test("deterministic", () => {
    assert.deepEqual(placeAt(demoPlan, loveseat, at(1.6, 0.4)), placeAt(demoPlan, loveseat, at(1.6, 0.4)));
  });

  test("every catalog product at every spot: a success always passes in_room and no_overlap", () => {
    let ok = 0;
    let total = 0;
    const sized = realCatalog.filter((p) => p.dimensions);
    for (let x = 0.25; x < 5; x += 0.75) {
      for (let z = 0.25; z < 4.2; z += 0.65) {
        for (const p of sized) {
          total++;
          const r = placeAt(demoPlan, p, at(x, z), { fallback: false });
          if (r.ok) {
            ok++;
            assertValid(demoPlan, p, r.placement);
          }
        }
      }
    }
    assert.ok(ok > total * 0.3, `${ok}/${total} placed`);
  });

  test("non-rectangular room: L-shape keeps pieces inside and refuses the missing corner", () => {
    const L: RoomPlan = {
      ...demoPlan,
      items: [],
      geometry: {
        ...demoPlan.geometry,
        rooms: [{ ...demoPlan.geometry.rooms[0], floorPolygon: [[0, 0], [5, 0], [5, 2], [2.5, 2], [2.5, 4.2], [0, 4.2]] }],
        walls: [],
        openings: [],
      },
    };
    assert.equal(placeAt(L, loveseat, at(4, 3.5)).ok, false);
    for (const [x, z] of [[4, 1.8], [2.3, 3], [1, 4], [4.9, 1]]) {
      const r = placeAt(L, loveseat, at(x, z));
      assert.ok(r.ok, `${x},${z}`);
      assertValid(L, loveseat, r.placement);
    }
  });

  test("diagonal walls: snapping follows the wall's angle", () => {
    const diamond: RoomPlan = {
      ...demoPlan,
      items: [],
      geometry: { ...demoPlan.geometry, rooms: [{ ...demoPlan.geometry.rooms[0], floorPolygon: [[3, 0], [6, 3], [3, 6], [0, 3]] }], walls: [], openings: [] },
    };
    const r = placeAt(diamond, loveseat, at(4.2, 1.6));
    assert.ok(r.ok);
    // the wall from (3,0) to (6,3) faces inward at -45 degrees
    assert.ok(close(r.placement.rotationY, -Math.PI / 4), `${r.placement.rotationY}`);
    assertValid(diamond, loveseat, r.placement);
  });
});
