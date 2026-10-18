"use client";

/* First-run tour of the room, guided by the mascot.
   A soft scrim with a rounded spotlight on each control ([data-tour="..."]), one short
   line per step, skippable any time (Esc or Skip), replayable from the help button.
   Renders nothing while closed, so it never touches pointer lock or keys then. */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mascot, type MascotHandle, type MascotMotion } from "./mascot/Mascot";
import { Spring } from "./spring";
import { STEPS, availableSteps, findTarget, visibleRect, type TourStep, type TourVariant } from "./steps";
import "./RoomOnboarding.css";

export const ONBOARDED_KEY = "tadaima:onboarded:v1";
export const TOUR_EVENT = "tadaima:tour";

/** Open the tour again from anywhere (the help button uses this). */
export function replayRoomTour() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TOUR_EVENT));
}

function readOnboarded() {
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOnboarded() {
  try {
    window.localStorage.setItem(ONBOARDED_KEY, "1");
  } catch {
    /* private mode: the tour simply shows again next time */
  }
}

/* While the tour is open it gets every keydown first. This listener is added when the module
   loads, ahead of the room's own capture listeners (push to talk loads later), and does nothing
   until a tour is open. */
let keyGuard: ((e: KeyboardEvent) => void) | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => keyGuard?.(e), { capture: true });
}

const subscribeMotion = (cb: () => void) => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const useReducedMotion = () =>
  useSyncExternalStore(subscribeMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => false);

/* ---------- public component ---------- */

type Props = {
  /** Control it yourself. Leave undefined to let it open on first visit and on replayRoomTour(). */
  open?: boolean;
  onClose?: (finished: boolean) => void;
  /** WebXR is available (shows the headset steps). Detected when left undefined. */
  xr?: boolean;
  /** Touch screen. Detected from (pointer: coarse) when left undefined. */
  touch?: boolean;
  /** Open by itself on the first visit. Default true. */
  autoStart?: boolean;
};

