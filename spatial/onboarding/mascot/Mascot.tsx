"use client";

/* The tour mascot: a little ink bot with an antenna and two stubby arms.
   Body, face, blink and idle wander are ported from github.com/MatthewKim323/grok
   (MIT, Matthew Kim; its engine adapts bloub by Jeremy Perret, MIT). See ./face.ts for
   the notices. The arms, antenna, gestures and spring driven secondary motion are new here.

   Drawn by writing svg attributes every frame, no React renders while it moves. */

import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Spring } from "../spring";
import { EXPRESSIONS, TAU, clamp, faceMarkup, lid, mixExpression, wander, type Expression, type ExpressionId } from "./face";

export type Gesture = "idle" | "wave" | "point" | "celebrate" | "think";

/** Screen velocity of the mascot in px per second, written by whoever moves it. */
export type MascotMotion = { vx: number; vy: number };

export type MascotHandle = {
  /** Crouch (positive) or stretch (negative): anticipation before a jump, a thump on landing. */
  squash: (amount: number) => void;
};

type Props = {
  gesture: Gesture;
  /** Unit vector toward what the mascot points or looks at, in screen space. Read every frame. */
  aim?: { current: { x: number; y: number } | null };
  motion?: { current: MascotMotion };
  reducedMotion?: boolean;
  size?: number;
  className?: string;
};

const R = 50; // head radius in svg units
const CY = 8; // head centre
const INK = "#1d140d";
const AMBER = "#f0b429";
const CONFETTI = ["#f0b429", "#e8483f", "#3ecf8e", "#3b93f0", "#ff7d93", "#8b5cf6"];
const EXPRESSION_FOR: Record<Gesture, ExpressionId> = { idle: "neutral", wave: "happy", point: "neutral", celebrate: "excited", think: "curious" };
const deg = (r: number) => (r * 180) / Math.PI;

type Piece = { x: number; y: number; vx: number; vy: number; spin: number; color: string; w: number; h: number };

