/* Mascot face: head-turn projection, idle wander, blink timing, and the eyes / mouth / blush markup.

   Ported from github.com/MatthewKim323/grok (lib/engine.ts and lib/face.ts), Matthew Kim's
   grokbot style mascot. That repo is MIT licensed, and its engine is itself adapted from
   bloub by Jeremy Perret (github.com/jeremy-prt/bloub), also MIT. Only the pieces needed
   here were taken and rewritten readably: the eye projection on a turning sphere, the
   layered sine wander, the seeded blink schedule, and the face drawing (eyes with pupils
   and a glint, mouth shapes, cheeks).

   MIT License, Copyright (c) 2026 Matthew Kim
   MIT License, Copyright (c) 2026 Jeremy Perret

   Permission is hereby granted, free of charge, to any person obtaining a copy of this
   software and associated documentation files (the "Software"), to deal in the Software
   without restriction, including without limitation the rights to use, copy, modify,
   merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
   permit persons to whom the Software is furnished to do so, subject to the following
   conditions: The above copyright notice and this permission notice shall be included in
   all copies or substantial portions of the Software.
   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
   PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
   FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
   DEALINGS IN THE SOFTWARE. */

export const TAU = Math.PI * 2;
export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const r2 = (v: number) => Math.round(v * 100) / 100;

export type Gaze = { yaw: number; pitch: number; roll: number };
export type EyeShape = { w: number; h: number; tilt: number; open: number };
export type Mouth = "smile" | "grin" | "laugh" | "o" | "flat";
export type Expression = { gaze: Gaze; split: number; eyes: [EyeShape, EyeShape]; mouth: Mouth };

const eye = (w: number, h: number, tilt = 0, open = 1): EyeShape => ({ w, h, tilt, open });
const pair = (w: number, h: number, tilt = 0): [EyeShape, EyeShape] => [eye(w, h, tilt), eye(w, h, -tilt)];

/** A few of the source expressions (neutre, heureux, excite, curieux), renamed. */
export const EXPRESSIONS = {
  neutral: { gaze: { yaw: 9, pitch: 3, roll: -4 }, split: 17.5, eyes: [eye(0.25, 0.3), eye(0.25, 0.3)], mouth: "smile" },
  happy: { gaze: { yaw: 5, pitch: 9, roll: 0 }, split: 17, eyes: pair(0.27, 0.17, 14), mouth: "grin" },
  excited: { gaze: { yaw: 6, pitch: 4, roll: 0 }, split: 19, eyes: pair(0.36, 0.44, -10), mouth: "laugh" },
  curious: { gaze: { yaw: 16, pitch: 9, roll: -10 }, split: 16.5, eyes: [eye(0.24, 0.46, -8), eye(0.2, 0.38, -8)], mouth: "o" },
} satisfies Record<string, Expression>;
export type ExpressionId = keyof typeof EXPRESSIONS;

export function mixExpression(a: Expression, b: Expression, t: number): Expression {
  const e = (x: EyeShape, y: EyeShape): EyeShape => ({ w: lerp(x.w, y.w, t), h: lerp(x.h, y.h, t), tilt: lerp(x.tilt, y.tilt, t), open: lerp(x.open, y.open, t) });
  return {
    gaze: { yaw: lerp(a.gaze.yaw, b.gaze.yaw, t), pitch: lerp(a.gaze.pitch, b.gaze.pitch, t), roll: lerp(a.gaze.roll, b.gaze.roll, t) },
    split: lerp(a.split, b.split, t),
    eyes: [e(a.eyes[0], b.eyes[0]), e(a.eyes[1], b.eyes[1])],
    mouth: t < 0.5 ? a.mouth : b.mouth,
  };
}

/* ---------- motion helpers from the source engine ---------- */

/** Three layered sines: smooth, never quite repeating drift. */
export function wave(t: number, period: number, phase = 0) {
  const r = (t / period) * TAU;
  return 0.55 * Math.sin(r + phase) + 0.3 * Math.sin(2 * r + phase * 1.7 + 1.1) + 0.15 * Math.sin(3 * r + phase * 2.3 + 2.4);
}