export function RoomOnboarding({ open, onClose, xr, touch, autoStart = true }: Props) {
  const controlled = open !== undefined;
  const [selfOpen, setSelfOpen] = useState(false);
  const [run, setRun] = useState(0);
  const [xrDetected, setXrDetected] = useState(false);
  const isOpen = controlled ? open : selfOpen;

  useEffect(() => {
    if (xr !== undefined) return;
    let live = true;
    const nav = navigator as Navigator & { xr?: { isSessionSupported: (mode: string) => Promise<boolean> } };
    nav.xr?.isSessionSupported("immersive-vr").then((ok) => live && setXrDetected(ok)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [xr]);

  // first visit: wait a beat so the room settles in before the tour arrives
  useEffect(() => {
    if (controlled || !autoStart) return;
    const t = window.setTimeout(() => {
      if (readOnboarded()) return;
      setRun((r) => r + 1);
      setSelfOpen(true);
    }, 900);
    return () => window.clearTimeout(t);
  }, [controlled, autoStart]);

  useEffect(() => {
    if (controlled) return;
    const replay = () => {
      setRun((r) => r + 1);
      setSelfOpen(true);
    };
    window.addEventListener(TOUR_EVENT, replay);
    return () => window.removeEventListener(TOUR_EVENT, replay);
  }, [controlled]);

  const done = useCallback(
    (finished: boolean) => {
      writeOnboarded();
      if (!controlled) setSelfOpen(false);
      onClose?.(finished);
    },
    [controlled, onClose],
  );

  if (!isOpen) return null;
  const vr = xr ?? xrDetected;
  return <TourOverlay key={run} vr={vr} touch={touch} onDone={done} />;
}

/** Small round "?" for the top bar. Opens the tour again. */
export function TourHelpButton({ className = "room-x__pill room-tour__help", onClick }: { className?: string; onClick?: () => void }) {
  return (
    <button type="button" className={className} aria-label="Show me around" title="Show me around" onClick={onClick ?? replayRoomTour}>
      <span aria-hidden="true">?</span>
    </button>
  );
}

/* ---------- layout ---------- */

type Point = { x: number; y: number };
type Hole = { x: number; y: number; w: number; h: number; r: number };
type Layout = { mascot: Point; card: Point; hole: Hole | null; centre: Point };

const EDGE = 16;
const GAP = 14;
const PAD = 8;

function holeFor(el: HTMLElement, r: DOMRect): Hole {
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 12;
  const h = r.height + PAD * 2;
  return { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h, r: Math.min(h / 2, radius + PAD) };
}

function layoutFor(el: HTMLElement | null, rect: DOMRect | null, cw: number, ch: number, m: number, vw: number, vh: number): Layout {
  const narrow = vw < 600;
  // the group is the mascot beside the card, or perched on top of it on narrow screens
  const gw = narrow ? cw : m + 6 + cw;
  const gh = narrow ? ch + m * 0.78 : Math.max(m, ch);
  const place = (gx: number, gy: number, mascotFirst: boolean): Omit<Layout, "hole" | "centre"> => {
    if (narrow) {
      const mx = mascotFirst ? gx + m * 0.5 + 6 : gx + cw - m * 0.5 - 6;
      return { mascot: { x: mx, y: gy + m * 0.5 }, card: { x: gx, y: gy + m * 0.78 } };
    }
    const cy = gy + (gh - ch) / 2;
    const my = gy + gh / 2;
    return mascotFirst
      ? { mascot: { x: gx + m / 2, y: my }, card: { x: gx + m + 6, y: cy } }
      : { mascot: { x: gx + cw + 6 + m / 2, y: my }, card: { x: gx, y: cy } };
  };
  const centred = (): Layout => {
    const gx = (vw - gw) / 2;
    const gy = Math.max(EDGE, (vh - gh) / 2 - vh * 0.04);
    return { ...place(gx, gy, true), hole: null, centre: { x: vw / 2, y: gy + gh / 2 } };
  };
  if (!el || !rect) return centred();

  const hole = holeFor(el, rect);
  const tx = hole.x + hole.w / 2;
  const ty = hole.y + hole.h / 2;
  const clampX = (x: number) => Math.min(Math.max(x, EDGE), vw - gw - EDGE);
  const clampY = (y: number) => Math.min(Math.max(y, EDGE), vh - gh - EDGE);
  const fits = (gx: number, gy: number) => gx >= EDGE - 0.5 && gy >= EDGE - 0.5 && gx + gw <= vw - EDGE + 0.5 && gy + gh <= vh - EDGE + 0.5;
  const options: { gx: number; gy: number; first: boolean }[] = [];
  const above = { gx: clampX(tx - gw / 2), gy: hole.y - GAP - gh };
  const below = { gx: clampX(tx - gw / 2), gy: hole.y + hole.h + GAP };
  const nearFirst = (gx: number) => tx < gx + gw / 2;
  const vertical = ty > vh / 2 ? [above, below] : [below, above];
  for (const v of vertical) options.push({ ...v, first: nearFirst(v.gx) });
  if (!narrow) {
    options.push({ gx: hole.x - GAP - gw, gy: clampY(ty - gh / 2), first: false });
    options.push({ gx: hole.x + hole.w + GAP, gy: clampY(ty - gh / 2), first: true });
  }
  const pick = options.find((o) => fits(o.gx, o.gy));
  if (!pick) return { ...centred(), hole };
  return { ...place(pick.gx, pick.gy, pick.first), hole, centre: { x: tx, y: ty } };
}

/* ---------- the overlay ---------- */

type Flight = { from: Point; to: Point; p: Spring; landed: boolean };

function arcPoint(f: Flight, p: number): Point {
  const { from: a, to: b } = f;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const bulge = Math.min(len * 0.32, 150);
  const c = { x: (a.x + b.x) / 2 + nx * bulge, y: (a.y + b.y) / 2 + ny * bulge - 24 };
  if (p > 1) {
    // overshoot keeps going along the arc's landing tangent, then the spring brings it back
    const k = p - 1;
    return { x: b.x + 2 * (b.x - c.x) * k, y: b.y + 2 * (b.y - c.y) * k };
  }
  const u = 1 - p;
  return { x: u * u * a.x + 2 * u * p * c.x + p * p * b.x, y: u * u * a.y + 2 * u * p * c.y + p * p * b.y };
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function TourOverlay({ vr, touch, onDone }: { vr: boolean; touch?: boolean; onDone: (finished: boolean) => void }) {
  const reduced = useReducedMotion();
  const [variant] = useState<TourVariant>(() => (vr ? "vr" : (touch ?? window.matchMedia("(pointer: coarse)").matches) ? "touch" : "web"));
  const [steps, setSteps] = useState<TourStep[]>(() => availableSteps(variant));
  const [mac] = useState(isMac);
  const [index, setIndex] = useState(0);
  const [landed, setLanded] = useState(-1);
  const [closing, setClosing] = useState(false);
  const ids = useId();
  const maskId = `${ids.replace(/[^a-zA-Z0-9]/g, "")}-mask`;

  const holeRef = useRef<SVGRectElement>(null);
  const dimRef = useRef<SVGRectElement>(null);
  const ringRef = useRef<SVGRectElement>(null);
  const pulseRef = useRef<SVGRectElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const mascotRef = useRef<MascotHandle>(null);
  const motion = useRef<MascotMotion>({ vx: 0, vy: 0 });
  const aim = useRef<Point | null>(null);
  const [narrowMascot] = useState(() => window.innerWidth < 600);
  const M = narrowMascot ? 88 : 112;

  const step = steps[Math.min(index, steps.length - 1)];
  const last = index >= steps.length - 1;
  const shown = landed === index && !closing;

  const live = useRef({ index, steps, reduced, M });
  useLayoutEffect(() => {
    live.current = { index, steps, reduced, M };
  });

  const finish = useCallback(
    (finished: boolean) => {
      if (closing) return;
      setClosing(true);
      window.setTimeout(() => onDone(finished), reduced ? 120 : 280);
    },
    [closing, onDone, reduced],
  );

  const go = useCallback(
    (dir: 1 | -1) => {
      // controls come and go (push to talk loads late, the inventory empties), so look again
      const all = STEPS[variant];
      const here = all.findIndex((s) => s.id === steps[index]?.id);
      let n = here + dir;
      while (n >= 0 && n < all.length && all[n].optional && !visibleRect(findTarget(all[n].target))) n += dir;
      if (n >= all.length) {
        finish(true);
        return;
      }
      if (n < 0) return;
      // all[n] is required or on screen, so it is always in this list
      const next = availableSteps(variant);
      setSteps(next);
      setIndex(next.indexOf(all[n]));
    },
    [index, steps, variant, finish],
  );

  /* --- keys: Esc skips, arrows and Enter step through, everything else stays out of the room --- */
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    keyRef.current = (e: KeyboardEvent) => {
      // nothing reaches the room while the tour is up; Tab still moves focus (its default), it just can't grab the cursor
      e.stopImmediatePropagation();
      if (e.key === "Tab") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const onButton = e.target instanceof Element && e.target.closest(".room-tour__card button");
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "ArrowRight" || (e.key === "Enter" && !onButton)) {
        e.preventDefault();
        if (!e.repeat) go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (!e.repeat) go(-1);
      } else if (e.key === " " && !onButton) {
        e.preventDefault();
      }
    };
  });
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keyGuard = (e) => keyRef.current(e);
    if (document.pointerLockElement) document.exitPointerLock();
    document.documentElement.dataset.roomTour = "open";
    return () => {
      keyGuard = null;
      delete document.documentElement.dataset.roomTour;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  // focus follows the card so keyboard and screen reader users land on it
  useEffect(() => {
    if (shown) nextRef.current?.focus({ preventScroll: true });
  }, [shown]);

  /* --- one frame loop for flight, spotlight and card placement --- */
  useEffect(() => {
    const vw0 = window.innerWidth;
    const vh0 = window.innerHeight;
    const pos: Point = { x: vw0 + 90, y: vh0 * 0.72 };
    const prev: Point = { ...pos };
    const sx = new Spring(pos.x, { stiffness: 210, ratio: 1 });
    const sy = new Spring(pos.y, { stiffness: 210, ratio: 1 });
    const spot = { stiffness: 150, ratio: 0.88 };
    const hx = new Spring(vw0 / 2, spot);
    const hy = new Spring(vh0 / 2, spot);
    const hw = new Spring(0, spot);
    const hh = new Spring(0, spot);
    const hr = new Spring(16, spot);
    const dim = new Spring(0, { stiffness: 90, ratio: 1 });
    const ring = new Spring(0, { stiffness: 120, ratio: 1 });
    let flight: Flight | null = null;
    let seen = -1;
    let launchAt = -1;
    let fadeAt = -1;
    let first = true;
    let clock = 0;
    let lastTs = 0;
    let raf = 0;

    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      const dt = lastTs ? Math.min((ts - lastTs) / 1000, 0.1) : 1 / 60;
      lastTs = ts;
      clock += dt;
      const { index: i, steps: list, reduced: still, M: size } = live.current;
      const s = list[Math.min(i, list.length - 1)];
      if (!s) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const el = s.target === "room" ? null : findTarget(s.target);
      const rect = visibleRect(el);
      const card = cardRef.current;
      const layout = layoutFor(el, rect, card?.offsetWidth ?? 320, card?.offsetHeight ?? 160, size, vw, vh);
      const wrap = wrapRef.current;

      /* new step: crouch, then take off (or just fade across when motion is reduced) */
      if (i !== seen) {
        seen = i;
        flight = null;
        if (still) {
          fadeAt = clock;
          if (wrap) wrap.style.opacity = "0";
        } else {
          launchAt = clock;
          if (!first) mascotRef.current?.squash(5);
        }
      }

      if (still) {
        if (fadeAt >= 0 && clock - fadeAt > (first ? 0.05 : 0.18)) {
          fadeAt = -1;
          first = false;
          pos.x = layout.mascot.x;
          pos.y = layout.mascot.y;
          sx.snap(pos.x);
          sy.snap(pos.y);
          if (wrap) wrap.style.opacity = "1";
          setLanded(i);
        } else if (fadeAt < 0) {
          sx.target = layout.mascot.x;
          sy.target = layout.mascot.y;
          pos.x = sx.step(dt);
          pos.y = sy.step(dt);
        }
      } else {
        if (launchAt >= 0 && clock - launchAt >= (first ? 0 : 0.13)) {
          launchAt = -1;
          first = false;
          const p = new Spring(0, { stiffness: 52, ratio: 0.66 });
          p.target = 1;
          flight = { from: { ...pos }, to: layout.mascot, p, landed: false };
          mascotRef.current?.squash(-4);
        }
        if (flight) {
          flight.to = layout.mascot;
          const p = flight.p.step(dt);
          const at = arcPoint(flight, p);
          pos.x = at.x;
          pos.y = at.y;
          if (!flight.landed && p >= 0.985) {
            flight.landed = true;
            mascotRef.current?.squash(6);
            setLanded(i);
          }
          if (flight.landed && flight.p.settled(0.002)) {
            sx.snap(pos.x);
            sy.snap(pos.y);
            flight = null;
          }
        } else if (launchAt < 0) {
          sx.target = layout.mascot.x;
          sy.target = layout.mascot.y;
          pos.x = sx.step(dt);
          pos.y = sy.step(dt);
        }
      }

      // velocity for squash, stretch and lag, lightly smoothed
      const k = 1 - Math.exp(-dt * 30);
      motion.current.vx += ((pos.x - prev.x) / dt - motion.current.vx) * k;
      motion.current.vy += ((pos.y - prev.y) / dt - motion.current.vy) * k;
      prev.x = pos.x;
      prev.y = pos.y;
      const ax = layout.centre.x - pos.x;
      const ay = layout.centre.y - pos.y;
      const al = Math.hypot(ax, ay);
      aim.current = layout.hole && al > 1 ? { x: ax / al, y: ay / al } : null;

      if (wrap) wrap.style.transform = `translate3d(${(pos.x - size / 2).toFixed(1)}px, ${(pos.y - size / 2).toFixed(1)}px, 0)`;
      if (card) card.style.transform = `translate3d(${Math.round(layout.card.x)}px, ${Math.round(layout.card.y)}px, 0)`;

      /* spotlight: springs between targets, collapses into the card when there is none */
      const h = layout.hole;
      hx.target = h ? h.x : layout.centre.x;
      hy.target = h ? h.y : layout.centre.y;
      hw.target = h ? h.w : 0;
      hh.target = h ? h.h : 0;
      hr.target = h ? h.r : 0;
      dim.target = h ? 0.5 : 0.22;
      ring.target = h ? 1 : 0;
      for (const sp of [hx, hy, hw, hh, hr, dim, ring]) {
        if (still) sp.snap(sp.target);
        else sp.step(dt);
      }
      const w = Math.max(0, hw.value);
      const hgt = Math.max(0, hh.value);
      const rad = Math.max(0, Math.min(hr.value, w / 2, hgt / 2));
      for (const r of [holeRef.current, ringRef.current]) {
        if (!r) continue;
        r.setAttribute("x", hx.value.toFixed(1));
        r.setAttribute("y", hy.value.toFixed(1));
        r.setAttribute("width", w.toFixed(1));
        r.setAttribute("height", hgt.toFixed(1));
        r.setAttribute("rx", rad.toFixed(1));
      }
      dimRef.current?.setAttribute("fill-opacity", Math.max(0, dim.value).toFixed(3));
      ringRef.current?.setAttribute("opacity", Math.max(0, ring.value).toFixed(3));
      const pulse = pulseRef.current;
      if (pulse) {
        const t = (clock % 2.4) / 2.4;
        const grow = still ? 0 : (1 - (1 - t) ** 3) * 12;
        pulse.setAttribute("x", (hx.value - grow).toFixed(1));
        pulse.setAttribute("y", (hy.value - grow).toFixed(1));
        pulse.setAttribute("width", (w + grow * 2).toFixed(1));
        pulse.setAttribute("height", (hgt + grow * 2).toFixed(1));
        pulse.setAttribute("rx", (rad + grow).toFixed(1));
        pulse.setAttribute("opacity", (still ? 0 : (1 - t) * 0.55 * Math.max(0, ring.value)).toFixed(3));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!step) return null;
  const titleId = `${ids}-title`;
  const bodyId = `${ids}-body`;
  const keys = step.keys?.map((k) => (k === "Ctrl Z" && mac ? "⌘ Z" : k));
  const gesture = landed === index ? step.gesture : "idle";

  return (
    <div className="room-tour" data-closing={closing || undefined} data-variant={variant}>
      <svg className="room-tour__scrim" aria-hidden="true" onPointerDown={(e) => e.preventDefault()}>
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="#fff" />
            <rect ref={holeRef} fill="#000" />
          </mask>
        </defs>
        <rect ref={dimRef} width="100%" height="100%" fill="#1a1008" fillOpacity={0} mask={`url(#${maskId})`} />
        <rect ref={pulseRef} className="room-tour__pulse" fill="none" />
        <rect ref={ringRef} className="room-tour__ring" fill="none" opacity={0} />
      </svg>

      <div ref={wrapRef} className="room-tour__mascot" style={{ width: M, height: M }}>
        <Mascot ref={mascotRef} gesture={gesture} aim={aim} motion={motion} reducedMotion={reduced} size={M} />
      </div>

      <div
        ref={cardRef}
        className="room-tour__card"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-show={shown || undefined}
      >
        <div className="room-tour__card-inner">
          <div className="room-tour__top">
            <ol className="room-tour__dots" aria-label={`Step ${index + 1} of ${steps.length}`}>
              {steps.map((s, n) => (
                <li key={s.id} data-on={n === index || undefined} data-done={n < index || undefined} />
              ))}
            </ol>
            <button type="button" className="room-tour__skip" onClick={() => finish(false)}>
              Skip
            </button>
          </div>
          <h2 id={titleId} className="room-tour__title">
            {step.title}
          </h2>
          <p id={bodyId} className="room-tour__body">
            {step.body}
          </p>
          <div className="room-tour__foot">
            {keys?.length ? (
              <div className="room-tour__keys" aria-label="Keys">
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </div>
            ) : null}
            <div className="room-tour__nav">
              {index > 0 ? (
                <button type="button" className="room-tour__back" onClick={() => go(-1)}>
                  Back
                </button>
              ) : null}
              <button ref={nextRef} type="button" className="room-tour__next" onClick={() => go(1)}>
                {last ? "Let’s go" : "Next"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
