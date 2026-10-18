"use client";
import { useState } from "react";
import type { Job, PlanProposal, ShopJobOutput } from "../../backend/contracts";
import type { RoomFetchConnection } from "../rooms/use-room-fetch";
import "./RoomFetch.css";

type Props = { connection: RoomFetchConnection; busy: boolean; onReview(proposal: PlanProposal): void; onPreview(job: Job<ShopJobOutput>, productId: string): Promise<boolean> };
export function RoomFetch({ connection, busy, onReview, onPreview }: Props) {
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const status = connection.status;
  const connected = status?.status === "connected", waiting = status?.status === "waiting";
  const command = connection.code ? `connect ${connection.code}` : "";
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(true); }
    catch { setMessage("Select and copy the connection message below."); }
  }
  const preview = status?.preview, job = status?.job;
  return <section className="room-fetch" aria-label="Fetch room connection">
    <h3>Continue in Fetch</h3>
    <p className="room-agent__note">Chat with Tadaima in ASI:One using this room’s measured layout, furniture and basket. Review changes here.</p>
    <p role="status" className="room-agent__note">{connected ? "Connected to this scanned room" : waiting ? "Waiting for your connection message" : "No Fetch chat connected"}{status?.expiresAt ? ` · expires ${new Date(status.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</p>
    {waiting && command ? <><label className="room-fetch__code">Send this to the Tadaima agent in <a href="https://asi1.ai" target="_blank" rel="noreferrer">ASI:One</a><input readOnly aria-label="Fetch connection message" value={command} onFocus={(event) => event.currentTarget.select()} /></label><button className="room-x__chip-btn" onClick={() => void copy()}>{copied ? "Copied" : "Copy connection message"}</button><p className="room-agent__note">Keep this code private. It works once, for 10 minutes. The Fetch agent must be running against this website’s backend.</p></> : null}
    {connected ? <><p className="room-agent__note">Try “find a wood chair under $150 that fits” or “make a plan without moving my sofa.” Furniture placements and payments need your confirmation on this website.</p>{status?.proposal ? <button className="room-x__chip-btn" disabled={busy} onClick={() => onReview(status.proposal!)}>Review Fetch proposal</button> : null}{job?.output ? <div className="room-fetch__results"><p className="room-agent__note">Fetch: {job.stage}</p>{job.output.results.filter((result) => result.fits).map((result) => <div key={result.product.id}><span>{result.product.label}{preview?.productId === result.product.id ? " · requested preview" : ""}</span><button className="room-x__chip-btn" disabled={busy || connection.pending} onClick={() => { void onPreview(job, result.product.id).catch((cause) => setMessage(cause instanceof Error ? cause.message : "This piece could not be previewed.")); }}>Preview in room</button></div>)}{!job.output.results.some((result) => result.fits) ? <p className="room-agent__note">No fitting results yet. Try another spot, category or price.</p> : null}</div> : null}</> : null}
    <div className="room-agent__actions">{!connected ? <button className="room-x__chip-btn" disabled={connection.pending || busy} onClick={() => { setCopied(false); void connection.pair(); }}>{waiting ? "New connection code" : "Connect this room to Fetch"}</button> : null}{connected || waiting ? <button className="room-x__text-btn" disabled={connection.pending} onClick={() => void connection.disconnect()}>Disconnect Fetch</button> : null}</div>
    {connection.error || message ? <p className="room-agent__error" role="alert">{connection.error || message}</p> : null}
  </section>;
}
