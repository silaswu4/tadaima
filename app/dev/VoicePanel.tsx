"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useRef, useState } from "react";
import type { PlanProposal, RoomPlan } from "@/backend/contracts";
import { voiceClientTools } from "@/backend/voice/clientTools";
import { api } from "./api";

interface Line {
  role: "user" | "agent" | "system";
  text: string;
}

export function VoicePanel(props: {
  projectId: string;
  getSelectedItemId: () => string | null;
  onPlan: (plan: RoomPlan) => void;
  onProposal: (p: PlanProposal) => void;
}) {
  return (
    <ConversationProvider>
      <Voice {...props} />
    </ConversationProvider>
  );
}

function Voice({
  projectId,
  getSelectedItemId,
  onPlan,
  onProposal,
}: {
  projectId: string;
  getSelectedItemId: () => string | null;
  onPlan: (plan: RoomPlan) => void;
  onProposal: (p: PlanProposal) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const push = (l: Line) => setLines((xs) => [...xs.slice(-60), l]);

  // keep callbacks fresh without rebuilding the tools mid-session
  const cb = useRef({ getSelectedItemId, onPlan, onProposal });
  useEffect(() => {
    cb.current = { getSelectedItemId, onPlan, onProposal };
  });

  const buildTools = () => {
    const t = voiceClientTools({
      projectId,
      getSelectedItemId: () => cb.current.getSelectedItemId(),
      onPlan: (p) => cb.current.onPlan(p),
      onProposal: (p) => cb.current.onProposal(p),
    });
    // log each tool call into the transcript
    return Object.fromEntries(
      Object.entries(t).map(([name, fn]) => [
        name,
        async (params: Record<string, unknown>) => {
          push({ role: "system", text: `tool ${name}(${Object.keys(params ?? {}).length ? JSON.stringify(params) : ""})` });
          const out = await (fn as (p: Record<string, unknown>) => Promise<string>)(params);
          push({ role: "system", text: `tool ${name} -> ${out}` });
          return out;
        },
      ]),
    );
  };

  const convo = useConversation({
    onMessage: (m) => push({ role: m.source === "user" ? "user" : "agent", text: m.message }),
    onError: (message) => setErr(message),
    onDisconnect: () => push({ role: "system", text: "disconnected" }),
  });

  const live = convo.status === "connected" || convo.status === "connecting";

  async function start() {
    setErr(null);
    setBusy(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser has no microphone API (needs https or localhost).");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        const name = (e as DOMException).name;
        throw new Error(
          name === "NotAllowedError"
            ? "Microphone permission denied. Allow mic access for localhost in the browser and try again."
            : name === "NotFoundError"
              ? "No microphone found."
              : `Microphone error: ${(e as Error).message}`,
        );
      }
      const r = await api<{ token: string }>("GET", "/api/voice/token");
      if (!r.ok || !r.data) throw new Error(`Token fetch failed: ${r.error}`);
      push({ role: "system", text: `session starting for ${projectId}` });
      convo.startSession({ conversationToken: r.data.token, connectionType: "webrtc", clientTools: buildTools() });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block size-2 rounded-full ${
            convo.status === "connected" ? "bg-emerald-500" : convo.status === "connecting" ? "bg-amber-400" : convo.status === "error" ? "bg-red-500" : "bg-zinc-300"
          }`}
        />
        <span className="text-sm text-zinc-700">{convo.status}</span>
        {convo.status === "connected" && <span className="text-xs text-zinc-500">{convo.isSpeaking ? "agent speaking" : "listening"}</span>}
        <div className="ml-auto flex gap-2">
          {live ? (
            <>
              <button className="btn" onClick={() => convo.setMuted(!convo.isMuted)}>
                {convo.isMuted ? "Unmute" : "Mute"}
              </button>
              <button className="btn btn-danger" onClick={() => convo.endSession()}>
                Stop
              </button>
            </>
          ) : (
            <button className="btn btn-primary" disabled={busy} onClick={start}>
              {busy ? "Starting..." : "Start voice"}
            </button>
          )}
        </div>
      </div>
      {(err || convo.message) && <p className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">{err ?? convo.message}</p>}
      <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs">
        {lines.length === 0 ? (
          <p className="text-zinc-400">Transcript shows here. Voice tool calls update the map and proposal.</p>
        ) : (
          lines.map((l, i) => (
            <p key={i} className={l.role === "system" ? "text-zinc-400" : l.role === "user" ? "text-zinc-900" : "text-blue-700"}>
              <span className="font-medium">{l.role === "system" ? "" : l.role === "user" ? "you: " : "agent: "}</span>
              {l.text}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
