"use client";

import { useEffect, useState } from "react";
import { importPhoneScan, type RoomRecord } from "../rooms/registry";
import "./PhoneScanInbox.css";

interface PhoneScan {
  id: string; status: "queued" | "running" | "succeeded" | "failed"; createdAt: string;
  roomStatus: string | null; warnings: string[]; photoCount: number | null; itemCount: number | null;
  ready: boolean; error: string | null;
}

const POLL_MS = 3000;
const RECENT_MS = 6 * 60 * 60 * 1000;

function describe(scan: PhoneScan): string {
  if (scan.status === "queued") return "Received. Waiting for the reconstruction worker…";
  if (scan.status === "running") return "Building your room in Blender. Photo-textured rooms take a minute or two.";
  const parts = [scan.photoCount ? `${scan.photoCount} photos` : "layout only", scan.itemCount ? `${scan.itemCount} furniture pieces` : null];
  return `Ready · ${parts.filter(Boolean).join(" · ")}. Geometry is a scan draft; check sizes before buying.`;
}

/** Lists scans sent from TadaimaScan to this machine's reconstruction service. Hidden when the service is not configured. */
export function PhoneScanInbox({ onImported }: { onImported: (room: RoomRecord) => void }) {
  const [scans, setScans] = useState<PhoneScan[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [openedAt] = useState(() => Date.now());

  useEffect(() => {
    let live = true, timer = 0;
    const poll = async () => {
      try {
        const response = await fetch("/api/scans", { cache: "no-store" });
        if (!live) return;
        // 401/503: not on the scanning Mac or the service is off. Stay out of the way.
        if (!response.ok) { setScans(null); return; }
        const { scans: all } = await response.json() as { scans: PhoneScan[] };
        if (live) setScans(all.filter((scan) => Date.now() - Date.parse(scan.createdAt) < RECENT_MS));
      } catch { if (live) setScans(null); }
      finally { if (live && !document.hidden) timer = window.setTimeout(poll, POLL_MS); }
    };
    const resume = () => { if (!document.hidden) { window.clearTimeout(timer); poll(); } };
    poll();
    document.addEventListener("visibilitychange", resume);
    return () => { live = false; window.clearTimeout(timer); document.removeEventListener("visibilitychange", resume); };
  }, []);

  if (!scans || scans.length === 0) return null;

  async function enter(scan: PhoneScan) {
    setOpening(scan.id); setError("");
    try { onImported(await importPhoneScan(scan.id, { photoTextured: !!scan.photoCount })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The scan could not be opened."); }
    finally { setOpening(null); }
  }

  return <aside className="phone-inbox" aria-label="Scans from your iPhone" aria-live="polite">
    <p className="phone-inbox__eyebrow">FROM YOUR IPHONE</p>
    <ol className="phone-inbox__list">
      {scans.map((scan) => <li key={scan.id} className={`phone-inbox__scan${Date.parse(scan.createdAt) > openedAt ? " phone-inbox__fresh" : ""}`}>
        <div className="phone-inbox__title"><span>Room scan</span><time dateTime={scan.createdAt}>{new Date(scan.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div>
        {scan.status === "failed"
          ? <p className="phone-inbox__error">{scan.error ?? "This scan could not be rebuilt."} Scan again on the phone.</p>
          : <p className="phone-inbox__detail">{describe(scan)}</p>}
        {scan.ready ? <button className="phone-inbox__enter" type="button" disabled={opening !== null} onClick={() => enter(scan)}>
          {opening === scan.id ? "Saving room…" : "Enter room"}
        </button> : null}
      </li>)}
    </ol>
    {error ? <p className="phone-inbox__error" role="alert">{error}</p> : null}
  </aside>;
}

export default PhoneScanInbox;
