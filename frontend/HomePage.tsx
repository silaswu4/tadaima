"use client";

import { toDataURL } from "qrcode";
import gsap from "gsap";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import mark from "@/spatial/assets/tadaima-mark.png";
import { WipeLink, useWipe, wipeInProgress } from "@/spatial/components/PageWipe";
import { DappledLight } from "./DappledLight";
import "./styles/hero.css";

const subscribeToMotion = (notify: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
const readMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// The loader, as one timeline: the word sets in, the brackets open around it, it
// counts to 100 with a small overshoot, then the panel lifts off the hero.
function Loader({ onLift, onDone, reduced }: { onLift: () => void; onDone: () => void; reduced: boolean }) {
  const el = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = el.current;
    if (!root) return;
    const q = gsap.utils.selector(root);
    const word = q(".hero-loader__word")[0] as HTMLElement;
    const pct = q(".hero-loader__pct")[0] as HTMLElement;
    const frame = q(".hero-loader__frame");
    const ctx = gsap.context(() => {
      if (reduced) {
        pct.textContent = "100%";
        gsap.set(q(".hero-loader__meta"), { opacity: 1 });
        gsap.to(root, { autoAlpha: 0, duration: 0.3, delay: 0.25, onStart: onLift, onComplete: onDone });
        return;
      }
      const count = { v: 0 };
      gsap
        .timeline({ onComplete: onDone })
        .fromTo(frame, { width: 180, height: 72 }, { width: 222, height: 92, duration: 0.55, ease: "power3.out" })
        .fromTo(word, { yPercent: 35, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1, duration: 0.5, ease: "power3.out" }, 0)
        .to(q(".hero-loader__meta"), { opacity: 1, duration: 0.2 }, 0.35)
        .to(frame, { width: 236, height: 122, duration: 0.5, ease: "power3.out" }, 0.55)
        .to(count, { v: 100, duration: 0.7, ease: "back.out(1.7)", onUpdate: () => (pct.textContent = `${Math.max(0, Math.round(count.v))}%`) }, 0.6)
        .to(frame, { height: 152, duration: 0.4, ease: "power3.out" }, 1.3)
        .add(onLift, 1.55)
        .to(root, { yPercent: -100, duration: 0.75, ease: "power3.inOut" }, 1.55)
        .to(q(".hero-loader__stack"), { yPercent: -80, duration: 0.75, ease: "power3.inOut" }, 1.55);
    }, root);
    return () => ctx.revert();
  }, [onLift, onDone, reduced]);

  return (
    <div className="hero-loader" ref={el} aria-hidden="true">
      <div className="hero-loader__frame">
        <span className="hero-loader__corner tl" />
        <span className="hero-loader__corner tr" />
        <span className="hero-loader__corner bl" />
        <span className="hero-loader__corner br" />
        <div className="hero-loader__stack">
          <p className="hero-loader__word">tadaima</p>
          <p className="hero-loader__meta">
            <span>Loading</span>
            <span className="hero-loader__pct">0%</span>
          </p>
        </div>
      </div>
    </div>
  );
}

type Row = { key: "scan" | "type" | "demo"; label: string };
const ROWS: Row[] = [
  { key: "scan", label: "Scan room" },
  { key: "type", label: "Type address" },
  { key: "demo", label: "Explore demo rooms" },
];

