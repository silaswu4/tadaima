// Free 360 degree turning: continuous spin while a key is held, a crisp 15 degree tap,
// Shift snaps to 45, and the scroll wheel turns about 5 degrees per notch. Pure math.

const deg = (d: number) => (d * Math.PI) / 180;

export const SPIN = {
  /** Full speed while held, radians per second. */
  speed: deg(120),
  /** Time constant for the eased start and the coast to a stop, seconds. */
  ease: 0.12,
  /** A press shorter than this is a tap. */
  tapSeconds: 0.18,
  tap: deg(15),
  snap: deg(45),
  /** Wheel turn per notch (about 100 px of deltaY in Chrome and Safari). */
  wheelPerNotch: deg(5),
  notchPixels: 100,
  /** Settle time constant toward a target, seconds. */
  settle: 0.06,
} as const;

export type Spin = {
  dir: 1 | -1;
  held: boolean;
  heldFor: number;
  /** Signed angular speed, radians per second. */
  speed: number;
  /** Radians turned so far by this spin. */
  turned: number;
  /** Once released: total `turned` to come to rest at. */
  target: number | null;
};

export function startSpin(dir: 1 | -1): Spin {
  return { dir, held: true, heldFor: 0, speed: 0, turned: 0, target: null };
}

/** Next multiple of `step` strictly beyond `angle` in direction `dir`. */
export function snapToward(angle: number, dir: 1 | -1, step: number) {
  const eps = 1e-4;
  return dir > 0 ? Math.floor((angle + eps) / step + 1) * step : Math.ceil((angle - eps) / step - 1) * step;
}

/**
 * Let go of a held spin. `rotation` is the piece's absolute facing now.
 * A tap turns exactly 15 degrees (or to the next 45 with Shift); a hold coasts to a stop
 * (at the nearest 45 with Shift).
 */
export function releaseSpin(spin: Spin, rotation: number, snap: boolean) {
  if (!spin.held) return;
  spin.held = false;
  const tap = spin.heldFor < SPIN.tapSeconds && Math.abs(spin.turned) < SPIN.tap;
  if (tap) {
    const start = rotation - spin.turned;
    spin.target = snap ? snapToward(start, spin.dir, SPIN.snap) - start : spin.dir * SPIN.tap;
    return;
  }
  const coast = spin.speed * SPIN.ease;
  if (!snap) { spin.target = spin.turned + coast; return; }
  let rest = Math.round((rotation + coast) / SPIN.snap) * SPIN.snap;
  // never swing back against the direction it was turning
  if ((rest - rotation) * spin.dir < -1e-6) rest = snapToward(rotation, spin.dir, SPIN.snap);
  spin.target = spin.turned + (rest - rotation);
}

/** Advance a spin; returns the turn to apply this frame and whether the spin is over. */
export function stepSpin(spin: Spin, dt: number, reduced = false): { delta: number; done: boolean } {
  if (!(dt > 0)) return { delta: 0, done: false };
  if (spin.held) {
    spin.heldFor += dt;
    const full = spin.dir * SPIN.speed;
    spin.speed = reduced ? full : spin.speed + (full - spin.speed) * (1 - Math.exp(-dt / SPIN.ease));
    const delta = spin.speed * dt;
    spin.turned += delta;
    return { delta, done: false };
  }
  const remaining = (spin.target ?? spin.turned) - spin.turned;
  let delta = reduced ? remaining : remaining * (1 - Math.exp(-dt / SPIN.settle));
  const done = Math.abs(remaining - delta) < 5e-4;
  if (done) delta = remaining;
  spin.turned += delta;
  spin.speed = delta / dt;
  return { delta, done };
}

/** Wheel delta to a smooth turn: about 5 degrees per notch, proportional for trackpads. */
export function wheelTurn(deltaY: number, deltaMode: number) {
  const pixels = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 400 : deltaY;
  if (!Number.isFinite(pixels)) return 0;
  // a single event never turns more than a few notches
  return Math.max(-4, Math.min(4, pixels / SPIN.notchPixels)) * SPIN.wheelPerNotch;
}
