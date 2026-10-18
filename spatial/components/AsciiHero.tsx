"use client";

import { useEffect, useRef, useState } from "react";
import { AsciiField, type AsciiConfig } from "@/spatial/components/AsciiField";

// the room loop as live ascii. module scope so the gl program is built once
const ROOM: AsciiConfig = {
  aspect: 640 / 360,
  cell: 1 / 130,
  ramp: [" ", ".", "'", ":", ";", "-", "~", "=", "+", "*", "o", "x", "#", "%", "&", "@"],
  layers: [{ src: "/art/japan.mp4", tint: { mode: "source" } }],
  gamma: 1.25,
  levels: [0.2, 0.9],
  weight: 600,
  exposure: 1.2,
  saturation: 1.3,
  floor: 0.5,
  interact: { scramble: 0.12 },
};

export function AsciiHero() {
  const box = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(true);
  // /?ascii&t=3 pins a second of the loop, for side by side checks
  const [time, setTime] = useState<number>();

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("t");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (t !== null) setTime(Number(t));

    let inView = true;
    const sync = () => setPlaying(inView && !document.hidden);
    const io = new IntersectionObserver(([e]) => {
      inView = e.isIntersecting;
      sync();
    });
    if (box.current) io.observe(box.current);
    document.addEventListener("visibilitychange", sync);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return (
    <div ref={box} className="absolute inset-0 bg-black">
      <AsciiField config={ROOM} playing={playing} time={time} />
    </div>
  );
}
