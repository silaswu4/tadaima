"use client";
// The browse stage's window: a small browser card with an address bar, showing the agent's live browser
// (an embedded Browser Use live view) or, when that can't open, the building's listing photo as a replay.
import { useLayoutEffect, useRef } from "react";
import type { BrowseMode } from "./useLobbyRun";
import { LISTING_PHOTO } from "./stages";

/**
 * The live view renders a desktop browser; it is drawn at this size and scaled to fit the card. Its picture
 * sits top left and stops a little short of the frame (about 1266 x 694 at this size), so the card crops to that.
 */
const VIEW_W = 1280;
const VIEW_H = 800;
const SHOWN_W = 1266;

export default function BrowserFrame({ mode, liveUrl, site }: { mode: BrowseMode; liveUrl: string | null; site: string }) {
  const body = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const fit = () => el.style.setProperty("--bf-scale", String(el.clientWidth / SHOWN_W));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chip = mode === "live" && liveUrl ? "Live" : mode === "replay" ? "Replay" : "Connecting";
  return (
    <figure className="browser-frame" data-mode={mode}>
      <div className="browser-frame__bar">
        <span className="browser-frame__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="browser-frame__url">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 7V5.5a3 3 0 0 1 6 0V7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.6" fill="currentColor" />
          </svg>
          <span>{site}</span>
        </span>
        <span className={`browser-frame__chip browser-frame__chip--${chip.toLowerCase()}`}>
          <i aria-hidden="true" />
          {chip}
        </span>
      </div>
      <div className="browser-frame__body" ref={body}>
        {mode === "live" && liveUrl ? (
          <iframe
            className="browser-frame__live"
            src={liveUrl}
            title="The agent's live browser"
            width={VIEW_W}
            height={VIEW_H}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin"
            tabIndex={-1}
          />
        ) : mode === "replay" ? (
          <div className="browser-frame__replay">
            {/* a remote listing photo, shown as is; next/image would need the host allow-listed */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LISTING_PHOTO} alt="Atrium Westwood living room, from the building's listing" referrerPolicy="no-referrer" />
            <span className="browser-frame__scan" aria-hidden="true" />
          </div>
        ) : (
          <div className="browser-frame__loading" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </figure>
  );
}
