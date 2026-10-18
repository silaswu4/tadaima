/* A tiny damped spring, used for the mascot flight, its squash, limbs and antenna,
   and the spotlight. Semi-implicit Euler with fixed substeps so it stays stable when
   a frame runs long. Damping is set as a ratio of critical damping:
   ratio 1 arrives as fast as possible without overshoot, below 1 overshoots and settles. */

export type SpringConfig = { stiffness: number; ratio: number; mass?: number };

export const criticalDamping = (stiffness: number, mass = 1) => 2 * Math.sqrt(stiffness * mass);

const SUBSTEP = 1 / 240;

export class Spring {
  value: number;
  velocity = 0;
  target: number;
  stiffness: number;
  damping: number;
  mass: number;

  constructor(value: number, config: SpringConfig) {
    this.value = value;
    this.target = value;
    this.mass = config.mass ?? 1;
    this.stiffness = config.stiffness;
    this.damping = config.ratio * criticalDamping(config.stiffness, this.mass);
  }

  configure(config: SpringConfig) {
    this.mass = config.mass ?? 1;
    this.stiffness = config.stiffness;
    this.damping = config.ratio * criticalDamping(config.stiffness, this.mass);
  }

  /** Jump straight to a value with no motion left over. */
  snap(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  /** Add velocity, for a kick (a landing thump, a hop). */
  impulse(v: number) {
    this.velocity += v;
  }

  step(dt: number) {
    let left = Math.min(dt, 0.1);
    while (left > 1e-6) {
      const h = Math.min(SUBSTEP, left);
      const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
      this.velocity += (force / this.mass) * h;
      this.value += this.velocity * h;
      left -= h;
    }
    return this.value;
  }

  settled(epsilon = 0.001) {
    return Math.abs(this.value - this.target) < epsilon && Math.abs(this.velocity) < epsilon * 10;
  }
}
