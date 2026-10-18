"use client";

import { useEffect, useRef, useState } from "react";
import type { Picked } from "@/lib/room/scene";

const cm = (m: number) => Math.round(m * 100);
const inch = (m: number) => (m / 0.0254).toFixed(1);

export function RoomHero() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const tag = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<Omit<Picked, "screen"> | null>(null);
  const [ready, setReady] = useState(false);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let alive = true;
    let last = "";
    import("@/lib/room/scene").then(({ createRoom }) => {
      if (!alive || !canvas.current) return;
      const lite = window.matchMedia("(max-width: 767px), (pointer: coarse)").matches;
      const room = createRoom(
        canvas.current,
        (p) => {
          if (!p) {
            last = "";
            setPicked(null);
            return;
          }
          if (tag.current) {
            // label hangs off the box's corner, flipping left near the right edge
            const flip = p.screen.x > window.innerWidth * 0.7;
            tag.current.style.transform = `translate(${p.screen.x}px, ${p.screen.y}px)`;
            tag.current.dataset.flip = flip ? "1" : "";
          }
          if (p.name !== last) {
            last = p.name;
            setPicked({ name: p.name, size: p.size });
          }
        },
        { lite },
      );
      dispose = room.dispose;
      setCount(room.count);
      room.ready.then(() => alive && setTimeout(() => setReady(true), 120));
    });
    return () => {
      alive = false;
      dispose?.();
    };
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvas}
        className={`h-full w-full touch-manipulation transition-opacity duration-[1400ms] ${ready ? "opacity-100" : "opacity-0"}`}
      />

      <div ref={tag} className="pointer-events-none absolute top-0 left-0" aria-live="polite">
        {picked && (
          <div className="flex -translate-y-1/2 items-center in-data-[flip=1]:-translate-x-full in-data-[flip=1]:flex-row-reverse">
            <div className="h-px w-8 bg-ink" />
            <div className="min-w-[180px] bg-ink px-3 py-2 text-[12px] leading-[1.6] text-surface-soft">
              <div>{picked.name}</div>
              <div className="flex gap-3 text-surface-soft/70">
                <span>x {cm(picked.size[0])}</span>
                <span>y {cm(picked.size[1])}</span>
                <span>z {cm(picked.size[2])}</span>
                <span>cm</span>
              </div>
              <div className="text-surface-soft/45">
                {inch(picked.size[0])} × {inch(picked.size[1])} × {inch(picked.size[2])} in
              </div>
            </div>
          </div>
        )}
      </div>

      {count > 0 && (
        <div className="pointer-events-none absolute right-4 bottom-6 border border-ink/15 bg-surface px-3 py-2 text-[12px] text-ink md:right-10">
          {count} objects &middot; {picked ? picked.name : "Hover any of them"}
        </div>
      )}
    </div>
  );
}