/** Small deterministic PRNG so every visit blinks on the same rhythm. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 1831565813) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const BLINK_LENGTH = 0.18;
const BLINKS = (() => {
  const rand = seeded(24301);
  const out: number[] = [];
  let t = 1.4;
  while (t < 900) {
    out.push(t);
    t += 1.9 + rand() * 2.7;
    // sometimes a quick double blink
    if (rand() < 0.18) {
      out.push(t);
      t += 0.24;
    }
  }
  return out;
})();

/** Lid openness at time t: 1 open, 0 shut. */
export function lid(t: number) {
  const cycle = t % 900;
  for (const at of BLINKS) {
    if (cycle < at) break;
    const k = (cycle - at) / BLINK_LENGTH;
    if (k >= 0 && k <= 1) return k < 0.45 ? 1 - k / 0.45 : (k - 0.45) / 0.55;
  }
  return 1;
}

/** Idle head wander, in degrees. */
export function wander(t: number, amount = 1) {
  return {
    yaw: (wave(t, 11.3, 0.4) * 5.5 + wave(t, 3.7, 2.1) * 1.6) * amount,
    pitch: (wave(t, 9.1, 1.3) * 4.2 + wave(t, 4.3, 0.7) * 1.3) * amount,
    roll: wave(t, 13.7, 3.2) * 2.2 * amount,
  };
}

/* ---------- eyes on a turning sphere ---------- */

const rad = (d: number) => (d * Math.PI) / 180;
type V3 = [number, number, number];
function turn(a: V3, b: V3, angle: number): [V3, V3] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [a[0] * c + b[0] * s, a[1] * c + b[1] * s, a[2] * c + b[2] * s],
    [b[0] * c - a[0] * s, b[1] * c - a[1] * s, b[2] * c - a[2] * s],
  ];
}

type Projected = { x: number; y: number; a: number; b: number; c: number; d: number; depth: number };

/** Where the two eyes land when a sphere of radius r turns by the gaze (yaw right, pitch up). */
export function projectEyes(g: Gaze, r: number, split: number): [Projected, Projected] {
  let fwd: V3 = [0, 0, 1];
  let right: V3 = [1, 0, 0];
  let up: V3 = [0, 1, 0];
  [fwd, right] = turn(fwd, right, rad(g.yaw));
  [up, fwd] = turn(up, fwd, rad(g.pitch));
  [right, up] = turn(right, up, rad(g.roll));
  const at = (side: number): Projected => {
    const [p, s] = turn(fwd, right, rad(split * side));
    return { x: p[0] * r, y: p[1] * r, a: s[0], b: s[1], c: up[0], d: up[1], depth: p[2] };
  };
  return [at(-1), at(1)];
}

/* ---------- face markup (source: lib/face.ts) ---------- */

const INK = "#1d140d";
// the head is ink, so the mouth is drawn in cream to read against it
const CREAM = "#fbf3e6";

const MOUTHS: Record<Mouth, string> = {
  smile: `<path d="M-.2 0Q0 .16 .2 0" fill="none" stroke="${CREAM}" stroke-width=".07" stroke-linecap="round"/>`,
  grin: `<path d="M-.24-.02Q0 .26 .24-.02Z" fill="${CREAM}" stroke="${CREAM}" stroke-width=".04" stroke-linejoin="round"/>`,
  laugh: `<path d="M-.26-.03Q0 .36 .26-.03Z" fill="${CREAM}" stroke="${CREAM}" stroke-width=".04" stroke-linejoin="round"/><path d="M-.11 .14Q0 .07 .11 .14Q0 .2-.11 .14Z" fill="#f07a8a"/>`,
  o: `<ellipse cx="0" cy=".05" rx=".07" ry=".085" fill="${CREAM}"/>`,
  flat: `<path d="M-.15 .04H.15" fill="none" stroke="${CREAM}" stroke-width=".07" stroke-linecap="round"/>`,
};

/**
 * Inner svg markup for the face. r is the head radius, blink is lid openness (0..1),
 * ox / oy shift the whole face (lean, bob). uid keeps clip ids unique per instance.
 */
