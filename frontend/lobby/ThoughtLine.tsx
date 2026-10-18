"use client";
// ThoughtLine (React Bits), ported from gist's components/gist/thought/ThoughtLine.tsx: a breathing "working"
// line with a shimmer and a timer, a trace of steps beneath that land one by one, settling into "done in Ns".
// Reimplemented with GSAP and CSS (no motion/react, no icon pack) and restyled for the tadaima landing.
import gsap from "gsap";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const fmt = (ds: number) => (ds < 600 ? `${(ds / 10).toFixed(1)}s` : `${Math.floor(ds / 600)}m ${((ds % 600) / 10).toFixed(1)}s`);
const spoken = (ds: number) => (ds < 600 ? `${(ds / 10).toFixed(1)} seconds` : `${Math.floor(ds / 600)} minutes ${((ds % 600) / 10).toFixed(1)} seconds`);
const GLYPH_DONE = 0.55;

/** A four point sparkle, drawn inline. */
export function Sparkle({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.2c.5 3.9 1.9 6.3 4.3 7.4 1 .5 2.3.8 3.9 1-1.6.2-2.9.5-3.9 1-2.4 1.1-3.8 3.5-4.3 7.4-.5-3.9-1.9-6.3-4.3-7.4-1-.5-2.3-.8-3.9-1 1.6-.2 2.9-.5 3.9-1 2.4-1.1 3.8-3.5 4.3-7.4Z"
        fill="currentColor"
      />
      <path d="M19 2.8c.18 1.3.62 2 1.6 2.3-.98.3-1.42 1-1.6 2.3-.18-1.3-.62-2-1.6-2.3.98-.3 1.42-1 1.6-2.3Z" fill="currentColor" opacity=".7" />
    </svg>
  );
}

function Tick() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8.4 6.4 11.2 12.5 4.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 6.5 8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface ThoughtLineProps {
  label: string;
  doneLabel: string;
  steps: string[];
  working: boolean;
  /** fold the trace away once it settles (it can be opened again) */
  collapseOnSettle?: boolean;
  fontSize?: number;
  breathPeriod?: number;
  breathDepth?: number;
  reduced?: boolean;
  className?: string;
  style?: CSSProperties;
}

