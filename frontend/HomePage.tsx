"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Inter, Inter_Tight, Klee_One, Reenie_Beanie } from "next/font/google";
import { toDataURL } from "qrcode";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { DappledLight } from "./DappledLight";
import "./styles/hero.css";

const hand = Reenie_Beanie({ weight: "400", subsets: ["latin"], variable: "--font-hand" });
const kana = Klee_One({ weight: "600", preload: false, variable: "--font-kana" });
const display = Inter_Tight({ subsets: ["latin"], variable: "--font-display" });
const body = Inter({ subsets: ["latin"], variable: "--font-body" });

// The headline types itself three ways: handwriting, kana, then the modern face.
const PHASES = [
  { text: "tadaima", cls: "hand", lang: "en", hold: 1600 },
  { text: "ただいま", cls: "kana", lang: "ja", hold: 1600 },
  { text: "tadaima", cls: "modern", lang: "en", hold: 4000 },
] as const;
const TYPE_MS = 120;
const TYPE_JITTER = 90;
const ERASE_MS = 70;
const SWAP_PAUSE = 350;

const subscribeToMotion = (notify: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
const readMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const NIGHT = { backgroundColor: "#2B1A10", shadowColor: "#5A3A1A", shadowStrength: 1 };
const DAY = { backgroundColor: "#EFE4D2", shadowColor: "#A98B66", shadowStrength: 0.75 };

export default function Home() {
  const router = useRouter();
  const [day, setDay] = useState(false);
  const [phase, setPhase] = useState(0);
  const [typed, setTyped] = useState("tadaima");
  const [cordPulling, setCordPulling] = useState(false);
  const [flash, setFlash] = useState<{ opacity: number; ms: number }>({ opacity: 0, ms: 0 });
  const [open, setOpen] = useState<"scan" | "type" | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [captureUrl, setCaptureUrl] = useState("/capture");
  const [address, setAddress] = useState("");
  const busy = useRef(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const reduced = useSyncExternalStore(subscribeToMotion, readMotion, () => false);

  // typing loop. with reduced motion the headline just shows the final face.
  useEffect(() => {
    if (reduced) return;
    let timer = 0;
    let alive = true;
    const wait = (ms: number, next: () => void) => {
      timer = window.setTimeout(() => {
        if (alive) next();
      }, ms);
    };
    const run = (i: number) => {
      const p = PHASES[i];
      const chars = Array.from(p.text);
      setPhase(i);
      const type = (n: number) => {
        setTyped(chars.slice(0, n).join(""));
        if (n < chars.length) wait(TYPE_MS + Math.random() * TYPE_JITTER, () => type(n + 1));
        else wait(p.hold, () => erase(chars.length));
      };
      const erase = (n: number) => {
        setTyped(chars.slice(0, n).join(""));
        if (n > 0) wait(ERASE_MS, () => erase(n - 1));
        else wait(SWAP_PAUSE, () => run((i + 1) % PHASES.length));
      };
      type(0);
    };
    const start = () => run(0);
    if (document.fonts?.ready) document.fonts.ready.then(() => alive && start());
    else wait(0, start);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [reduced]);

  // "enter your home": pull the cord, glow, switch the room to day
  const enter = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setCordPulling(false);
    requestAnimationFrame(() => setCordPulling(true));
    window.setTimeout(() => {
      setFlash({ opacity: 0.72, ms: 450 });
      window.setTimeout(() => {
        setDay(true);
        window.setTimeout(() => setFlash({ opacity: 0, ms: 1300 }), 140);
      }, 460);
    }, 190);
  }, []);

  const showScan = useCallback(() => {
    setOpen("scan");
    const url = `${window.location.origin}/capture`;
    setCaptureUrl(url);
    if (!qr) {
      toDataURL(url, {
        width: 296,
        margin: 1,
        color: { dark: "#2B1A10", light: "#FBF5EA" },
        errorCorrectionLevel: "M",
      })
        .then(setQr)
        .catch(() => setQr(null));
    }
  }, [qr]);

  const showType = useCallback(() => {
    setOpen("type");
    requestAnimationFrame(() => addressRef.current?.focus());
  }, []);

  const submitAddress = (e: FormEvent) => {
    e.preventDefault();
    const v = address.trim();
    if (!v) return;
    router.push(`/room?address=${encodeURIComponent(v)}`);
  };

  const room = day ? DAY : NIGHT;
  const current = reduced ? PHASES[PHASES.length - 1] : PHASES[phase];
  const shown = reduced ? current.text : typed;

  return (
    <main className={`tadaima-hero ${day ? "is-day" : ""} ${hand.variable} ${kana.variable} ${display.variable} ${body.variable}`}>
      <DappledLight
        plant="olive"
        placement="top-right"
        window="on"
        windowAngle={28}
        windowSize={0.52}
        lightColor="#F0B64C"
        shadowColor={room.shadowColor}
        backgroundColor={room.backgroundColor}
        shadowStrength={room.shadowStrength}
        intensity={0.9}
        bloom={0.6}
        wind={0.6}
        clouds={0.25}
        grain={0.25}
        className="h-full"
      >
        <div
          className={`hero-cord ${cordPulling ? "pulling" : ""}`}
          aria-hidden="true"
          onAnimationEnd={(e) => {
            if (e.animationName === "tadaima-pull") setCordPulling(false);
          }}
        >
          <span className="line" />
          <span className="knot" />
          <span className="pull" />
        </div>

        <div
          className="hero-flash"
          aria-hidden="true"
          style={{ opacity: flash.opacity, transition: `opacity ${flash.ms}ms ${flash.opacity ? "ease-in-out" : "ease-out"}` }}
        />

        <div className="hero-inner" aria-hidden={day}>
          <div className="hero-copy">
            <div className="hero-eyebrow">Your room, rebuilt in 3D</div>
            <h1 className={`hero-word ${current.cls}`} lang={current.lang} aria-label="tadaima">
              <span className="txt">{shown}</span>
              <span className="hero-caret" aria-hidden="true" />
            </h1>
            <div className="hero-actions">
              <button type="button" className="hero-enter" onClick={enter} disabled={day}>
                enter your home
              </button>
            </div>
          </div>
          <div className="hero-foot">Move the pointer for a breeze · click the light for a gust</div>
        </div>

        <div className="hero-choices" aria-hidden={!day}>
          <div className="hero-choice">
            <button
              type="button"
              className="hero-tile"
              onClick={showScan}
              aria-expanded={open === "scan"}
              aria-controls="hero-qr"
              tabIndex={day ? 0 : -1}
            >
              <span className="t">Use your phone to scan</span>
              <span className="d">Scan your space using a mobile phone (Pro phone required)</span>
            </button>
            {open === "scan" && (
              <div className="hero-qr" id="hero-qr">
                {qr ? (
                  <div className="code">
                    {/* data URL, so next/image has nothing to optimize */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={qr} alt="QR code that opens the capture page on your phone" />
                  </div>
                ) : null}
                <small>
                  Opens capture on your phone, or <a href={captureUrl}>open it on this device</a>.
                </small>
              </div>
            )}
          </div>
          <div className="hero-or" aria-hidden="true">
            or
          </div>
          <div className="hero-choice">
            <button
              type="button"
              className="hero-tile"
              onClick={showType}
              aria-expanded={open === "type"}
              aria-controls="hero-addr"
              tabIndex={day ? 0 : -1}
            >
              <span className="t">Type in an address</span>
              <span className="d">We&apos;ll find the place and set the room up from there.</span>
            </button>
            {open === "type" && (
              <form className="hero-addr" id="hero-addr" onSubmit={submitAddress}>
                <div className="row">
                  <label htmlFor="hero-address" hidden>
                    Address
                  </label>
                  <input
                    id="hero-address"
                    ref={addressRef}
                    name="address"
                    type="text"
                    autoComplete="street-address"
                    placeholder="580 Gayley Ave, Los Angeles"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                  <button className="go" type="submit">
                    Go
                  </button>
                </div>
              </form>
            )}
          </div>
          <div className="hero-or" aria-hidden="true">
            or
          </div>
          <div className="hero-choice">
            <Link className="hero-tile" href="/rooms" tabIndex={day ? 0 : -1} style={{ textDecoration: "none", color: "inherit" }}>
              <span className="t">Walk through a demo room</span>
              <span className="d">Step into rooms we already built and try them with real furniture.</span>
            </Link>
          </div>
        </div>
      </DappledLight>
    </main>
  );
}