export function faceMarkup(x: Expression, o: { r: number; blink: number; ox: number; oy: number; uid: string }) {
  const projected = projectEyes(x.gaze, o.r, x.split);
  const placed: { x: number; y: number; alpha: number }[] = [];
  let s = "";
  projected.forEach((p, i) => {
    if (p.depth <= 0.02) return;
    const shape = x.eyes[i];
    const t = rad(shape.tilt);
    const ct = Math.cos(t);
    const st = Math.sin(t);
    // eye axes, turned by the tilt
    const ux = p.a * ct + p.c * st;
    const uy = p.b * ct + p.d * st;
    const vx = -p.a * st + p.c * ct;
    const vy = -p.b * st + p.d * ct;
    const open = 0.06 + 0.94 * clamp(Math.min(o.blink, shape.open));
    const ex = p.x + o.ox;
    const ey = p.y + o.oy;
    const alpha = clamp(p.depth / 0.12);
    placed.push({ x: ex, y: ey, alpha });
    // eyes a touch bigger than the source: the tour mascot is drawn small
    const w = shape.w * o.r * 1.22;
    const h = shape.h * o.r * 1.22;
    const rx = Math.max(w / 2, h * 0.4);
    const ry = (h / 2) * 0.92;
    // pupils drift toward where the eye sits on the head, which is where it looks
    const len = Math.hypot(p.x, p.y) || 1;
    const look = Math.min(1, len / (o.r * 0.7));
    const sx = (p.x / len) * look;
    const sy = (p.y / len) * look;
    const det = ux * vy - uy * vx || 1e-6;
    let lx = (vy * sx - vx * sy) / det;
    let ly = (-uy * sx + ux * sy) / det;
    const ll = Math.hypot(lx, ly) || 1;
    lx /= ll;
    ly /= ll;
    const pr = Math.min(rx, ry) * 0.62 + Math.max(rx, ry) * 0.08;
    const px = lx * Math.max(0, rx - pr * 0.9) * look;
    const py = ly * Math.max(0, ry - pr * 0.9) * look;
    const clip = `${o.uid}-eye${i}`;
    s +=
      `<g transform="matrix(${r2(ux)},${r2(uy * open)},${r2(vx)},${r2(vy * open)},${r2(ex)},${r2(ey)})" opacity="${r2(alpha)}">` +
      `<clipPath id="${clip}"><ellipse rx="${r2(rx)}" ry="${r2(ry)}"/></clipPath>` +
      `<ellipse rx="${r2(rx)}" ry="${r2(ry)}" fill="#fff"/>` +
      `<g clip-path="url(#${clip})"><circle cx="${r2(px)}" cy="${r2(py)}" r="${r2(pr)}" fill="${INK}"/>` +
      `<circle cx="${r2(px - pr * 0.32)}" cy="${r2(py - pr * 0.36)}" r="${r2(pr * 0.3)}" fill="#fff"/></g></g>`;
  });
  if (placed.length === 2) {
    const [l, r] = placed[0].x <= placed[1].x ? placed : [placed[1], placed[0]];
    const ux = r.x - l.x;
    const uy = r.y - l.y;
    const D = Math.hypot(ux, uy);
    if (D > 2) {
      const alpha = r2(Math.min(l.alpha, r.alpha));
      const angle = r2((Math.atan2(uy, ux) * 180) / Math.PI);
      for (const [k, p] of [l, r].entries()) {
        const bx = p.x - uy * 0.36 + (k ? 1 : -1) * ux * 0.08;
        const by = p.y + ux * 0.36 + (k ? 1 : -1) * uy * 0.08;
        s += `<ellipse cx="${r2(bx)}" cy="${r2(by)}" rx="${r2(D * 0.16)}" ry="${r2(D * 0.09)}" transform="rotate(${angle} ${r2(bx)} ${r2(by)})" fill="#ff8fa3" opacity="${r2(alpha * 0.55)}"/>`;
      }
      const mx = (l.x + r.x) / 2 - uy * 0.62;
      const my = (l.y + r.y) / 2 + ux * 0.62;
      s += `<g transform="matrix(${r2(ux)},${r2(uy)},${r2(-uy)},${r2(ux)},${r2(mx)},${r2(my)})" opacity="${alpha}">${MOUTHS[x.mouth]}</g>`;
    }
  }
  return s;
}