export default function ThoughtLine({
  label,
  doneLabel,
  steps,
  working,
  collapseOnSettle = true,
  fontSize = 14,
  breathPeriod = 1.6,
  breathDepth = 0.45,
  reduced = false,
  className = "",
  style,
}: ThoughtLineProps) {
  const [open, setOpen] = useState(true);
  const hasTrace = steps.length > 0;
  const depth = reduced ? Math.min(breathDepth, 0.2) : breathDepth;
  const period = reduced ? breathPeriod * 1.5 : breathPeriod;
  const trough = 1 - depth;
  const sheen = !reduced;

  const glyphRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<HTMLSpanElement>(null);
  const stackRef = useRef<HTMLSpanElement>(null);
  const workRef = useRef<HTMLSpanElement>(null);
  const doneRef = useRef<HTMLSpanElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);
  const dsRef = useRef(0);
  const prevWorking = useRef(working);
  const [announce, setAnnounce] = useState(label);

  // open while working, fold away when it settles
  useEffect(() => {
    const t = window.setTimeout(() => setOpen(working || !collapseOnSettle), working ? 0 : 500);
    return () => window.clearTimeout(t);
  }, [working, collapseOnSettle]);

  // the glyph breathes while it works and dims once it lands
  useEffect(() => {
    const g = glyphRef.current;
    if (!g) return;
    const tweens: gsap.core.Animation[] = [];
    if (working) {
      tweens.push(
        gsap
          .timeline({ repeat: -1 })
          .to(g, { opacity: trough, duration: period / 2, ease: "power3.inOut" })
          .to(g, { opacity: 1, duration: period / 2, ease: "power3.inOut" }),
      );
      if (!reduced) tweens.push(gsap.to(g, { rotate: "+=360", duration: 7, ease: "none", repeat: -1 }));
    } else {
      tweens.push(gsap.to(g, { opacity: GLYPH_DONE, rotate: 0, duration: 0.35, ease: "power3.out" }));
    }
    return () => tweens.forEach((t) => t.kill());
  }, [working, period, trough, reduced]);

  // the timer counts while it works and freezes on the settle
  useLayoutEffect(() => {
    if (!working) return;
    const paint = (ds: number) => {
      dsRef.current = ds;
      if (timerRef.current) timerRef.current.textContent = fmt(ds);
    };
    const startedAt = performance.now();
    paint(0);
    const id = window.setInterval(() => paint(Math.floor((performance.now() - startedAt) / 100)), 100);
    return () => window.clearInterval(id);
  }, [working]);

  // the timer glides to sit right after whichever label is showing
  useLayoutEffect(() => {
    const t = timerRef.current;
    const stack = stackRef.current;
    if (!t || !stack) return;
    const place = (glide: boolean) => {
      const active = working ? workRef.current : doneRef.current;
      if (!active) return;
      const shift = active.offsetWidth - stack.offsetWidth;
      if (glide && !reduced) gsap.to(t, { x: shift, duration: 0.35, ease: "power3.inOut" });
      else gsap.set(t, { x: shift });
    };
    place(prevWorking.current !== working);
    prevWorking.current = working;
    const ro = new ResizeObserver(() => place(false));
    if (workRef.current) ro.observe(workRef.current);
    if (doneRef.current) ro.observe(doneRef.current);
    return () => ro.disconnect();
  }, [working, label, doneLabel, reduced]);

  // each new step drops in under the last
  const shownSteps = useRef(0);
  useLayoutEffect(() => {
    const el = stepsRef.current;
    if (!el) return;
    const rows = Array.from(el.children) as HTMLElement[];
    const fresh = rows.slice(Math.min(shownSteps.current, rows.length));
    shownSteps.current = rows.length;
    if (!fresh.length || reduced) return;
    gsap.fromTo(fresh, { opacity: 0, y: -4 }, { opacity: 1, y: 0, duration: 0.3, ease: "power3.out", stagger: 0.04 });
  }, [steps, reduced]);

  useEffect(() => {
    // announcements only: the screen reader hears the label and the settle, not every timer tick
    setAnnounce(working ? label : `${doneLabel} ${spoken(dsRef.current)}`);
  }, [working, label, doneLabel]);

  return (
    <div
      className={`thought-line${className ? ` ${className}` : ""}`}
      data-working={working ? "" : undefined}
      data-open={open && hasTrace ? "" : undefined}
      style={{ "--tl-font": `${fontSize}px`, ...style } as CSSProperties}
    >
      <button
        type="button"
        className="thought-line__head"
        data-toggle={hasTrace ? "" : undefined}
        aria-expanded={hasTrace ? open : undefined}
        tabIndex={hasTrace && !working ? 0 : -1}
        onClick={() => hasTrace && !working && setOpen((v) => !v)}
      >
        <span ref={glyphRef} className="thought-line__glyph" aria-hidden="true">
          <Sparkle />
        </span>
        <span ref={stackRef} className="thought-line__label" aria-hidden="true">
          <span ref={workRef} className="thought-line__text" data-active={working ? "" : undefined}>
            <span className="thought-line__breath" data-shimmer={sheen ? "" : undefined}>
              {label}
            </span>
          </span>
          <span ref={doneRef} className="thought-line__text thought-line__text--done" data-active={working ? undefined : ""}>
            {doneLabel}
          </span>
        </span>
        <span ref={timerRef} className="thought-line__timer" data-done={working ? undefined : ""} aria-hidden="true">
          0.0s
        </span>
        <span className="thought-line__chevron" data-on={hasTrace && !working ? "" : undefined} aria-hidden="true">
          <Chevron />
        </span>
        <span className="thought-line__sr" role="status">
          {announce}
        </span>
      </button>
      {hasTrace ? (
        <div className="thought-line__trace" data-open={open ? "" : undefined} aria-hidden={!open}>
          <div className="thought-line__fold">
            <div className="thought-line__steps" ref={stepsRef}>
              {steps.map((text, i) => {
                const done = !working || i < steps.length - 1;
                return (
                  <div key={`${i}-${text}`} className="thought-line__step" data-done={done ? "" : undefined}>
                    <span className="thought-line__mark" aria-hidden="true">
                      {done ? <Tick /> : <i className="thought-line__pulse" />}
                    </span>
                    <span className="thought-line__step-text">{text}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
