"use client";

import type { WalkOptions } from "../room/walk-api";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomPlan } from "../../backend/contracts";
import type { BakedRoom, IsoGallery } from "../room/iso-gallery";
import { WipeLink, useWipeHold } from "./PageWipe";

export type GalleryRoom = { id: string; label: string; plan?: RoomPlan; baked?: BakedRoom; description?: string; reconstruction?: WalkOptions["reconstruction"] };
import "./IsoRoomGallery.css";

type Props = {
  rooms: GalleryRoom[];
  initial?: number;
  /** Where "Step inside" goes for a room. */
  hrefFor?: (room: GalleryRoom) => string;
  className?: string;
};

type Dir = 1 | -1;
type Label = { key: number; text: string; leaving: boolean };

/** Text that slides out one way while the next value slides in from the other. */
function Swap({ text, dir, axis }: { text: string; dir: Dir; axis: "x" | "y" }) {
  const [items, setItems] = useState<Label[]>([{ key: 0, text, leaving: false }]);
  const [shown, setShown] = useState(text);
  if (shown !== text) {
    setShown(text);
    setItems((prev) => {
      const key = Math.max(...prev.map((i) => i.key)) + 1;
      return [...prev.filter((i) => !i.leaving).map((i) => ({ ...i, leaving: true })), { key, text, leaving: false }];
    });
  }
  useEffect(() => {
    if (!items.some((i) => i.leaving)) return;
    const t = setTimeout(() => setItems((prev) => prev.filter((i) => !i.leaving)), 800);
    return () => clearTimeout(t);
  }, [items]);
  return (
    <span className="iso-gallery__swap">
      {items.map((i) => (
        <span
          key={i.key}
          className="iso-gallery__swap-item"
          data-axis={axis}
          data-dir={dir}
          data-state={i.leaving ? "leave" : i.key === 0 ? "rest" : "enter"}
          aria-hidden={i.leaving || undefined}
        >
          {i.text}
        </span>
      ))}
    </span>
  );
}

export function IsoRoomGallery({ rooms, initial = 0, hrefFor = (room) => `/rooms/${room.id}`, className }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<IsoGallery | null>(null);
  const busy = useRef(false);
  const [index, setIndex] = useState(initial);
  const [dir, setDir] = useState<Dir>(1);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // arriving by a page wipe, keep the panel down until the rooms are built
  useWipeHold(ready || failed);
  const count = rooms.length;
  const at = (i: number) => rooms[((i % count) + count) % count];

  useEffect(() => {
    let cancelled = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    import("../room/iso-gallery")
      .then(({ createIsoGallery }) => {
        if (cancelled || !canvas.current || rooms.length === 0) return;
        const g = createIsoGallery(
          canvas.current,
          rooms.map((r) => ({ plan: r.plan, baked: r.baked, reconstruction: r.reconstruction })),
          { initial, reducedMotion, lite: window.innerWidth < 768 },
        );
        engine.current = g;
        return g.ready.then(() => !cancelled && setReady(true));
      })
      .catch((err) => {
        console.error("iso gallery failed to load", err);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      engine.current?.dispose();
      engine.current = null;
    };
  }, [rooms, initial]);

  const go = useCallback(
    (d: Dir) => {
      if (busy.current || !engine.current || count < 2) return;
      busy.current = true;
      setDir(d);
      setIndex((i) => {
        const next = (((i + d) % count) + count) % count;
        engine.current!.showRoom(next, d).then(() => (busy.current = false));
        return next;
      });
    },
    [count],
  );

  // Arrow keys, one wheel gesture per room, and horizontal or vertical swipes.
  useEffect(() => {
    if (!ready) return;
    let wheelLock = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && (e.target.closest("input, textarea, select, [role=dialog]") || e.target.isContentEditable)) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") go(1);
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") go(-1);
    };
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 4 || performance.now() < wheelLock) return;
      wheelLock = performance.now() + 1000;
      go(e.deltaY > 0 ? 1 : -1);
    };
    let start: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (start = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 40) return;
      if (Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
      else go(dy < 0 ? 1 : -1);
    };
    const el = canvas.current!;
    window.addEventListener("keydown", onKey);
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [ready, go]);

  const room = at(index);
  if (!room) return <section className="iso-gallery"><p>No rooms yet. Open a scan to get started.</p></section>;

  return (
    <section className={`iso-gallery ${className ?? ""}`.trim()} data-ready={ready || failed || undefined} aria-roledescription="carousel" aria-label="Your rooms">
      <canvas ref={canvas} className="iso-gallery__canvas" role="img" aria-label={`${room.label}, ${room.description ?? "room preview"}`} />

      {count > 1 ? (
        <>
          <button type="button" className="iso-gallery__side" data-side="prev" onClick={() => go(-1)} aria-label={`Previous room: ${at(index - 1).label}`}>
            <span className="iso-gallery__side-label">
              <Swap text={at(index - 1).label} dir={dir} axis="y" />
            </span>
            <svg className="iso-gallery__arrow" viewBox="0 0 8 12" aria-hidden="true">
              <path d="M7 1 2 6l5 5" />
            </svg>
          </button>
          <button type="button" className="iso-gallery__side" data-side="next" onClick={() => go(1)} aria-label={`Next room: ${at(index + 1).label}`}>
            <span className="iso-gallery__side-label">
              <Swap text={at(index + 1).label} dir={dir} axis="y" />
            </span>
            <svg className="iso-gallery__arrow" viewBox="0 0 8 12" aria-hidden="true">
              <path d="m1 1 5 5-5 5" />
            </svg>
          </button>
        </>
      ) : null}

      <div className="iso-gallery__caption">
        <p className="iso-gallery__count">
          {String(index + 1).padStart(2, "0")} / {String(count).padStart(2, "0")}
        </p>
        <h2 className="iso-gallery__title" aria-live="polite">
          <Swap text={room.label} dir={dir} axis="x" />
        </h2>
        <p className="iso-gallery__source">{room.description ?? "Demo room"}</p>
        <WipeLink className="iso-gallery__enter" href={hrefFor(room)} onClick={() => { try { sessionStorage.setItem("tadaima:last-room", room.id); } catch { /* optional */ } }}>
          <span className="iso-gallery__enter-text" data-text="Step inside">
            Step inside
          </span>
        </WipeLink>
      </div>

      {!ready && !failed ? <p className="iso-gallery__loading" role="status">Preparing room previews…</p> : null}
      {failed ? <p className="iso-gallery__error">Your rooms could not load. Refresh to try again.</p> : null}
    </section>
  );
}
