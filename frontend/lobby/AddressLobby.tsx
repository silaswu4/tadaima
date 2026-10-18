"use client";
// The "Find your floorplan" lobby: after the shopper types an address, the landing swipes away and this
// timeline plays over the dimmed hero. One node per stage, each with its own thought line; the browse stage
// shows a live browser; the floorplan sketches itself alongside. Ported from gist's PipelineTimeline
// (components/gist/pipeline), rebuilt with GSAP and CSS for tadaima. When the last stage lands it holds a
// beat and calls onExit once; the page wipes to the room from there.
import gsap from "gsap";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties } from "react";
import mark from "@/spatial/assets/tadaima-mark.png";
import BrowserFrame from "./BrowserFrame";
import DecryptedText from "./DecryptedText";
import PlanSketch from "./PlanSketch";
import ThoughtLine, { Sparkle } from "./ThoughtLine";
import Waves from "./Waves";
import { DEMO_BUILDING, DEMO_UNIT, PLAN_ORDER, STAGES, STUDIO, STUDIO_SQFT, shortAddress, type StageDef } from "./stages";
import { stopLiveBrowse, useLobbyRun, type LobbyState, type StageRun } from "./useLobbyRun";
import "./lobby.css";

/** How long the "ready" node holds before the wipe. */
const DONE_BEAT_MS = 1300;

