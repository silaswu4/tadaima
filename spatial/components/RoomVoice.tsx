"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useLayoutEffect, useRef, useState } from "react";
import { VoiceBeam } from "voice-glow";
import type { FloorSpot, Job, ShopJobOutput } from "../../backend/contracts";
import { voiceClientTools } from "../../backend/voice/clientTools";
import "./RoomVoice.css";

/**
 * Talk to the room. One pill in the bottom tools starts a voice session with
 * the shopping agent; "here" is the floor spot the shopper is looking at. The
 * agent's tools act on this room's private server project, and every change
 * comes back through `onPlanChanged` so the scene redraws.
 */
type Props = {
  /** The room's server project; voice stays off until the room is connected. */
  projectId: string | null;
  getSpot: () => FloorSpot | null;
  getSelectedItemId: () => string | null;
  onPlanChanged: () => void;
  onShop: (job: Job<ShopJobOutput>) => void;
  onPlaced?: (itemId: string) => void;
  disabled?: boolean;
};

export function RoomVoice(props: Props) {
  return (
    <ConversationProvider>
      <Voice {...props} />
    </ConversationProvider>
  );
}

const MIC_ERRORS: Record<string, string> = {
  NotAllowedError: "Microphone blocked. Allow it in the browser to talk to the room.",
  NotFoundError: "No microphone found.",
};

function Voice({ projectId, disabled, ...rest }: Props) {
  const cb = useRef(rest);
  useLayoutEffect(() => {
    cb.current = rest;
  });
  const [caption, setCaption] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(0);
  const [starting, setStarting] = useState(false);
  const active = useRef(false);
  const connectedAt = useRef(0);
  const captionTimer = useRef<number | undefined>(undefined);

  const say = (text: string | null) => {
    window.clearTimeout(captionTimer.current);
    setCaption(text);
    if (text) captionTimer.current = window.setTimeout(() => setCaption(null), 9000);
  };

  const convo = useConversation({
    onMessage: (m) => {
      // drop the voice's expressive tags like [helpful] from the caption
      if (m.source !== "user") say(m.message.replace(/\[[a-z][a-z ]{0,24}\]\s*/gi, "").trim() || null);
    },
    onError: (message) => setError(typeof message === "string" ? message : "Voice ran into a problem."),
    onConnect: () => {
      connectedAt.current = Date.now();
    },
    onDisconnect: (details) => {
      // hung up on right away, not by the shopper: say so instead of silently going back to "Talk"
      const instant = !connectedAt.current || Date.now() - connectedAt.current < 3000;
      if (active.current && details.reason !== "user") {
        setError(details.reason === "error" ? `Voice disconnected: ${details.message}` : instant ? "The voice service ended the call right away. It may be out of credits." : null);
      }
      active.current = false;
      setWorking(0);
    },
  });
  const convoRef = useRef(convo);
  useLayoutEffect(() => {
    convoRef.current = convo;
  });

  const live = convo.status === "connected" || convo.status === "connecting";

  // dev only: lets browser tests type what the shopper would say
  useLayoutEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __tadaimaVoice?: { say: (text: string) => void; status: () => string } };
    w.__tadaimaVoice = { say: (text) => convoRef.current.sendUserMessage(text), status: () => convoRef.current.status };
    return () => {
      delete w.__tadaimaVoice;
    };
  }, []);

  function tools(id: string) {
    const t = voiceClientTools({
      projectId: id,
      getSelectedItemId: () => cb.current.getSelectedItemId(),
      getSpot: () => cb.current.getSpot(),
      isActive: () => active.current,
      onPlan: () => cb.current.onPlanChanged(),
      onCheckout: () => cb.current.onPlanChanged(),
      onShop: (job) => cb.current.onShop(job),
      onPlaced: (itemId) => cb.current.onPlaced?.(itemId),
      // a finished live search speaks up on its own
      onShopUpdate: (message) => {
        if (active.current) convoRef.current.sendUserMessage(message);
      },
    });
    // the beam gathers while any tool is working
    return Object.fromEntries(
      Object.entries(t).map(([name, fn]) => [
        name,
        async (params: Record<string, unknown>) => {
          setWorking((n) => n + 1);
          try {
            return await (fn as (p: Record<string, unknown>) => Promise<string>)(params);
          } finally {
            setWorking((n) => Math.max(0, n - 1));
          }
        },
      ]),
    );
  }

  async function start() {
    if (!projectId || starting) return;
    setError(null);
    setStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Voice needs a secure page (https or localhost).");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      } catch (e) {
        throw new Error(MIC_ERRORS[(e as DOMException).name] ?? "The microphone couldn't start.");
      }
      const res = await fetch("/api/voice/token", { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.token) throw new Error(body?.error ?? "Voice isn't available right now.");
      active.current = true;
      connectedAt.current = 0;
      convo.startSession({ conversationToken: body.token, connectionType: "webrtc", clientTools: tools(projectId) });
    } catch (e) {
      active.current = false;
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  function stop() {
    active.current = false;
    convo.endSession();
    say(null);
  }

  const label = starting || convo.status === "connecting" ? "Connecting" : !live ? "Talk" : working ? "Working" : convo.isSpeaking ? "Speaking" : "Listening";
  const level = () => (convoRef.current.status === "connected" ? Math.max(convoRef.current.getInputVolume(), convoRef.current.getOutputVolume()) : 0);
  // while a tool works, gather the glow into one beam that sweeps back and forth
  const workingRef = useRef(false);
  useLayoutEffect(() => {
    workingRef.current = working > 0;
  });
  const gather = useRef({ value: 0, at: 0 });
  const motion = () => {
    const now = performance.now();
    const g = gather.current;
    const dt = g.at ? Math.min(0.1, (now - g.at) / 1000) : 0;
    g.at = now;
    g.value += ((workingRef.current ? 1 : 0) - g.value) * Math.min(1, dt * 5);
    if (g.value < 0.01) return null;
    const sweep = Math.sin(now / 520);
    return { gather: g.value, offset: sweep * 0.75 * g.value, stretch: Math.abs(Math.cos(now / 520)) * 0.3, heldLevel: 0.55 };
  };

  return (
    <div className="room-voice">
      {(caption || error) && (
        <p className="room-voice__caption" data-error={error ? true : undefined} role="status" aria-live="polite">
          {error ?? caption}
        </p>
      )}
      <VoiceBeam type="pill" theme="light" colorVariant="sunset" level={level} motion={motion} active={live} className="room-voice__beam">
        <button
          type="button"
          className="room-x__pill room-voice__btn"
          data-live={live || undefined}
          onClick={live ? stop : start}
          disabled={disabled || !projectId || starting}
          aria-pressed={live}
          aria-label={live ? "Stop talking to the room" : "Talk to the room"}
        >
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <rect x="7" y="2.5" width="6" height="10" rx="3" />
            <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
          </svg>
          <span>{label}</span>
        </button>
      </VoiceBeam>
    </div>
  );
}
