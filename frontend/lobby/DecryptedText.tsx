"use client";
// Scramble-then-resolve text (React Bits DecryptedText, by way of gist's pipeline timeline), trimmed to the
// one mode the lobby uses: plays on mount and again whenever `text` changes. Letters only, so it stays soft.
import { useEffect, useState } from "react";

const POOL = "abcdefghijklmnopqrstuvwxyz";

export default function DecryptedText({ text, speed = 40, reduced = false, className }: { text: string; speed?: number; reduced?: boolean; className?: string }) {
  const [frame, setFrame] = useState<{ for: string; shown: string; locked: number } | null>(null);

  useEffect(() => {
    if (reduced) return;
    const scramble = (n: number) =>
      text
        .split("")
        .map((c, i) => (c === " " || i < n ? c : POOL[Math.floor(Math.random() * POOL.length)]))
        .join("");
    let tick = 0;
    const step = () => {
      const n = Math.max(0, tick - 2);
      tick++;
      if (n >= text.length) {
        window.clearInterval(id);
        setFrame(null);
        return;
      }
      setFrame({ for: text, shown: scramble(n), locked: n });
    };
    const first = window.setTimeout(step, 0);
    const id = window.setInterval(step, speed);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [text, speed, reduced]);

  const live = !reduced && frame && frame.for === text ? frame : null;
  const shown = live ? live.shown : text;
  const locked = live ? live.locked : text.length;
  return (
    <span className={className} style={{ display: "inline-block", whiteSpace: "pre-wrap" }}>
      <span className="lobby-sr">{text}</span>
      <span aria-hidden="true">
        {shown.split("").map((c, i) => (
          <span key={i} className={i >= locked && c !== " " ? "lobby-enc" : undefined}>
            {c}
          </span>
        ))}
      </span>
    </span>
  );
}