export default function AddressLobby({ address, reduced, onExit }: { address: string; reduced: boolean; onExit: () => void }) {
  const run = useLobbyRun(address, { reduced });
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<HTMLOListElement>(null);
  const exited = useRef(false);
  const exitRef = useRef(onExit);
  useEffect(() => {
    exitRef.current = onExit;
  }, [onExit]);

  const exit = useCallback(() => {
    if (exited.current) return;
    exited.current = true;
    stopLiveBrowse();
    exitRef.current();
  }, []);

  // the lobby rises in as the landing finishes swiping away
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const q = gsap.utils.selector(el);
    const ctx = gsap.context(() => {
      if (reduced) {
        gsap.set(q(".lobby-scrim"), { autoAlpha: 1 });
        return;
      }
      gsap
        .timeline()
        .fromTo(q(".lobby-scrim"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 1.1, ease: "power2.out" }, 0.15)
        .fromTo(q(".lobby-waves"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 1.6, ease: "power2.out" }, 0.6)
        .fromTo(
          q(".lobby-head > *, .lobby-plan, .lobby-skip"),
          { y: 22, autoAlpha: 0 },
          { y: 0, autoAlpha: 1, duration: 0.9, ease: "power3.out", stagger: 0.08 },
          0.7,
        );
    }, el);
    return () => ctx.revert();
  }, [reduced]);

  // Esc skips straight to the room
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && exit();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exit]);

  // the last stage landed: hold the "ready" beat, then go
  useEffect(() => {
    if (!run.finished) return;
    const t = window.setTimeout(exit, reduced ? 600 : DONE_BEAT_MS);
    return () => window.clearTimeout(t);
  }, [run.finished, reduced, exit]);

  // ---- the spine grows down to the newest node, and the view follows it ----
  const shownCount = run.revealed.length + (run.finished ? 1 : 0);
  const measure = useCallback(() => {
    const tl = tlRef.current;
    if (!tl) return;
    const icons = tl.querySelectorAll<HTMLElement>(".lobby-node__icon");
    const last = icons[icons.length - 1];
    const top = tl.getBoundingClientRect().top;
    const line = last ? last.getBoundingClientRect().top - top + last.offsetHeight / 2 : 0;
    tl.style.setProperty("--lobby-line", `${Math.max(0, line)}px`);
  }, []);
  useLayoutEffect(() => {
    measure();
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [shownCount, measure]);
  useEffect(() => {
    const tl = tlRef.current;
    if (!tl) return;
    const ro = new ResizeObserver(measure);
    ro.observe(tl);
    return () => ro.disconnect();
  }, [measure]);

  const lastUserScroll = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mark = () => (lastUserScroll.current = performance.now());
    el.addEventListener("wheel", mark, { passive: true });
    el.addEventListener("touchmove", mark, { passive: true });
    return () => {
      el.removeEventListener("wheel", mark);
      el.removeEventListener("touchmove", mark);
    };
  }, []);
  useEffect(() => {
    if (!shownCount) return;
    const t = window.setTimeout(() => {
      if (performance.now() - lastUserScroll.current < 4000) return;
      const sc = scrollRef.current;
      const nodes = tlRef.current?.querySelectorAll<HTMLElement>(".lobby-node");
      const last = nodes?.[nodes.length - 1];
      if (!sc || !last) return;
      // on a phone the plan sits pinned at the top, so the newest node lands just under it
      const pinned = sc.querySelector<HTMLElement>(".lobby-plan");
      const phone = window.matchMedia("(max-width: 959px)").matches && pinned;
      // nothing to do while the newest node already sits in full view
      const box = last.getBoundingClientRect();
      const viewTop = phone ? pinned.getBoundingClientRect().bottom : 0;
      if (box.top >= viewTop + 8 && box.bottom <= window.innerHeight - 24) return;
      const offset = phone ? pinned.offsetHeight + 56 : sc.clientHeight * 0.3;
      const target = Math.max(0, last.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - offset);
      const dist = Math.abs(target - sc.scrollTop);
      if (dist < 4) return;
      if (reduced) {
        sc.scrollTop = target;
        return;
      }
      const p = { y: sc.scrollTop };
      gsap.to(p, { y: target, duration: Math.min(1.8, 0.9 + dist / 1200), ease: "power3.inOut", onUpdate: () => sc.scrollTo(0, p.y) });
    }, 160);
    return () => window.clearTimeout(t);
  }, [shownCount, run.browse.mode, reduced]);

  const live = run.browse.mode === "live";
  const status = run.finished ? "done" : "running";
  const measured = PLAN_ORDER.indexOf(run.plan) >= PLAN_ORDER.indexOf("measured") || reduced;
  const raised = PLAN_ORDER.indexOf(run.plan) >= PLAN_ORDER.indexOf("raised") || reduced;
  const furnished = PLAN_ORDER.indexOf(run.plan) >= PLAN_ORDER.indexOf("furniture") || reduced;

  return (
    <div className="lobby" ref={rootRef} data-status={status} role="dialog" aria-modal="true" aria-label="Building your room">
      <div className="lobby-scrim" aria-hidden="true" />
      {reduced ? null : <Waves />}
      <div className="lobby-scroll" ref={scrollRef}>
        <div className="lobby-inner">
          <header className="lobby-head">
            <p className="lobby-kicker">
              <span className={`lobby-live${live ? " is-live" : ""}`} aria-hidden="true" />
              <span>{run.finished ? "Done" : live ? "Live" : "Working"}</span>
              <span className="lobby-kicker__sep" aria-hidden="true">
                /
              </span>
              <span className="lobby-kicker__addr">{shortAddress(address)}</span>
            </p>
            <h1 className="lobby-title">
              <DecryptedText text={run.finished ? `Your ${DEMO_UNIT.room} is ready` : "Finding your floorplan"} reduced={reduced} speed={42} />
            </h1>
            <p className="lobby-sub">An agent finds your building, reads its listing and draws your room to scale.</p>
          </header>

          <div className="lobby-grid">
            <aside className="lobby-plan" aria-label="Floorplan">
              <div className="lobby-plan__top">
                <span className="lobby-plan__name">Plan {DEMO_UNIT.plan} living room, {DEMO_BUILDING.name}</span>
                <span className="lobby-plan__dims" data-on={measured ? "" : undefined}>
                  {STUDIO.width} x {STUDIO.depth} m · {STUDIO_SQFT} sq ft
                </span>
              </div>
              <PlanSketch phase={run.plan} reduced={reduced} />
              <div className="lobby-plan__foot">
                <span data-on={raised ? "" : undefined}>{STUDIO.height} m ceilings</span>
                <span data-on={furnished ? "" : undefined}>Sofa and table from the photo</span>
              </div>
            </aside>

            <ol className="lobby-tl" ref={tlRef}>
              {STAGES.map((def, i) =>
                run.revealed.includes(def.id) ? (
                  <StageNode key={def.id} def={def} index={i + 1} stage={run.stages[def.id]} browse={run.browse} reduced={reduced} />
                ) : null,
              )}
              {run.finished ? <FinalNode reduced={reduced} /> : null}
            </ol>
          </div>
        </div>
      </div>
      <button type="button" className="lobby-skip" onClick={exit}>
        Skip to your room <kbd>Esc</kbd>
      </button>
    </div>
  );
}

