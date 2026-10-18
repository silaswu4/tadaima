"use client";

import { useEffect, useRef, useState } from "react";

// isometric living room in inches. x runs along the back wall, y toward the
// viewer, z up. the sofa is the one live object; it swaps through a short
// ascii dissolve while everything else stays still.

type V3 = [number, number, number];
type Poly = { pts: [number, number][]; fill: string; stroke: string };

const C = Math.cos(Math.PI / 6);
const S = 0.5;
const P = ([x, y, z]: V3): [number, number] => [(x - y) * C, (x + y) * S - z];

const TONES = {
  room: { top: "var(--surface-soft)", front: "#e3ded4", side: "var(--surface-deep)", stroke: "var(--ink)" },
  wall: { top: "var(--mute)", front: "#e8e4dc", side: "var(--surface-deep)", stroke: "var(--ink)" },
  accent: { top: "var(--accent-soft)", front: "var(--accent)", side: "var(--accent-deep)", stroke: "var(--accent-deep)" },
};
type Tone = keyof typeof TONES;

function box(x: number, y: number, z: number, w: number, d: number, h: number, tone: Tone): Poly[] {
  const t = TONES[tone];
  const front: V3[] = [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]];
  const side: V3[] = [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]];
  const top: V3[] = [[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]];
  return [
    { pts: front.map(P), fill: t.front, stroke: t.stroke },
    { pts: side.map(P), fill: t.side, stroke: t.stroke },
    { pts: top.map(P), fill: t.top, stroke: t.stroke },
  ];
}

function flat(vs: V3[], fill: string, stroke: string): Poly {
  return { pts: vs.map(P), fill, stroke };
}

