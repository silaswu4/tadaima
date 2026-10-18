import assert from "node:assert/strict";
import test from "node:test";
import { SPIN, releaseSpin, snapToward, startSpin, stepSpin, wheelTurn } from "../room/spin.ts";

const deg = (r) => (r * 180) / Math.PI;
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
function run(spin, seconds, fps = 60) {
  let done = false;
  for (let i = 0; i < Math.round(seconds * fps) && !done; i++) done = stepSpin(spin, 1 / fps).done;
  return { total: spin.turned, done };
}

test("holding spins at about 120 degrees a second, easing in", () => {
  const spin = startSpin(1);
  const first = stepSpin(spin, 1 / 60).delta;
  assert.ok(first > 0 && first < SPIN.speed / 60, "eases in");
  run(spin, 1);
  near(spin.speed, SPIN.speed, 1e-3);
  const before = spin.turned;
  run(spin, 1);
  near(deg(spin.turned - before), 120, 0.5);
});

test("a quick tap turns exactly 15 degrees, smoothly", () => {
  const spin = startSpin(-1);
  run(spin, 0.05);
  releaseSpin(spin, spin.turned, false);
  const { done } = run(spin, 1);
  assert.ok(done);
  near(deg(spin.turned), -15, 1e-6);
});

test("Shift snaps to the next 45 in the turning direction", () => {
  const spin = startSpin(1);
  // facing 10 degrees, a shift tap lands on 45
  releaseSpin(spin, (10 * Math.PI) / 180, true);
  run(spin, 1);
  near(deg(spin.turned), 35, 1e-6);
  near(deg(snapToward(Math.PI / 4, 1, Math.PI / 4)), 90, 1e-9);
  near(deg(snapToward(Math.PI / 4, -1, Math.PI / 4)), 0, 1e-9);
});

test("releasing a long hold coasts to a stop, and with Shift rests on a multiple of 45", () => {
  const free = startSpin(1);
  run(free, 1);
  const at = free.turned;
  releaseSpin(free, at, false);
  assert.ok(run(free, 2).done);
  assert.ok(free.turned > at && free.turned - at < 0.5, "coasts a little, never back");
  const snapped = startSpin(1);
  run(snapped, 0.7);
  releaseSpin(snapped, 0.3 + snapped.turned, true);
  run(snapped, 2);
  const rest = deg(0.3 + snapped.turned);
  near(rest / 45, Math.round(rest / 45), 1e-6);
});

test("any angle is reachable: no forced 90 degree steps", () => {
  const spin = startSpin(1);
  run(spin, 0.4);
  const angle = deg(spin.turned) % 15;
  assert.ok(angle > 0.5, "stops between tap steps");
});

test("wheel turns about 5 degrees per notch and scales for trackpads", () => {
  near(deg(wheelTurn(100, 0)), 5, 1e-9);
  near(deg(wheelTurn(-20, 0)), -1, 1e-9);
  assert.equal(wheelTurn(NaN, 0), 0);
  assert.ok(Math.abs(deg(wheelTurn(5000, 0))) <= 20);
});

test("reduced motion jumps straight to the target", () => {
  const spin = startSpin(1);
  releaseSpin(spin, 0, false);
  assert.equal(stepSpin(spin, 1 / 60, true).done, true);
  near(deg(spin.turned), 15, 1e-9);
});
