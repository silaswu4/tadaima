"use client";

import { useEffect, useState, type FormEvent } from "react";
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

/** Lists scans sent from TadaimaScan to the reconstruction service. Hidden when the service is not configured. */
export function PhoneScanInbox({ onImported }: { onImported: (room: RoomRecord) => void }) {
  const [scans, setScans] = useState<PhoneScan[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [key, setKey] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [openedAt] = useState(() => Date.now());

  useEffect(() => {
    let live = true, timer = 0, locked = false;
    const poll = async () => {
      try {
        const response = await fetch("/api/scans", { cache: "no-store" });
        if (!live) return;
        // 401: a deployed site that needs the scan key. 503: the service is off; stay out of the way.
        locked = response.status === 401;
        setLocked(locked);
        if (!response.ok) { setScans(null); return; }
        const { scans: all } = await response.json() as { scans: PhoneScan[] };
        if (live) setScans(all.filter((scan) => Date.now() - Date.parse(scan.createdAt) < RECENT_MS));
      } catch { if (live) setScans(null); }
      // Locked: wait for the key form (it bumps `attempt`) instead of logging a 401 every few seconds.
      finally { if (live && !locked && !document.hidden) timer = window.setTimeout(poll, POLL_MS); }
    };
    const resume = () => { if (!document.hidden && !locked) { window.clearTimeout(timer); poll(); } };
    poll();
    document.addEventListener("visibilitychange", resume);
    return () => { live = false; window.clearTimeout(timer); document.removeEventListener("visibilitychange", resume); };
  }, [attempt]);

  async function connect(event: FormEvent) {
    event.preventDefault(); setError("");
    const response = await fetch("/api/scans/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
    if (!response.ok) { setError("That scan key is not right."); return; }
    setKey(""); setAttempt((count) => count + 1);
  }

  if (locked) return <aside className="phone-inbox" aria-label="Scans from your iPhone">
    <p className="phone-inbox__eyebrow">FROM YOUR IPHONE</p>
    <form className="phone-inbox__connect" onSubmit={connect}>
      <input type="password" autoComplete="off" placeholder="Scan key" aria-label="Scan key" value={key} onChange={(event) => setKey(event.target.value)} />
      <button className="phone-inbox__enter" type="submit" disabled={!key.trim()}>Show scans</button>
    </form>
    {error ? <p className="phone-inbox__error" role="alert">{error}</p> : null}
  </aside>;

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