export default function Home() {
  const wipe = useWipe();
  const reduced = useSyncExternalStore(subscribeToMotion, readMotion, () => false);
  const root = useRef<HTMLElement>(null);
  // arriving by a page wipe means the wipe already covered the screen, so skip the loader
  const [revealed, setRevealed] = useState(() => typeof window !== "undefined" && wipeInProgress());
  const [loaderGone, setLoaderGone] = useState(revealed);
  const [open, setOpen] = useState<"scan" | "type" | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [captureUrl, setCaptureUrl] = useState("/capture");
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState("");
  const addressRef = useRef<HTMLInputElement>(null);
  const reveal = useCallback(() => setRevealed(true), []);
  const finishLoading = useCallback(() => setLoaderGone(true), []);

  // The hero sets in as the loader lifts: letters rise out of the floor, then the three ways in.
  useLayoutEffect(() => {
    if (!revealed || !root.current) return;
    if (reduced) return;
    const ctx = gsap.context(() => {
      // the fill and the outline are two stacked copies, so they rise together letter by letter
      // 2D transforms on the outline copy: in Safari a 3D-promoted letter slips out from under the outline filter
      for (const [layer, force3D] of [[".hero-word__fill", true], [".hero-word__edge", false]] as const) {
        gsap.fromTo(`${layer} .hero-word__char`, { yPercent: 105 }, { yPercent: 0, duration: 1.15, ease: "power4.out", stagger: 0.05, delay: 0.1, force3D });
      }
      gsap.fromTo(".hero-row", { y: 14, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.8, ease: "power3.out", stagger: 0.1, delay: 0.45 });
    }, root);
    return () => ctx.revert();
  }, [revealed, reduced]);

  const showScan = useCallback(() => {
    // on a phone the camera is right here, so skip the code
    if (window.matchMedia("(pointer: coarse)").matches) {
      wipe("/capture");
      return;
    }
    setOpen((o) => (o === "scan" ? null : "scan"));
    const url = `${window.location.origin}/capture`;
    setCaptureUrl(url);
    if (!qr) {
      toDataURL(url, { width: 296, margin: 1, color: { dark: "#2B1A10", light: "#F6EBD9" }, errorCorrectionLevel: "M" })
        .then(setQr)
        .catch(() => setQr(null));
    }
  }, [qr, wipe]);

  const showType = useCallback(() => {
    setOpen("type");
    requestAnimationFrame(() => addressRef.current?.focus());
  }, []);

  const submitAddress = (e: FormEvent) => {
    e.preventDefault();
    const v = address.trim();
    if (!v) return;
    if (v.length > 512) {
      setAddressError("Keep the address and unit under 512 characters.");
      return;
    }
    try {
      window.sessionStorage.setItem("tadaima:pending-address", v);
      setAddressError("");
      wipe("/rooms?onboarding=address");
    } catch {
      setAddressError("Your browser could not save this address privately. Enable session storage, or explore the demo rooms.");
    }
  };

  const markStyle = { WebkitMaskImage: `url(${mark.src})`, maskImage: `url(${mark.src})` } as CSSProperties;

  return (
    <main ref={root} className={`tadaima-hero ${revealed ? "is-revealed" : ""}`}>
      <DappledLight
        plant="olive"
        placement="top-right"
        window="on"
        windowAngle={28}
        windowSize={0.52}
        lightColor="#F0B64C"
        shadowColor="#5A3A1A"
        backgroundColor="#2B1A10"
        shadowStrength={1}
        intensity={0.9}
        bloom={0.6}
        wind={0.6}
        clouds={0.25}
        grain={0.25}
        className="h-full"
      >
        <div className="hero-side">
          <ul className="hero-list">
            {ROWS.map((row) => (
              <li key={row.key} className="hero-row">
                {row.key === "type" && open === "type" ? (
                  <form className="hero-row__inner is-form" onSubmit={submitAddress}>
                    <span className="hero-row__field">
                      <label htmlFor="hero-address" hidden>
                        Address
                      </label>
                      <input
                        id="hero-address"
                        ref={addressRef}
                        name="address"
                        type="text"
                        autoComplete="street-address"
                        maxLength={512}
                        aria-describedby={addressError ? "hero-address-error" : undefined}
                        placeholder="580 Gayley Ave, Los Angeles"
                        value={address}
                        onChange={(e) => {
                          setAddress(e.target.value);
                          setAddressError("");
                        }}
                        onKeyDown={(e) => e.key === "Escape" && setOpen(null)}
                      />
                      <button type="submit" className="hero-row__go">
                        Go
                      </button>
                    </span>
                  </form>
                ) : row.key === "demo" ? (
                  <WipeLink href="/rooms" className="hero-row__inner">
                    <RowText row={row} />
                  </WipeLink>
                ) : (
                  <button
                    type="button"
                    className="hero-row__inner"
                    onClick={row.key === "scan" ? showScan : showType}
                    aria-expanded={row.key === "scan" ? open === "scan" : undefined}
                  >
                    <RowText row={row} />
                  </button>
                )}
              </li>
            ))}
          </ul>

          {addressError ? (
            <small className="hero-error" id="hero-address-error" role="alert">
              {addressError}
            </small>
          ) : null}

          {open === "scan" && (
            <div className="hero-qr">
              {qr ? (
                <div className="code">
                  {/* data URL, so next/image has nothing to optimize */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qr} alt="QR code that opens the capture page on your phone" />
                </div>
              ) : null}
              <small>
                Point your phone here, or <a href={captureUrl}>open capture on this device</a>.
              </small>
            </div>
          )}
        </div>

      </DappledLight>

      {/* outside the light's own layer so it can blend with it */}
      {/* outer-only outline: grow the solid shape by a pixel and keep just the ring,
          so overlapping strokes inside letters and the mark's panels never show */}
      <svg className="hero-defs" aria-hidden="true" focusable="false">
        <filter id="hero-word-outline" x="-2%" y="-2%" width="104%" height="104%">
          {/* the source is drawn almost invisible, so lift its alpha back to solid first */}
          <feComponentTransfer in="SourceAlpha" result="solid">
            <feFuncA type="linear" slope="255" />
          </feComponentTransfer>
          <feMorphology in="solid" operator="dilate" radius="1" result="grown" />
          <feComposite in="grown" in2="solid" operator="out" result="ring" />
          <feFlood floodColor="#f6ebd9" floodOpacity="0.75" />
          <feComposite in2="ring" operator="in" />
        </filter>
      </svg>
      <h1 className="hero-word" aria-label="tadaima">
        {(["fill", "edge"] as const).map((layer) => (
          <span key={layer} className={`hero-word__line hero-word__${layer}`} aria-hidden="true">
            <span className="hero-word__char hero-word__mark" style={markStyle} />
            {Array.from("tadaima").map((c, i) => (
              <span key={i} className="hero-word__char">
                {c}
              </span>
            ))}
          </span>
        ))}
      </h1>

      {!loaderGone && <Loader onLift={reveal} onDone={finishLoading} reduced={reduced} />}
    </main>
  );
}

function RowText({ row }: { row: Row }) {
  return (
    <>
      <span className="hero-row__text">
        <span className="hero-row__label">
          {row.label}
        </span>
      </span>
    </>
  );
}
