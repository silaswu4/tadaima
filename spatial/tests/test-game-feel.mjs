import assert from "node:assert/strict";
import test from "node:test";
import {
  CARRY, LOCOMOTION, angleDelta, angleSpringStep, carryLevel, createLocomotion, damp, dampFactor, dropBounce, dropSquash,
  headBob, locomotionStep, refusalShake, snapAngle, springStep, stashPose, wheelSteps, wrapAngle,
} from "../room/game-feel.ts";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

/** Run a stepper for `seconds` at `fps`. */
function run(fps, seconds, step) { const n = Math.round(fps * seconds); for (let i = 0; i < n; i++) step(1 / fps); }

test("exponential damping is frame-rate independent and safe on bad input", () => {
  let a = 0, b = 0;
  run(30, 1, (dt) => { a = damp(a, 10, 4, dt); });
  run(144, 1, (dt) => { b = damp(b, 10, 4, dt); });
  near(a, b, 1e-9);
  near(a, 10 * (1 - Math.exp(-4)), 1e-9);
  assert.equal(dampFactor(5, 0), 0);
  assert.equal(dampFactor(5, -1), 0);
  assert.equal(dampFactor(NaN, 1), 0);
});

test("critically damped spring: frame-rate independent, never overshoots, settles", () => {
  const at = (fps) => { const s = { value: 0, velocity: 0 }; let peak = 0; run(fps, 1.5, (dt) => { springStep(s, 1, 10, dt); peak = Math.max(peak, s.value); }); return { s, peak }; };
  const slow = at(30), fast = at(240);
  near(slow.s.value, fast.s.value, 1e-9);
  assert.ok(slow.peak <= 1 + 1e-12, "no overshoot");
  near(slow.s.value, 1, 1e-4);
  // A huge frame (tab was hidden) is still stable.
  const big = springStep({ value: 0, velocity: 0 }, 1, 10, 5);
  near(big.value, 1, 1e-9);
  // Nonfinite state recovers onto the target.
  const broken = springStep({ value: NaN, velocity: 0 }, 2, 10, 0.016);
  assert.equal(broken.value, 2);
});

test("walking speed eases in and out: slow, fast, slow", () => {
  const speeds = [];
  const state = createLocomotion();
  run(60, 1, (dt) => { locomotionStep(state, 0, -1.4, dt); speeds.push(Math.hypot(state.vx, state.vz)); });
  // Ease in: the first frame's speed gain is far smaller than the largest gain.
  const gains = speeds.map((v, i) => v - (speeds[i - 1] ?? 0));
  const maxGain = Math.max(...gains);
  assert.ok(gains[0] < maxGain * 0.5, `first gain ${gains[0]} vs max ${maxGain}`);
  assert.ok(gains.indexOf(maxGain) > 1, "acceleration peaks after the start");
  // About 90% of walking speed within roughly 0.4 s, and full speed by 1 s.
  assert.ok(speeds[Math.round(0.45 * 60)] > 1.4 * 0.9);
  near(speeds.at(-1), 1.4, 0.01);
  // Release: it brakes smoothly to an exact stop with a short glide.
  let glide = 0;
  const stopping = [];
  run(60, 1, (dt) => { const before = Math.hypot(state.vx, state.vz); locomotionStep(state, 0, 0, dt); const after = Math.hypot(state.vx, state.vz); glide += (before + after) / 2 * dt; stopping.push(after); });
  assert.equal(stopping.at(-1), 0);
  assert.ok(glide > 0.1 && glide < 0.3, `glide ${glide}`);
  assert.ok(stopping.every((v, i) => i === 0 || v <= stopping[i - 1] + 1e-12), "speed only falls while braking");
  assert.ok(LOCOMOTION.brakeOmega > LOCOMOTION.accelOmega);
});

test("walking is frame-rate independent and instant under reduced motion", () => {
  const travel = (fps) => { const s = createLocomotion(); let d = 0; run(fps, 0.6, (dt) => { const v0 = s.vz; locomotionStep(s, 0, -1.4, dt); d += (v0 + s.vz) / 2 * dt; }); return d; };
  near(travel(30), travel(120), 0.004);
  const instant = locomotionStep(createLocomotion(), 1, -1, 1 / 60, true);
  assert.deepEqual([instant.vx, instant.vz], [1, -1]);
});

test("angles wrap, snap and spring the short way round", () => {
  near(wrapAngle(3 * Math.PI), Math.PI);
  near(wrapAngle(-Math.PI / 2 - 2 * Math.PI), -Math.PI / 2);
  near(angleDelta(Math.PI - 0.1, -Math.PI + 0.1), 0.2);
  near(snapAngle(0.4, Math.PI / 4), Math.PI / 4);
  near(snapAngle(0.2, Math.PI / 12), Math.PI / 12);
  const s = { value: Math.PI - 0.1, velocity: 0 };
  run(60, 1, (dt) => angleSpringStep(s, -Math.PI + 0.1, 18, dt));
  near(wrapAngle(s.value), -Math.PI + 0.1, 1e-4);
  assert.ok(s.value > Math.PI - 0.1, "went forward across PI, not the long way back");
});

test("head bob fades out with speed and is small", () => {
  assert.equal(headBob(3.3, 0), 0);
  for (let d = 0; d < 3; d += 0.05) assert.ok(Math.abs(headBob(d, 1)) <= 0.0111);
  assert.equal(headBob(NaN, 1), 0);
});

test("drop settle falls, hops once, rests exactly on the floor", () => {
  near(dropBounce(0), 1);
  assert.ok(dropBounce(0.3) < 1 && dropBounce(0.3) > 0);
  near(dropBounce(0.6), 0);
  assert.ok(dropBounce(0.8) > 0 && dropBounce(0.8) <= 0.28);
  assert.equal(dropBounce(1), 0);
  for (let t = 0; t <= 1; t += 0.01) assert.ok(dropBounce(t) >= -1e-12, "never below the floor");
  assert.equal(dropSquash(0.2), 1);
  assert.ok(dropSquash(0.7) < 1 && dropSquash(0.7) >= 0.95);
  assert.equal(dropSquash(1), 1);
});

test("refused drop shake decays to zero", () => {
  assert.equal(refusalShake(0), 0);
  assert.ok(Math.abs(refusalShake(CARRY.shakeSeconds * 0.1)) > 0);
  assert.equal(refusalShake(CARRY.shakeSeconds), 0);
});

test("put-away flight shrinks and travels monotonically, ending tiny", () => {
  let lastTravel = -1, lastScale = 2;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const p = stashPose(t);
    assert.ok(p.travel >= lastTravel && p.scale <= lastScale + 1e-12);
    lastTravel = p.travel; lastScale = p.scale;
  }
  near(stashPose(0).scale, 1); near(stashPose(0).travel, 0);
  assert.ok(stashPose(1).scale < 0.01); near(stashPose(1).travel, 1); near(stashPose(1).hop, 0);
});

test("footprint level and wheel steps", () => {
  assert.equal(carryLevel({ fits: true, droppable: true }), "fits");
  assert.equal(carryLevel({ fits: false, droppable: true }), "snap");
  assert.equal(carryLevel({ fits: false, droppable: false }), "blocked");
  assert.deepEqual(wheelSteps(0, 100, 0), { steps: 1, rest: 40 });
  assert.deepEqual(wheelSteps(40, 30, 0), { steps: 1, rest: 10 });
  assert.deepEqual(wheelSteps(0, -3, 1), { steps: -2, rest: 0 });
  assert.deepEqual(wheelSteps(0, 20, 0), { steps: 0, rest: 20 });
});
