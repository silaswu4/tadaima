"use client";

import { useState } from "react";

type Receipt = { signature: string; explorerUrl: string; sha256: string; revision: number; items: number };

/** Records the approved basket for this room revision as a Solana devnet memo receipt. */
export function RoomSolanaReceipt({ projectId, revision }: { projectId: string; revision: number }) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = receipt?.revision === revision ? receipt : null;

  async function record() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/projects/${projectId}/solana-receipt`, { method: "POST", credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "The receipt could not be recorded.");
      setReceipt(body as Receipt);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The receipt could not be recorded."); }
    finally { setBusy(false); }
  }

  return <div className="room-x__solana">
    {current ? <p className="room-x__panel-sub">
      Approval recorded on Solana devnet · <a href={current.explorerUrl} target="_blank" rel="noreferrer">view transaction</a><br />
      <span title={current.sha256}>sha256 {current.sha256.slice(0, 12)}… · {current.items} items · revision {current.revision}</span>
    </p> : <button type="button" className="room-x__chip-btn" onClick={record} disabled={busy}>
      {busy ? "Recording on Solana…" : "Record approval on Solana (devnet)"}
    </button>}
    {error ? <p className="room-x__panel-sub" role="alert">{error}</p> : null}
  </div>;
}