export const Mascot = forwardRef<MascotHandle, Props>(function Mascot({ gesture, aim, motion, reducedMotion = false, size = 96, className }, ref) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const rootRef = useRef<SVGGElement>(null);
  const antennaRef = useRef<SVGPathElement>(null);
  const bulbRef = useRef<SVGGElement>(null);
  const armLRef = useRef<SVGGElement>(null);
  const armRRef = useRef<SVGGElement>(null);
  const faceRef = useRef<SVGGElement>(null);
  const dotsRef = useRef<SVGGElement>(null);
  const confettiRef = useRef<SVGGElement>(null);

  // latest props for the frame loop
  const live = useRef({ gesture, aim, reducedMotion, motion });
  useLayoutEffect(() => {
    live.current = { gesture, aim, reducedMotion, motion };
  });

  const springs = useRef<{ squash: Spring } | null>(null);
  useImperativeHandle(ref, () => ({
    squash(amount: number) {
      springs.current?.squash.impulse(amount * 20);
    },
  }), []);

  useEffect(() => {
    const s = {
      tilt: new Spring(0, { stiffness: 140, ratio: 0.55 }),
      stretch: new Spring(0, { stiffness: 260, ratio: 0.7 }),
      squash: new Spring(0, { stiffness: 320, ratio: 0.32 }),
      hop: new Spring(0, { stiffness: 220, ratio: 0.42 }),
      lean: new Spring(0, { stiffness: 120, ratio: 0.8 }),
      antenna: new Spring(0, { stiffness: 110, ratio: 0.2 }),
      armL: new Spring(52, { stiffness: 150, ratio: 0.45 }),
      armR: new Spring(-52, { stiffness: 150, ratio: 0.45 }),
      lookX: new Spring(0, { stiffness: 90, ratio: 1 }),
      lookY: new Spring(0, { stiffness: 90, ratio: 1 }),
      dots: new Spring(0, { stiffness: 120, ratio: 1 }),
    };
    springs.current = { squash: s.squash };

    let raf = 0;
    let last = 0;
    let clock = 0;
    let current: Gesture = live.current.gesture;
    let since = 0;
    let from: Expression = EXPRESSIONS.neutral;
    let to: Expression = EXPRESSIONS[EXPRESSION_FOR[current]];
    let morphAt = -10;
    let pieces: Piece[] = [];
    let piecesAt = -10;
    let nextHop = Infinity;
    let hops = 0;
    let lastVx = 0;

    const burst = () => {
      pieces = Array.from({ length: 18 }, (_, i) => {
        const a = -Math.PI / 2 + (i / 17 - 0.5) * 2.4 + (Math.random() - 0.5) * 0.3;
        const v = 150 + Math.random() * 130;
        return { x: 0, y: -30, vx: Math.cos(a) * v, vy: Math.sin(a) * v, spin: (Math.random() - 0.5) * 900, color: CONFETTI[i % CONFETTI.length], w: 5 + Math.random() * 4, h: 3 + Math.random() * 3 };
      });
      piecesAt = clock;
    };

    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      const dt = last ? Math.min((ts - last) / 1000, 0.1) : 0;
      last = ts;
      clock += dt;
      const { gesture: g, reducedMotion: still, motion: m } = live.current;
      const aim = live.current.aim?.current ?? null;

      if (g !== current) {
        from = mixExpression(from, to, clamp((clock - morphAt) / 0.35));
        to = EXPRESSIONS[EXPRESSION_FOR[g]];
        morphAt = clock;
        current = g;
        since = clock;
        hops = 0;
        nextHop = Infinity;
        if (g === "celebrate") {
          if (!still) burst();
          nextHop = clock + 0.05;
        }
      }
      const age = clock - since;
      const calm = still ? 0 : 1;

      /* --- flight: lean into the motion, stretch along it, antenna and arms lag behind --- */
      const vx = (m?.current.vx ?? 0) * calm;
      const vy = (m?.current.vy ?? 0) * calm;
      const speed = Math.hypot(vx, vy);
      const accel = (vx - lastVx) / Math.max(dt, 1e-3);
      lastVx = vx;
      s.stretch.target = clamp(speed / 2400, 0, 0.18);
      const flyTilt = clamp(vx / 1500, -0.38, 0.38);

      /* --- gesture targets --- */
      let armL = 52;
      let armR = -52;
      let lean = 0;
      let tilt = flyTilt;
      let lookX = 0;
      let lookY = 0;
      const bob = Math.sin((clock / 2.4) * TAU);
      if (g === "idle") {
        armL += bob * 6 * calm;
        armR -= bob * 6 * calm;
        tilt += bob * 0.05 * calm;
      } else if (g === "wave") {
        const waving = age < 2.2 ? 1 : 0.35;
        armR = -150 + Math.sin(age * 11) * 30 * waving * calm;
        armL = 46;
        tilt += Math.sin(age * 11) * 0.04 * waving * calm - 0.05;
        lookX = -0.2;
      } else if (g === "point" && aim) {
        const angle = deg(Math.atan2(-aim.x, aim.y));
        const tap = calm * Math.max(0, Math.sin(((age - 0.9) / 1.6) * TAU)) ** 8 * 10;
        // anticipation: pull the arm back for a beat, then throw it out
        const wind = age < 0.14 && !still ? Math.sign(aim.x || 1) * 18 : 0;
        if (aim.x >= 0) armR = clamp(angle - tap + wind, -175, -10);
        else armL = clamp(angle + tap + wind, 10, 175);
        lean = aim.x * 5;
        tilt += aim.x * 0.07;
        lookX = aim.x;
        lookY = aim.y;
      } else if (g === "celebrate") {
        const wiggle = Math.sin(age * 13) * 16 * calm;
        armR = -150 + wiggle;
        armL = 150 + wiggle;
        if (clock >= nextHop && hops < 2 && !still) {
          s.squash.impulse(90);
          s.hop.impulse(-900);
          hops += 1;
          nextHop = clock + 0.62;
        }
      } else if (g === "think") {
        armR = -60;
        armL = 58;
        tilt += -0.08;
        lookX = 0.45;
        lookY = -0.6;
      }
      // arms trail the flight a little
      const trail = clamp(vx / 28, -40, 40);
      s.armL.target = armL + trail;
      s.armR.target = armR + trail;
      s.tilt.target = tilt;
      s.lean.target = lean;
      s.lookX.target = lookX;
      s.lookY.target = lookY;
      s.dots.target = g === "think" ? 1 : 0;
      // the antenna is a stiff whip: it follows the body and lags accelerations
      s.antenna.target = -s.tilt.value * 1.1 - clamp(vx / 1800, -0.6, 0.6);
      if (!still) s.antenna.impulse(clamp(-accel / 9000, -0.25, 0.25));

      for (const sp of Object.values(s)) sp.step(dt);
      if (still) {
        s.squash.snap(0);
        s.hop.snap(0);
        s.stretch.snap(0);
      }

      /* --- body transform --- */
      const bobY = (g === "idle" || g === "point" || g === "think" ? bob * 2.6 : 0) * calm;
      const dir = deg(Math.atan2(vy, vx));
      const st = 1 + s.stretch.value;
      const q = clamp(s.squash.value / 40, -0.2, 0.28);
      const root = rootRef.current;
      if (root) {
        root.setAttribute(
          "transform",
          `translate(${(s.lean.value).toFixed(2)} ${(bobY + Math.min(0, s.hop.value) / 4).toFixed(2)}) ` +
            `rotate(${dir.toFixed(1)} 0 ${CY}) scale(${st.toFixed(3)} ${(1 / st).toFixed(3)}) rotate(${(-dir).toFixed(1)} 0 ${CY}) ` +
            `translate(0 ${CY + R}) scale(${(1 + q * 0.7).toFixed(3)} ${(1 - q).toFixed(3)}) translate(0 ${-(CY + R)}) ` +
            `rotate(${deg(s.tilt.value).toFixed(2)} 0 ${CY})`,
        );
      }

      /* --- antenna --- */
      const a = s.antenna.value + Math.sin(clock * 2.1) * 0.04 * calm;
      const base = { x: 0, y: CY - R + 6 };
      const tip = { x: Math.sin(a) * 26, y: base.y - Math.cos(a) * 26 };
      const ctrl = { x: Math.sin(a * 0.35) * 14, y: base.y - 15 };
      antennaRef.current?.setAttribute("d", `M${base.x} ${base.y}Q${ctrl.x.toFixed(2)} ${ctrl.y.toFixed(2)} ${tip.x.toFixed(2)} ${tip.y.toFixed(2)}`);
      bulbRef.current?.setAttribute("transform", `translate(${tip.x.toFixed(2)} ${tip.y.toFixed(2)})`);

      /* --- arms --- */
      armLRef.current?.setAttribute("transform", `translate(-43 ${CY + 10}) rotate(${s.armL.value.toFixed(2)})`);
      armRRef.current?.setAttribute("transform", `translate(43 ${CY + 10}) rotate(${s.armR.value.toFixed(2)})`);

      /* --- face --- */
      const k = clamp((clock - morphAt) / 0.35);
      const eased = 1 - (1 - k) ** 5;
      const x = mixExpression(from, to, eased);
      const drift = wander(clock, still ? 0 : 1);
      const face: Expression = {
        ...x,
        gaze: {
          yaw: x.gaze.yaw + drift.yaw + s.lookX.value * 26 + clamp(vx / 60, -14, 14),
          pitch: x.gaze.pitch + drift.pitch - s.lookY.value * 18,
          roll: x.gaze.roll + drift.roll,
        },
      };
      if (faceRef.current) faceRef.current.innerHTML = faceMarkup(face, { r: R, blink: lid(clock + 0.6), ox: 0, oy: CY, uid });

      /* --- thinking dots (the source "thinking" pulse) --- */
      const dots = dotsRef.current;
      if (dots) {
        const show = s.dots.value;
        dots.setAttribute("opacity", show.toFixed(3));
        if (show > 0.01) {
          Array.from(dots.children).forEach((c, i) => {
            const n = ((((clock - i * 0.5) / 1.5) % 1) + 1) % 1;
            const pulse = clamp((n < 0.5 ? 0.5 - 0.5 * Math.cos(n * TAU) : 0) * 2) * calm;
            c.setAttribute("opacity", (0.45 + 0.55 * pulse).toFixed(2));
            c.setAttribute("r", ((3.5 + i * 1.6) * (1 + 0.25 * pulse) * show).toFixed(2));
          });
        }
      }

      /* --- confetti --- */
      const cf = confettiRef.current;
      if (cf) {
        const life = clock - piecesAt;
        if (pieces.length && life < 1.6) {
          let html = "";
          for (const p of pieces) {
            const px = p.x + p.vx * life;
            const py = p.y + p.vy * life + 0.5 * 520 * life * life;
            const fade = clamp((1.6 - life) / 0.5);
            html += `<rect x="${(-p.w / 2).toFixed(1)}" y="${(-p.h / 2).toFixed(1)}" width="${p.w.toFixed(1)}" height="${p.h.toFixed(1)}" rx="1" fill="${p.color}" opacity="${fade.toFixed(2)}" transform="translate(${px.toFixed(1)} ${py.toFixed(1)}) rotate(${(p.spin * life).toFixed(0)})"/>`;
          }
          cf.innerHTML = html;
        } else if (pieces.length) {
          pieces = [];
          cf.innerHTML = "";
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [uid]);

  return (
    <svg className={className} width={size} height={size} viewBox="-80 -80 160 160" aria-hidden="true" focusable="false" overflow="visible">
      <defs>
        <radialGradient id={`${uid}-sheen`} cx="0.34" cy="0.26" r="0.75">
          <stop offset="0" stopColor="#fff" stopOpacity={0.16} />
          <stop offset="0.55" stopColor="#fff" stopOpacity={0.03} />
          <stop offset="1" stopColor="#000" stopOpacity={0.18} />
        </radialGradient>
      </defs>
      <g ref={confettiRef} />
      <g ref={rootRef}>
        {/* antenna and arms sit behind the head */}
        <path ref={antennaRef} fill="none" stroke={INK} strokeWidth={5} strokeLinecap="round" />
        <g ref={bulbRef}>
          <circle r={8} fill={AMBER} />
          <circle cx={-2.6} cy={-2.8} r={2.4} fill="#fff" opacity={0.75} />
        </g>
        <g ref={armLRef}>
          <rect x={-7} y={-6} width={14} height={32} rx={7} fill={INK} />
        </g>
        <g ref={armRRef}>
          <rect x={-7} y={-6} width={14} height={32} rx={7} fill={INK} />
        </g>
        <circle cx={0} cy={CY} r={R} fill={INK} />
        {/* soft sheen so the head reads as round */}
        <circle cx={0} cy={CY} r={R} fill={`url(#${uid}-sheen)`} />
        <g ref={faceRef} />
        <g ref={dotsRef} opacity={0}>
          <circle cx={44} cy={-44} r={0} fill={INK} />
          <circle cx={58} cy={-58} r={0} fill={INK} />
          <circle cx={75} cy={-75} r={0} fill={INK} />
        </g>
      </g>
    </svg>
  );
});
