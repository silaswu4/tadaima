// Pure motion math for the walk view: springs, eased turns, carry lift, drop
// settle and the put-away flight. No three.js, no DOM, so it is unit tested
// directly. Everything takes elapsed seconds and is frame-rate independent.

/** Fraction of the remaining gap closed in dt by exponential smoothing at `rate` per second. */
export function dampFactor(rate: number, dt: number): number {
  if (!Number.isFinite(rate) || !Number.isFinite(dt) || rate <= 0 || dt <= 0) return 0;
  return 1 - Math.exp(-rate * dt);
}

/** Exponential smoothing toward a target; the same result at any frame rate. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * dampFactor(rate, dt);
}

export type Spring = { value: number; velocity: number };

/**
 * Exact step of a critically damped spring (no overshoot) toward `target`.
 * `omega` is the natural frequency in rad/s: from rest the spring covers about
 * 90% of the gap in 3.9 / omega seconds. Closed form, so stable for any dt.
 */
export function springStep(spring: Spring, target: number, omega: number, dt: number): Spring {
  if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(omega) || omega <= 0) return spring;
  if (!Number.isFinite(spring.value) || !Number.isFinite(spring.velocity)) { spring.value = target; spring.velocity = 0; return spring; }
  const e = Math.exp(-omega * dt);
  const offset = spring.value - target;
  const temp = (spring.velocity + omega * offset) * dt;
  spring.velocity = (spring.velocity - omega * temp) * e;
  spring.value = target + (offset + temp) * e;
  return spring;
}

/** Snap a spring onto its target (reduced motion, teleports, finishing early). */
export function springSet(spring: Spring, value: number): Spring {
  spring.value = value;
  spring.velocity = 0;
  return spring;
}

/** Angle wrapped to (-PI, PI]. */
export function wrapAngle(angle: number): number {
  const turn = Math.PI * 2;
  let r = ((angle % turn) + turn) % turn;
  if (r > Math.PI) r -= turn;
  return r;
}

/** Signed shortest turn from `from` to `to`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Round an angle to the nearest multiple of `step` radians. */
export function snapAngle(angle: number, step: number): number {
  return step > 0 ? Math.round(angle / step) * step : angle;
}

/**
 * Spring an angle toward a target along the shortest way round. The spring's
 * value is unwrapped (it may leave (-PI, PI]) so the motion never jumps.
 */
export function angleSpringStep(spring: Spring, target: number, omega: number, dt: number): Spring {
  return springStep(spring, spring.value + angleDelta(spring.value, target), omega, dt);
}

// ------------------------------------------------------------------ walking

export const LOCOMOTION = {
  /** Speeding up: about 0.4 s to reach 90% of walking speed, starting gently. */
  accelOmega: 10,
  /** Slowing down: about 0.3 s to stop, ending gently (roughly 20 cm of glide). */
  brakeOmega: 13,
} as const;

/** Planar velocity with its own rate of change, so speed eases in and out (slow, fast, slow). */
export type Locomotion = { vx: number; vz: number; ax: number; az: number };

export function createLocomotion(): Locomotion {
  return { vx: 0, vz: 0, ax: 0, az: 0 };
}

/**
 * Move the velocity toward the target velocity with a critically damped spring.
 * Because the spring acts on velocity, acceleration starts at zero (ease in) and
 * fades out at cruise speed (ease out). Braking uses a slightly stiffer spring.
 * Reduced motion gets the target velocity at once.
 */
export function locomotionStep(state: Locomotion, targetX: number, targetZ: number, dt: number, reduced = false): Locomotion {
  if (reduced) { state.vx = targetX; state.vz = targetZ; state.ax = 0; state.az = 0; return state; }
  const braking = Math.hypot(targetX, targetZ) < Math.hypot(state.vx, state.vz) - 1e-6;
  const omega = braking ? LOCOMOTION.brakeOmega : LOCOMOTION.accelOmega;
  const x: Spring = { value: state.vx, velocity: state.ax };
  const z: Spring = { value: state.vz, velocity: state.az };
  springStep(x, targetX, omega, dt);
  springStep(z, targetZ, omega, dt);
  state.vx = Math.abs(x.value) < 1e-3 && targetX === 0 ? 0 : x.value;
  state.vz = Math.abs(z.value) < 1e-3 && targetZ === 0 ? 0 : z.value;
  state.ax = state.vx === 0 ? 0 : x.velocity;
  state.az = state.vz === 0 ? 0 : z.velocity;
  return state;
}

