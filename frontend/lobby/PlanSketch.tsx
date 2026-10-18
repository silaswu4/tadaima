"use client";
// The studio's floorplan, drawn like an architect's sketch in step with the lobby's logs: the walls trace in,
// it gets its dimensions, the door and window cut their gaps, the furniture fades in, then the plan tips into
// an isometric view while the walls rise (stacked outlines in CSS 3D) and window light falls across the floor.
import gsap from "gsap";
import { useId, useLayoutEffect, useRef } from "react";
import { PLAN_ORDER, STUDIO, type PlanPhase } from "./stages";

// plan units are centimeters; the viewBox leaves room for the dimension lines
const U = 100;
const W = STUDIO.width * U;
const D = STUDIO.depth * U;
const T = STUDIO.wallThickness * U;
const PAD = 64;
const VIEW = `${-PAD} ${-PAD} ${W + PAD * 2} ${D + PAD * 2}`;

// openings along x (both walls run horizontally in the plan)
const door = { x0: (STUDIO.door.from[0] - STUDIO.door.offset - STUDIO.door.width) * U, x1: (STUDIO.door.from[0] - STUDIO.door.offset) * U, z: D };
const win = { x0: STUDIO.window.offset * U, x1: (STUDIO.window.offset + STUDIO.window.width) * U, z: 0 };
const DOOR_TOP = 2.1;
const RISE_LAYERS = 6;
/** On screen, how tall the raised walls stand (px). Kept short so the sketch stays a sketch. */
const RISE_PX = 64;

/** Which openings are cut through the wall at a given height (m). Layer 0 is the plan's cut line. */
function cutsAt(h: number | null) {
  if (h == null) return { door: true, window: true };
  return { door: h < DOOR_TOP, window: h > STUDIO.window.sill && h < STUDIO.window.sill + STUDIO.window.tall };
}

const rectPath = (x: number, y: number, w: number, h: number) => `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
const OUTER = rectPath(-T, -T, W + 2 * T, D + 2 * T);
const INNER = rectPath(0, 0, W, D);

function WallLayer({ id, height, traced }: { id: string; height: number | null; traced?: boolean }) {
  const cut = cutsAt(height);
  return (
    <svg className={`plan-sketch__layer${traced ? " is-base" : " is-rise"}`} viewBox={VIEW} aria-hidden="true">
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x={-PAD} y={-PAD} width={W + PAD * 2} height={D + PAD * 2}>
          <rect x={-PAD} y={-PAD} width={W + PAD * 2} height={D + PAD * 2} fill="#fff" />
          {cut.door ? <rect className="plan-gap plan-gap--door" x={door.x0} y={D - 4} width={door.x1 - door.x0} height={T + 8} fill="#000" /> : null}
          {cut.window ? <rect className="plan-gap plan-gap--window" x={win.x0} y={-T - 4} width={win.x1 - win.x0} height={T + 8} fill="#000" /> : null}
        </mask>
      </defs>
      <g mask={`url(#${id})`}>
        <path className="plan-wall plan-wall--outer" d={OUTER} pathLength={1} />
        <path className="plan-wall plan-wall--inner" d={INNER} pathLength={1} />
      </g>
    </svg>
  );
}

