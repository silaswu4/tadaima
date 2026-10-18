"use client";

import gsap from "gsap";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, type ComponentProps } from "react";
import mark from "../assets/tadaima-mark.png";
import "./PageWipe.css";

// One panel at a time. It lives outside React on purpose: it has to survive the
// route change, then lifts off whatever page arrived underneath it.
let panel: HTMLDivElement | null = null;

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
    .fromTo(el, { yPercent: 100 }, { yPercent: 0, duration: 0.6, ease: "power3.inOut" })
    .fromTo(icon, { autoAlpha: 0, scale: 0.9 }, { autoAlpha: 1, scale: 1, duration: 0.35, ease: "power2.out" }, 0.3)
    .add(() => {
      push(href);
      const started = performance.now();
      // wait for the new route to commit, then give it two frames to paint
      const settle = () => {
        if (window.location.pathname === target || performance.now() - started > 6000) {
          requestAnimationFrame(() => requestAnimationFrame(lift));
        } else {
          window.setTimeout(settle, 50);
        }
      };
      settle();
    });
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