/** Vertical head bob in meters for the distance walked; fades to zero as the walker stops. */
export function headBob(distance: number, speedRatio: number, amplitude = 0.011, stride = 0.75): number {
  if (!Number.isFinite(distance) || !Number.isFinite(speedRatio)) return 0;
  const ratio = Math.max(0, Math.min(1.5, speedRatio));
  // One dip per footstep: |sin| gives the step rhythm, centered so standing still sits at zero.
  return amplitude * ratio * (Math.abs(Math.sin((distance / stride) * Math.PI)) - 0.5) * 2;
}

// ------------------------------------------------------------------ easing

export const clamp01 = (t: number) => (Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 1);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInCubic = (t: number) => Math.pow(clamp01(t), 3);
export const easeInOutCubic = (t: number) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

// ------------------------------------------------------------------ carrying

export const CARRY = {
  /** How high a held piece floats above the floor, meters. */
  lift: 0.06,
  /** Follow stiffness: a slight, readable lag behind the cursor or gaze. */
  followOmega: 16,
  /** Turn stiffness for R, Shift+R, the wheel and wall snaps. */
  turnOmega: 18,
  liftOmega: 14,
  /** Drop: fall, small hop, rest. Seconds. */
  settleSeconds: 0.34,
  /** Escape: glide back to where it was picked up. Seconds. */
  glideSeconds: 0.38,
  /** Put away: shrink and fly down out of the room. Seconds. */
  stashSeconds: 0.42,
  /** Refused drop: a short side to side shake. Seconds. */
  shakeSeconds: 0.32,
  /** Turn of a piece standing in the room. Seconds. */
  turnSeconds: 0.2,
} as const;

/**
 * Height above the floor while a piece lands, as a fraction of the carry lift:
 * it falls (accelerating) to the floor by 60% of the settle, makes one small
 * hop, and rests at exactly zero. Never below the floor.
 */
export function dropBounce(t: number): number {
  const x = clamp01(t);
  if (x >= 1) return 0;
  if (x < 0.6) { const f = x / 0.6; return 1 - f * f; }
  return 0.28 * Math.sin((Math.PI * (x - 0.6)) / 0.4);
}

/** Vertical squash at the moment of contact (1 = none). */
export function dropSquash(t: number): number {
  const x = clamp01(t);
  if (x < 0.55 || x > 0.85) return 1;
  return 1 - 0.05 * Math.sin((Math.PI * (x - 0.55)) / 0.3);
}

/** Side to side offset of a refused drop, meters; decays to zero. */
export function refusalShake(elapsed: number, amplitude = 0.025): number {
  const x = clamp01(elapsed / CARRY.shakeSeconds);
  if (x >= 1) return 0;
  return amplitude * Math.sin(x * Math.PI * 6) * (1 - x);
}

/** The put-away flight at progress t: a small hop, then shrink and drop toward the viewer's feet. */
export function stashPose(t: number): { travel: number; scale: number; hop: number; spin: number } {
  const x = clamp01(t);
  // Anticipation: barely moves for the first fifth, then accelerates away.
  const travel = easeInCubic(x);
  const scale = Math.max(0.001, 1 - easeInCubic(Math.max(0, (x - 0.08) / 0.92)));
  const hop = 0.12 * Math.sin(Math.PI * Math.min(1, x * 1.8)) * (1 - x);
  return { travel, scale, hop, spin: 0.7 * travel };
}

export type CarryLevel = "fits" | "snap" | "blocked";

/** Footprint color level from a fit check: green fits, amber will snap clear, red cannot drop. */
export function carryLevel(check: { fits: boolean; droppable: boolean }): CarryLevel {
  return check.fits ? "fits" : check.droppable ? "snap" : "blocked";
}

/** Wheel delta (any deltaMode) to whole rotation steps, carrying the remainder. */
export function wheelSteps(accumulated: number, deltaY: number, deltaMode: number, threshold = 60): { steps: number; rest: number } {
  const pixels = deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const total = accumulated + (Number.isFinite(pixels) ? pixels : 0);
  const steps = Math.trunc(total / threshold);
  return { steps, rest: total - steps * threshold };
}
