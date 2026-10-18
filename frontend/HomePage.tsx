"use client";

import { toDataURL } from "qrcode";
import gsap from "gsap";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import mark from "@/spatial/assets/tadaima-mark.png";
import { WipeLink, useWipe, wipeInProgress, whenWipeLifts } from "@/spatial/components/PageWipe";
import { DappledLight } from "./DappledLight";
import "./styles/hero.css";

const subscribeToMotion = (notify: () => void) => {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
const readMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// The loader, as one timeline: the line sets in, the brackets open around it, it
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
    // the brackets are sized from the line they frame, so any copy fits
    const stack = q(".hero-loader__stack")[0] as HTMLElement;
    const w = stack.offsetWidth;
    const h = stack.offsetHeight;
    const ctx = gsap.context(() => {
      if (reduced) {
        pct.textContent = "100%";
        gsap.set(q(".hero-loader__meta"), { opacity: 1 });
        gsap.set(frame, { width: w + 56, height: h + 64 });
        gsap.to(root, { autoAlpha: 0, duration: 0.3, delay: 0.25, onStart: onLift, onComplete: onDone });
        return;
      }
      const count = { v: 0 };
      gsap
        .timeline({ onComplete: onDone })
        .fromTo(frame, { width: w - 24, height: h }, { width: w + 36, height: h + 24, duration: 0.55, ease: "power3.out" })
        .fromTo(word, { yPercent: 35, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1, duration: 0.5, ease: "power3.out" }, 0)
        .to(q(".hero-loader__meta"), { opacity: 1, duration: 0.2 }, 0.35)
        .to(frame, { width: w + 56, height: h + 44, duration: 0.5, ease: "power3.out" }, 0.55)
        .to(count, { v: 100, duration: 0.7, ease: "back.out(1.7)", onUpdate: () => (pct.textContent = `${Math.max(0, Math.round(count.v))}%`) }, 0.6)
        .to(frame, { height: h + 64, duration: 0.4, ease: "power3.out" }, 1.3)
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
          <p className="hero-loader__word">
            Furniture shopping,
            <br />
            reimagined
          </p>
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
  { key: "scan", label: "Scan your room" },
  { key: "type", label: "Find your floorplan" },
  { key: "demo", label: "Explore demo rooms" },
];

export default function Home() {
  const wipe = useWipe();
  const reduced = useSyncExternalStore(subscribeToMotion, readMotion, () => false);
  const root = useRef<HTMLElement>(null);
  // arriving by a page wipe means the wipe already covered the screen, so skip the loader
  // and start the intro as the panel lifts instead
  const [arrivedByWipe] = useState(() => typeof window !== "undefined" && wipeInProgress());
  const [revealed, setRevealed] = useState(false);
  const [loaderGone, setLoaderGone] = useState(arrivedByWipe);
  const [open, setOpen] = useState<"scan" | "type" | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [captureUrl, setCaptureUrl] = useState("/capture");
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState("");
  const [signInNote, setSignInNote] = useState(false);
  // the QR panel and the address field stay mounted while they animate out
  const [qrShown, setQrShown] = useState(false);
  const [typeShown, setTypeShown] = useState(false);
  const addressRef = useRef<HTMLInputElement>(null);
  const qrRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const typeLabelRef = useRef<HTMLSpanElement>(null);
  const qrAnim = useRef<gsap.core.Timeline | null>(null);
  const typeAnim = useRef<gsap.core.Timeline | null>(null);
  const reveal = useCallback(() => setRevealed(true), []);
  const finishLoading = useCallback(() => setLoaderGone(true), []);
  useLayoutEffect(() => (arrivedByWipe ? whenWipeLifts(reveal) : undefined), [arrivedByWipe, reveal]);

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
      // each option rises out of its own line, like the wordmark
      gsap.fromTo(".hero-credit", { y: 8, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.8, ease: "power3.out", delay: 0.8 });
      gsap.fromTo(".hero-row__label", { yPercent: 110 }, { yPercent: 0, duration: 0.9, ease: "power4.out", stagger: 0.1, delay: 0.45 });
    }, root);
    return () => ctx.revert();
  }, [revealed, reduced]);

  // make the code up front so the panel can animate it in the moment it opens
  useLayoutEffect(() => {
    const url = `${window.location.origin}/capture`;
    toDataURL(url, { width: 296, margin: 1, color: { dark: "#2B1A10", light: "#F6EBD9" }, errorCorrectionLevel: "M" })
      .then((data) => {
        setCaptureUrl(url);
        setQr(data);
      })
      .catch(() => setQr(null));
  }, []);

  const showScan = useCallback(() => {
    // on a phone the camera is right here, so skip the code
    if (window.matchMedia("(pointer: coarse)").matches) {
      wipe("/capture");
      return;
    }
    if (open === "scan") {
      setOpen(null);
      return;
    }
    setQrShown(true);
    setOpen("scan");
  }, [open, wipe]);

  const showType = useCallback(() => {
    setTypeShown(true);
    setOpen("type");
  }, []);

  // QR panel: drops open from the top, the code sharpens in, a scan line sweeps it once
  useLayoutEffect(() => {
    const el = qrRef.current;
    if (!el) return;
    qrAnim.current?.kill();
    if (open === "scan") {
      if (reduced) return;
      const q = gsap.utils.selector(el);
      qrAnim.current = gsap
        .timeline()
        .fromTo(el, { clipPath: "inset(0% 0% 100% 0%)", y: -8 }, { clipPath: "inset(0% 0% 0% 0%)", y: 0, duration: 0.6, ease: "power3.inOut" })
        .fromTo(q(".code img"), { scale: 0.92, filter: "blur(6px)", autoAlpha: 0 }, { scale: 1, filter: "blur(0px)", autoAlpha: 1, duration: 0.7, ease: "power3.out" }, 0.15)
        .fromTo(q(".hero-qr__scan"), { top: "0%", autoAlpha: 1 }, { top: "100%", duration: 0.9, ease: "power2.inOut" }, 0.35)
        .to(q(".hero-qr__scan"), { autoAlpha: 0, duration: 0.2 }, ">-0.1")
        .fromTo(q("small"), { y: 6, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.5, ease: "power3.out" }, 0.45);
    } else if (qrShown) {
      if (reduced) {
        gsap.delayedCall(0, () => setQrShown(false));
        return;
      }
      qrAnim.current = gsap
        .timeline({ onComplete: () => setQrShown(false) })
        .to(el, { clipPath: "inset(0% 0% 100% 0%)", y: -6, duration: 0.45, ease: "power3.in" });
    }
  }, [open, qrShown, reduced]);

  // address field: the label slides up out of view, the underline draws in, the field rises in
  useLayoutEffect(() => {
    const form = formRef.current;
    const label = typeLabelRef.current;
    if (!form || !label) return;
    typeAnim.current?.kill();
    const q = gsap.utils.selector(form);
    if (open === "type") {
      addressRef.current?.focus({ preventScroll: true });
      if (reduced) {
        gsap.set(label, { yPercent: -140 });
        return;
      }
      typeAnim.current = gsap
        .timeline()
        .to(label, { yPercent: -140, duration: 0.45, ease: "power3.in" })
        .fromTo(q(".hero-type__line"), { scaleX: 0, transformOrigin: "0% 50%" }, { scaleX: 1, duration: 0.7, ease: "power3.inOut" }, 0.1)
        // opacity, not autoAlpha: a hidden field would drop its focus and close itself
        .fromTo(q("input, .hero-row__go"), { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out", stagger: 0.08 }, 0.3);
    } else if (typeShown) {
      if (reduced) {
        gsap.set(label, { yPercent: 0 });
        gsap.delayedCall(0, () => setTypeShown(false));
        return;
      }
      typeAnim.current = gsap
        .timeline({ onComplete: () => setTypeShown(false) })
        .to(q("input, .hero-row__go"), { y: -8, opacity: 0, duration: 0.25, ease: "power2.in" })
        .to(q(".hero-type__line"), { scaleX: 0, transformOrigin: "100% 50%", duration: 0.45, ease: "power3.inOut" }, 0.05)
        .fromTo(label, { yPercent: 140 }, { yPercent: 0, duration: 0.7, ease: "power4.out" }, 0.3);
    }
  }, [open, typeShown, reduced]);

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
        breeze={false}
        className="h-full"
      >
        <div className="hero-side">
          <ul className="hero-list">
            {/* accounts are not built yet, so this says so rather than going nowhere */}
            <li className="hero-row">
              <button type="button" className="hero-row__inner" onClick={() => setSignInNote((v) => !v)} aria-expanded={signInNote}>
                <span className="hero-row__text">
                  <span className="hero-row__label">Sign in</span>
                </span>
              </button>
            </li>
            <li className="hero-row hero-row--scan">
              <button type="button" className="hero-row__inner" onClick={showScan} aria-expanded={open === "scan"}>
                <RowText row={ROWS[0]} />
              </button>
              {qrShown ? (
                <div className="hero-qr" ref={qrRef}>
                  <div className="code">
                    {qr ? (
                      <>
                        {/* data URL, so next/image has nothing to optimize */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={qr} alt="QR code that opens the capture page on your phone" />
                      </>
                    ) : null}
                    <span className="hero-qr__scan" aria-hidden="true" />
                  </div>
                  <small>
                    Point your phone here, or <a href={captureUrl}>open capture on this device</a>.
                  </small>
                </div>
              ) : null}
            </li>
            <li className="hero-row hero-row--type">
              <button
                type="button"
                className="hero-row__inner"
                onClick={showType}
                aria-expanded={open === "type"}
                tabIndex={typeShown ? -1 : 0}
                aria-hidden={typeShown || undefined}
              >
                <span className="hero-row__text">
                  <span className="hero-row__label" ref={typeLabelRef}>
                    {ROWS[1].label}
                  </span>
                </span>
              </button>
              {typeShown ? (
                <form className="hero-type" ref={formRef} onSubmit={submitAddress}>
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
                    onBlur={(e) => {
                      // leaving an empty field puts the option back
                      const next = e.relatedTarget as Node | null;
                      if (!address.trim() && !(next && formRef.current?.contains(next))) setOpen(null);
                    }}
                  />
                  <button type="submit" className="hero-row__go">
                    Go
                  </button>
                  <span className="hero-type__line" aria-hidden="true" />
                </form>
              ) : null}
            </li>
            <li className="hero-row">
              <WipeLink href="/rooms" className="hero-row__inner">
                <RowText row={ROWS[2]} />
              </WipeLink>
            </li>
          </ul>

          {signInNote ? (
            <small className="hero-error hero-note" role="status">
              Accounts are coming soon.
            </small>
          ) : null}

          {addressError ? (
            <small className="hero-error" id="hero-address-error" role="alert">
              {addressError}
            </small>
          ) : null}

        </div>

        <footer className="hero-credit">
          <p>Built at LA Hacks 2026</p>
          <nav aria-label="Project links">
            <a href="https://github.com/silaswu4/tadaima" target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
            <a href="https://lahacks.com" target="_blank" rel="noreferrer">
              LA Hacks ↗
            </a>
          </nav>
        </footer>
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
