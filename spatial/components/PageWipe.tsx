"use client";

import gsap from "gsap";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import mark from "../assets/tadaima-mark.png";
import "./PageWipe.css";

// One panel at a time. It lives outside React on purpose: it has to survive the
// route change, then lifts off whatever page arrived underneath it.
let panel: HTMLDivElement | null = null;
// pages that arrive under the panel and still need a moment (a gallery building, a room loading)
let holds = 0;

/** True while a wipe is covering the screen, so the next page can skip its own intro cover. */
export function wipeInProgress(): boolean {
  return panel !== null;
}

function wipeTo(href: string, push: (href: string) => void) {
  if (panel) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    push(href);
    return;
  }
  const target = new URL(href, window.location.href).pathname;
  const el = document.createElement("div");
  el.className = "page-wipe";
  el.setAttribute("aria-hidden", "true");
  const icon = document.createElement("span");
  icon.className = "page-wipe__mark";
  icon.style.setProperty("-webkit-mask-image", `url(${mark.src})`);
  icon.style.setProperty("mask-image", `url(${mark.src})`);
  el.appendChild(icon);
  // start below the screen through GSAP itself; a CSS transform here gets added on top of yPercent
  gsap.set(el, { yPercent: 100 });
  document.body.appendChild(el);
  panel = el;

  const lift = () =>
    gsap.to(el, {
      yPercent: -100,
      duration: 0.75,
      ease: "power3.inOut",
      delay: 0.15,
      onComplete: () => {
        el.remove();
        panel = null;
      },
    });

  gsap
    .timeline()
    .to(el, { yPercent: 0, duration: 0.6, ease: "power3.inOut" })
    .fromTo(icon, { autoAlpha: 0, scale: 0.9 }, { autoAlpha: 1, scale: 1, duration: 0.35, ease: "power2.out" }, 0.3)
    .add(() => {
      push(href);
      const started = performance.now();
      // wait for the new route to commit and for anything it is holding the panel for,
      // then give it two frames to paint; never stay down longer than a few seconds
      const settle = () => {
        const arrived = window.location.pathname === target;
        const elapsed = performance.now() - started;
        if ((arrived && holds === 0 && elapsed > 120) || elapsed > 4000) {
          requestAnimationFrame(() => requestAnimationFrame(lift));
        } else {
          window.setTimeout(settle, 50);
        }
      };
      settle();
    });
}

/** Keep the panel down until `ready` while this page arrived under it. Safe to call when no wipe is running. */
export function useWipeHold(ready: boolean) {
  const holding = useRef(false);
  useEffect(() => {
    if (!ready && panel && !holding.current) {
      holding.current = true;
      holds += 1;
    }
    if (ready && holding.current) {
      holding.current = false;
      holds -= 1;
    }
  }, [ready]);
  useEffect(
    () => () => {
      if (holding.current) {
        holding.current = false;
        holds -= 1;
      }
    },
    [],
  );
}

/** Navigate with the panel wipe. */
export function useWipe() {
  const router = useRouter();
  return useCallback((href: string) => wipeTo(href, (h) => router.push(h)), [router]);
}

/** A Link that plays the wipe on a plain left click; new-tab clicks behave as usual. */
export function WipeLink({ href, onClick, ...rest }: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const wipe = useWipe();
  return (
    <Link
      href={href}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        wipe(href);
      }}
    />
  );
}