/** A node rises in when it first appears. */
function useRise(reduced: boolean) {
  const ref = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;
    const q = gsap.utils.selector(el);
    const ctx = gsap.context(() => {
      gsap.fromTo(q(".lobby-node__icon"), { scale: 0.4, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.6, ease: "back.out(2)" });
      gsap.fromTo(q(".lobby-card"), { y: 18, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.8, ease: "power3.out", delay: 0.08 });
    }, el);
    return () => ctx.revert();
  }, [reduced]);
  return ref;
}

const StageNode = memo(function StageNode({
  def,
  index,
  stage,
  browse,
  reduced,
}: {
  def: StageDef;
  index: number;
  stage: StageRun;
  browse: LobbyState["browse"];
  reduced: boolean;
}) {
  const ref = useRise(reduced);
  const working = stage.state === "working";
  const isBrowse = def.id === "browse";
  const pill = !working ? "done" : isBrowse && browse.mode === "live" ? "live" : isBrowse && browse.mode === "replay" ? "replay" : "working";
  const explain =
    isBrowse && browse.mode === "replay" ? "Live browsing is busy right now, so this is a replay of the search." : def.explain;
  return (
    <li ref={ref} className={`lobby-node lobby-node--${def.id}`} data-state={stage.state}>
      <span className="lobby-node__icon" aria-hidden="true" style={{ "--rot": `${(index * 47) % 360}deg` } as CSSProperties}>
        <Sparkle />
      </span>
      <div className="lobby-card">
        <div className="lobby-card__top">
          <span className="lobby-card__idx">{String(index).padStart(2, "0")}</span>
          <h2 className="lobby-card__title">
            <DecryptedText text={def.title} reduced={reduced} speed={34} />
          </h2>
          <span className={`lobby-pill lobby-pill--${pill}`}>{pill}</span>
        </div>
        <p className="lobby-card__explain">{explain}</p>
        {isBrowse && working ? <BrowserFrame mode={browse.mode} liveUrl={browse.liveUrl} site={browse.site} /> : null}
        <ThoughtLine
          className="lobby-thought"
          label={`${def.working}...`}
          doneLabel={def.done}
          working={working}
          steps={stage.steps}
          reduced={reduced}
          fontSize={14}
        />
      </div>
    </li>
  );
});

function FinalNode({ reduced }: { reduced: boolean }) {
  const ref = useRise(reduced);
  const markStyle = { WebkitMaskImage: `url(${mark.src})`, maskImage: `url(${mark.src})` } as CSSProperties;
  return (
    <li ref={ref} className="lobby-node lobby-node--final" data-state="done">
      <span className="lobby-node__icon" aria-hidden="true">
        <span className="lobby-node__mark" style={markStyle} />
      </span>
      <div className="lobby-card lobby-card--final">
        <h2 className="lobby-card__title">
          <DecryptedText text={`Your ${DEMO_UNIT.room} is ready`} reduced={reduced} speed={45} />
        </h2>
        <p className="lobby-card__explain">Taking you in now. Walk around, then try furniture in your own space.</p>
        <p className="lobby-receipt">
          {STUDIO.width} x {STUDIO.depth} m · {STUDIO_SQFT} sq ft · {STUDIO.height} m ceilings · 1 door, 1 window
        </p>
      </div>
    </li>
  );
}