const ptsAttr = (pts: [number, number][]) => pts.map(([a, b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join(" ");

// room
const W = 170;
const D = 150;
const H = 92;
const T = 5;
const SPACE = { x: 22, w: 100, d: 40 };

const room: Poly[] = [
  ...box(-T, -T, -5, T, D + T, H + 5, "wall"),
  ...box(0, -T, -5, W, T, H + 5, "wall"),
  ...box(0, 0, -5, W, D, 5, "room"),
  // window
  flat([[128, 0.2, 34], [160, 0.2, 34], [160, 0.2, 76], [128, 0.2, 76]], "var(--surface-soft)", "var(--ink)"),
  ...box(126, 0, 32, 36, 3, 2, "room"),
  // frame above the sofa
  flat([[54, 0.2, 52], [86, 0.2, 52], [86, 0.2, 74], [54, 0.2, 74]], "var(--surface-soft)", "var(--ink)"),
  flat([[59, 0.3, 56], [81, 0.3, 56], [81, 0.3, 70], [59, 0.3, 70]], "var(--surface-deep)", "var(--ink)"),
  // shelf and books on the left wall
  ...box(0, 62, 44, 9, 44, 2, "room"),
  ...box(0, 66, 46, 7, 3, 11, "room"),
  ...box(0, 69.5, 46, 7, 4, 13, "room"),
  ...box(0, 74, 46, 7, 3, 9, "room"),
  ...box(0, 90, 46, 6, 6, 5, "room"),
  // rug
  flat([[30, 54, 0.2], [132, 54, 0.2], [132, 124, 0.2], [30, 124, 0.2]], "var(--surface-soft)", "var(--mute)"),
  flat([[35, 59, 0.3], [127, 59, 0.3], [127, 119, 0.3], [35, 119, 0.3]], "none", "var(--mute)"),
  // floor lamp base and shade
  ...box(5, 9, 0, 8, 8, 1.5, "room"),
];
const lampShade = box(3, 7, 58, 12, 12, 10, "room");
const plant = box(142, 9, 0, 12, 12, 14, "room");

const mullions: [V3, V3][] = [
  [[144, 0.3, 34], [144, 0.3, 76]],
  [[128, 0.3, 55], [160, 0.3, 55]],
];
const lampPole: [V3, V3] = [[9, 13, 1.5], [9, 13, 58]];
const leaves: { at: V3; rx: number; ry: number; rot: number }[] = [
  { at: [146, 13, 24], rx: 5, ry: 10, rot: -28 },
  { at: [150, 16, 25], rx: 5, ry: 11, rot: 22 },
  { at: [148, 15, 31], rx: 4, ry: 9, rot: -4 },
];

const table: Poly[] = [
  ...box(62, 76, 0, 2, 2, 13, "room"),
  ...box(100, 76, 0, 2, 2, 13, "room"),
  ...box(62, 94, 0, 2, 2, 13, "room"),
  ...box(100, 94, 0, 2, 2, 13, "room"),
  ...box(60, 74, 13, 44, 24, 3, "room"),
];

// sofas. each fits the dashed space against the back wall.
type Variant = { dims: string; w: number; d: number; x0: number; parts: Poly[] };

function variant(w: number, d: number, h: number, build: (x0: number, y0: number) => Poly[]): Variant {
  const x0 = SPACE.x + (SPACE.w - w) / 2;
  return { dims: `${w} × ${d} × ${h} in`, w, d, x0, parts: build(x0, 1) };
}

const cushions = (x: number, y: number, z: number, w: number, d: number, h: number, n: number) => {
  const cw = (w - (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => box(x + i * (cw + 1), y, z, cw, d, h, "accent")).flat();
};

const VARIANTS: Variant[] = [
  variant(88, 36, 32, (x, y) => [
    ...box(x, y, 0, 7, 36, 24, "accent"),
    ...box(x + 7, y, 0, 74, 36, 15, "accent"),
    ...box(x + 7, y, 15, 74, 9, 17, "accent"),
    ...cushions(x + 7, y + 9, 15, 74, 27, 5, 3),
    ...box(x + 81, y, 0, 7, 36, 24, "accent"),
  ]),
  variant(96, 38, 27, (x, y) => [
    ...box(x, y, 0, 96, 38, 12, "accent"),
    ...box(x, y, 12, 47.5, 10, 15, "accent"),
    ...box(x + 48.5, y, 12, 47.5, 10, 15, "accent"),
    ...cushions(x + 1, y + 10, 12, 94, 27, 6, 2),
  ]),
  variant(72, 34, 34, (x, y) => [
    ...box(x + 2, y + 1, 0, 2, 2, 5, "accent"),
    ...box(x + 68, y + 1, 0, 2, 2, 5, "accent"),
    ...box(x + 2, y + 31, 0, 2, 2, 5, "accent"),
    ...box(x + 68, y + 31, 0, 2, 2, 5, "accent"),
    ...box(x, y, 5, 8, 34, 21, "accent"),
    ...box(x + 8, y, 5, 56, 34, 10, "accent"),
    ...box(x + 8, y, 15, 56, 9, 19, "accent"),
    ...cushions(x + 8, y + 9, 15, 56, 25, 5, 2),
    ...box(x + 64, y, 5, 8, 34, 21, "accent"),
  ]),
];

// viewBox around the whole diorama
const extents = ([[-T, -T, H], [W, -T, H], [-T, D, -5], [W, D, -5], [W, -T, -5], [-T, D, H]] as V3[]).map(P);
const PAD = 12;
const minX = Math.min(...extents.map((p) => p[0])) - PAD;
const maxX = Math.max(...extents.map((p) => p[0])) + PAD;
const minY = Math.min(...extents.map((p) => p[1])) - PAD;
const maxY = Math.max(...extents.map((p) => p[1])) + PAD;

// ascii grid over every sofa's footprint
const FS = 4.4;
const CW = FS * 0.6;
const LH = FS * 1.05;
const sofaPts = VARIANTS.flatMap((v) => v.parts.flatMap((p) => p.pts));
const AX = Math.min(...sofaPts.map((p) => p[0]));
const AY = Math.min(...sofaPts.map((p) => p[1]));
const COLS = Math.ceil((Math.max(...sofaPts.map((p) => p[0])) - AX) / CW) + 1;
const ROWS = Math.ceil((Math.max(...sofaPts.map((p) => p[1])) - AY) / LH) + 1;
const RAMP = ".:-=+*#%@";

const HOLD = 3200;
const OUT = 650;
const IN = 750;
const ease = (t: number) => t * t * (3 - 2 * t);

function Polys({ polys }: { polys: Poly[] }) {
  return polys.map((p, i) => (
    <polygon
      key={i}
      points={ptsAttr(p.pts)}
      fill={p.fill}
      stroke={p.stroke}
      strokeOpacity={p.stroke === "var(--ink)" ? 0.55 : 1}
      strokeWidth={1}
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  ));
}

function FloorText({ at, along, children }: { at: V3; along: "x" | "y"; children: string }) {
  const [sx, sy] = P(at);
  // lays the label flat on the floor, reading along the given axis
  const m = along === "x" ? [C, S, -C, S] : [C, -S, C, S];
  return (
    <text
      transform={`matrix(${m.join(" ")} ${sx} ${sy})`}
      fontSize={5.5}
      textAnchor="middle"
      fill="var(--ink-soft)"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {children}
    </text>
  );
}

function Line({ a, b, color = "var(--ink)", opacity = 0.55 }: { a: V3; b: V3; color?: string; opacity?: number }) {
  const [x1, y1] = P(a);
  const [x2, y2] = P(b);
  return (
    <line
      x1={x1} y1={y1} x2={x2} y2={y2}
      stroke={color} strokeOpacity={opacity} strokeWidth={1} vectorEffect="non-scaling-stroke"
    />
  );
}

function SofaGroup({ v }: { v: Variant }) {
  const y0 = 1;
  const yd = y0 + v.d + 7;
  const xd = v.x0 + v.w + 7;
  const [hx, hy] = P([v.x0 + v.w / 2, y0 + v.d / 2, 0]);
  return (
    <>
      <ellipse cx={hx} cy={hy} rx={(v.w + v.d) * C * 0.5} ry={(v.w + v.d) * 0.2} fill="var(--accent)" opacity={0.28} filter="url(#halo)" />
      <Polys polys={v.parts} />
      <Line a={[v.x0, yd, 0]} b={[v.x0 + v.w, yd, 0]} color="var(--ink-soft)" opacity={0.8} />
      <Line a={[v.x0, yd - 2, 0]} b={[v.x0, yd + 2, 0]} color="var(--ink-soft)" opacity={0.8} />
      <Line a={[v.x0 + v.w, yd - 2, 0]} b={[v.x0 + v.w, yd + 2, 0]} color="var(--ink-soft)" opacity={0.8} />
      <FloorText at={[v.x0 + v.w / 2, yd + 6, 0]} along="x">{`${v.w} in`}</FloorText>
      <Line a={[xd, y0, 0]} b={[xd, y0 + v.d, 0]} color="var(--ink-soft)" opacity={0.8} />
      <Line a={[xd - 2, y0, 0]} b={[xd + 2, y0, 0]} color="var(--ink-soft)" opacity={0.8} />
      <Line a={[xd - 2, y0 + v.d, 0]} b={[xd + 2, y0 + v.d, 0]} color="var(--ink-soft)" opacity={0.8} />
      <FloorText at={[xd + 6, y0 + v.d / 2, 0]} along="y">{`${v.d} in`}</FloorText>
    </>
  );
}

export function RoomFigure() {
  const [shown, setShown] = useState(0);
  const groups = useRef<(SVGGElement | null)[]>([]);
  const ascii = useRef<SVGGElement | null>(null);
  const rows = useRef<(SVGTextElement | null)[]>([]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const thresholds = Float32Array.from({ length: ROWS * COLS }, () => Math.random());
    let cur = 0;
    let cycleStart = performance.now();
    let switched = false;
    let lastChars = 0;
    let raf = 0;

    const setOpacity = (i: number, o: number) => {
      const g = groups.current[i];
      if (g) g.style.opacity = String(o);
    };

    const drawChars = (density: number, now: number) => {
      if (now - lastChars < 50 && density > 0) return;
      lastChars = now;
      for (let r = 0; r < ROWS; r++) {
        let line = "";
        for (let c = 0; c < COLS; c++) {
          line += thresholds[r * COLS + c] < density ? RAMP[(Math.random() * RAMP.length) | 0] : " ";
        }
        const el = rows.current[r];
        if (el) el.textContent = line;
      }
    };

    const frame = (now: number) => {
      const e = now - cycleStart;
      const next = (cur + 1) % VARIANTS.length;
      const g = ascii.current;

      if (e < HOLD) {
        // resting
      } else if (e < HOLD + OUT) {
        const p = ease((e - HOLD) / OUT);
        setOpacity(cur, 1 - p);
        g?.setAttribute("clip-path", `url(#sofa-clip-${cur})`);
        drawChars(p, now);
      } else if (e < HOLD + OUT + IN) {
        const p = ease((e - HOLD - OUT) / IN);
        setOpacity(cur, 0);
        setOpacity(next, p);
        g?.setAttribute("clip-path", `url(#sofa-clip-${next})`);
        if (!switched) {
          switched = true;
          setShown(next);
        }
        drawChars(1 - p, now);
      } else {
        setOpacity(next, 1);
        drawChars(0, now);
        cur = next;
        cycleStart = now;
        switched = false;
      }
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const v = VARIANTS[shown];
  const [px1, py1] = P(lampPole[0]);
  const [px2, py2] = P(lampPole[1]);

  return (
    <figure className="flex flex-col gap-4">
      <svg
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        className="h-auto w-full"
        role="img"
        aria-label="an isometric living room. the sofa against the back wall swaps between options that fit the same space."
      >
        <defs>
          <filter id="halo" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="9" />
          </filter>
          {VARIANTS.map((vv, i) => (
            <clipPath key={i} id={`sofa-clip-${i}`}>
              {vv.parts.map((p, j) => (
                <polygon key={j} points={ptsAttr(p.pts)} />
              ))}
            </clipPath>
          ))}
        </defs>

        <Polys polys={room} />
        {mullions.map(([a, b], i) => (
          <Line key={i} a={a} b={b} />
        ))}

        {/* the free space the sofa has to fit */}
        <polygon
          points={ptsAttr(([[SPACE.x, 0, 0.4], [SPACE.x + SPACE.w, 0, 0.4], [SPACE.x + SPACE.w, SPACE.d, 0.4], [SPACE.x, SPACE.d, 0.4]] as V3[]).map(P))}
          fill="var(--accent)"
          fillOpacity={0.06}
          stroke="var(--accent)"
          strokeDasharray="3 3"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />

        <line x1={px1} y1={py1} x2={px2} y2={py2} stroke="var(--ink)" strokeOpacity={0.55} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <Polys polys={lampShade} />

        <Polys polys={plant} />
        {leaves.map((l, i) => {
          const [lx, ly] = P(l.at);
          return (
            <ellipse
              key={i} cx={lx} cy={ly} rx={l.rx} ry={l.ry} transform={`rotate(${l.rot} ${lx} ${ly})`}
              fill="var(--surface-deep)" stroke="var(--ink)" strokeOpacity={0.55} strokeWidth={1} vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {VARIANTS.map((vv, i) => (
          <g
            key={i}
            ref={(el) => {
              groups.current[i] = el;
            }}
            style={{ opacity: i === 0 ? 1 : 0 }}
          >
            <SofaGroup v={vv} />
          </g>
        ))}

        <Polys polys={table} />

        <g ref={ascii} aria-hidden fill="var(--accent-deep)" style={{ fontFamily: "var(--font-mono)" }}>
          {Array.from({ length: ROWS }, (_, r) => (
            <text
              key={r}
              ref={(el) => {
                rows.current[r] = el;
              }}
              x={AX}
              y={AY + (r + 1) * LH}
              fontSize={FS}
              xmlSpace="preserve"
              style={{ whiteSpace: "pre" }}
            />
          ))}
        </g>
      </svg>

      <figcaption className="flex flex-wrap justify-between gap-x-6 gap-y-1 text-mute">
        <span>fig. 1 &middot; your living room, scanned</span>
        <span>
          option {String(shown + 1).padStart(2, "0")} / {String(VARIANTS.length).padStart(2, "0")} &middot; {v.dims} &middot;{" "}
          <span className="text-accent">fits</span>
        </span>
      </figcaption>
    </figure>
  );
}