export default function PlanSketch({ phase, reduced }: { phase: PlanPhase; reduced: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const shown = useRef(0);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const target = reduced ? PLAN_ORDER.length - 1 : PLAN_ORDER.indexOf(phase);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const q = gsap.utils.selector(el);
    const from = shown.current;
    shown.current = Math.max(from, target);
    // first paint: everything not yet reached is hidden
    if (from === 0) {
      gsap.set(q(".plan-wall"), { strokeDasharray: 1, strokeDashoffset: 1 });
      gsap.set(q(".plan-gap"), { scaleX: 0, transformOrigin: "50% 50%", transformBox: "fill-box" });
      gsap.set(q(".plan-dim, .plan-door, .plan-window, .plan-item, .plan-light, .plan-sketch__layer.is-rise"), { autoAlpha: 0 });
    }
    const instant = reduced;
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    const at = (name: PlanPhase) => {
      const i = PLAN_ORDER.indexOf(name);
      return i > from && i <= target;
    };
    if (at("walls")) {
      tl.to(q(".is-base .plan-wall--outer"), { strokeDashoffset: 0, duration: instant ? 0 : 1.6, ease: "power2.inOut" }, 0).to(
        q(".is-base .plan-wall--inner"),
        { strokeDashoffset: 0, duration: instant ? 0 : 1.6, ease: "power2.inOut" },
        instant ? 0 : 0.25,
      );
      // the risen layers share the outline, fully drawn, hidden until the walls go up
      gsap.set(q(".is-rise .plan-wall"), { strokeDashoffset: 0 });
    }
    if (at("measured")) tl.to(q(".plan-dim"), { autoAlpha: 1, duration: instant ? 0 : 0.6, stagger: instant ? 0 : 0.15 }, 0);
    if (at("door")) {
      tl.to(q(".plan-gap--door"), { scaleX: 1, duration: instant ? 0 : 0.6, ease: "power3.inOut" }, 0).to(
        q(".plan-door"),
        { autoAlpha: 1, duration: instant ? 0 : 0.5 },
        instant ? 0 : 0.35,
      );
    }
    if (at("window")) {
      tl.to(q(".plan-gap--window"), { scaleX: 1, duration: instant ? 0 : 0.7, ease: "power3.inOut" }, 0).to(
        q(".plan-window"),
        { autoAlpha: 1, duration: instant ? 0 : 0.5 },
        instant ? 0 : 0.4,
      );
    }
    if (at("furniture")) {
      tl.fromTo(
        q(".plan-item"),
        { autoAlpha: 0, scale: instant ? 1 : 0.94, transformOrigin: "50% 50%", transformBox: "fill-box" },
        { autoAlpha: 1, scale: 1, duration: instant ? 0 : 0.7, stagger: instant ? 0 : 0.25 },
        0,
      );
    }
    if (at("raised")) {
      const layers = q(".plan-sketch__layer.is-rise");
      if (instant) {
        // reduced motion keeps the plan flat and complete: no tilt, no rise
      } else {
        tl.to(q(".plan-sketch__tilt"), { rotateX: 56, rotateZ: -34, scale: 0.8, y: 18, duration: 1.4, ease: "power3.inOut" }, 0)
          .set(layers, { autoAlpha: 1 }, 0.5)
          .fromTo(
            layers,
            { z: 0 },
            { z: (i: number) => ((i + 1) / RISE_LAYERS) * RISE_PX, duration: 1.1, ease: "power3.out", stagger: 0.03 },
            0.5,
          );
      }
    }
    if (at("lit")) tl.to(q(".plan-light"), { autoAlpha: 1, duration: instant ? 0 : 1.2, ease: "power2.out" }, 0);
    // no cleanup on purpose: a phase that lands mid-animation lets the last one finish its move
  }, [target, reduced]);

  const lightId = `${uid}-light`;
  const gridId = `${uid}-grid`;
  return (
    <div className="plan-sketch" ref={root} data-phase={reduced ? "lit" : phase}>
      <div className="plan-sketch__tilt">
        <svg className="plan-sketch__layer plan-sketch__floor" viewBox={VIEW} role="img" aria-label={`Floorplan, ${STUDIO.width} by ${STUDIO.depth} meters`}>
          <defs>
            <pattern id={gridId} width={50} height={50} patternUnits="userSpaceOnUse" x={0} y={0}>
              <path d="M50 0H0V50" className="plan-grid" />
            </pattern>
            <linearGradient id={lightId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#f0b64c" stopOpacity=".42" />
              <stop offset="1" stopColor="#f0b64c" stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect x={-PAD} y={-PAD} width={W + PAD * 2} height={D + PAD * 2} fill={`url(#${gridId})`} className="plan-paper" />
          <path className="plan-outline" d={OUTER} />
          <polygon className="plan-light" points={`${win.x0},0 ${win.x1},0 ${W - 30},${D - 20} ${60},${D - 20}`} fill={`url(#${lightId})`} />

          {/* dimensions */}
          <g className="plan-dim">
            <path className="plan-dim__line" d={`M0 ${-T - 26}H${W}M0 ${-T - 32}V${-T - 20}M${W} ${-T - 32}V${-T - 20}`} />
            <text className="plan-label" x={W / 2} y={-T - 34} textAnchor="middle">
              {STUDIO.width} m
            </text>
          </g>
          <g className="plan-dim">
            <path className="plan-dim__line" d={`M${-T - 26} 0V${D}M${-T - 32} 0H${-T - 20}M${-T - 32} ${D}H${-T - 20}`} />
            <text className="plan-label" x={-T - 34} y={D / 2} textAnchor="middle" transform={`rotate(-90 ${-T - 34} ${D / 2})`}>
              {STUDIO.depth} m
            </text>
          </g>

          {/* the entry door: leaf swung open into the room, and its arc */}
          <g className="plan-door">
            <path className="plan-ink" d={`M${door.x1} ${D}V${D - (door.x1 - door.x0)}`} />
            <path className="plan-ink plan-ink--soft" d={`M${door.x0} ${D}A${door.x1 - door.x0} ${door.x1 - door.x0} 0 0 1 ${door.x1} ${D - (door.x1 - door.x0)}`} />
          </g>
          {/* the window: glass lines across the gap */}
          <g className="plan-window">
            <path className="plan-ink" d={`M${win.x0} ${-T}V0M${win.x1} ${-T}V0`} />
            <path className="plan-glass" d={`M${win.x0} ${-T / 2 - 2.5}H${win.x1}M${win.x0} ${-T / 2 + 2.5}H${win.x1}`} />
          </g>

          {/* furniture, as seen in the listing photo */}
          {STUDIO.items.map((it) => {
            const x = (it.x - it.w / 2) * U;
            const z = (it.z - it.d / 2) * U;
            const w = it.w * U;
            const d = it.d * U;
            const sofa = it.id === "sofa";
            return (
              <g key={it.id} className={`plan-item plan-item--${it.id}`}>
                <rect className="plan-item__body" x={x} y={z} width={w} height={d} rx={sofa ? 9 : 4} />
                {sofa ? (
                  <path className="plan-ink plan-ink--soft" d={`M${x + 20} ${z + 16}V${z + d - 16}M${x} ${z + 16}H${x + w}M${x} ${z + d - 16}H${x + w}`} />
                ) : null}
                <text
                  className="plan-label plan-label--item"
                  x={x + w / 2 + (sofa ? 10 : 0)}
                  y={z + d / 2}
                  textAnchor="middle"
                  dominantBaseline="central"
                  transform={sofa ? `rotate(-90 ${x + w / 2 + 10} ${z + d / 2})` : undefined}
                >
                  {it.label}
                </text>
              </g>
            );
          })}
        </svg>
        <WallLayer id={`${uid}-w0`} height={null} traced />
        {Array.from({ length: RISE_LAYERS }, (_, i) => (
          <WallLayer key={i} id={`${uid}-w${i + 1}`} height={((i + 1) / RISE_LAYERS) * STUDIO.height} />
        ))}
      </div>
      <p className="plan-wait">
        <span>The plan draws here once the agent finds it</span>
      </p>
    </div>
  );
}
