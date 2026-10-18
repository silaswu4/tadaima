"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { VoiceBeam } from "voice-glow";
import "./RoomAgentVoice.css";
import "./RoomVoice.css";

export type RoomAgentVoiceProps = {
  projectId: string;
  getTools(): Record<string, (params: Record<string, unknown>) => Promise<string>>;
  disabled?: boolean;
  update?: { id: string; text: string };
  /** Set only after an explicit click on the room's primary Talk control. */
  autoStart?: boolean;
};

type Line = { role: "user" | "agent"; text: string };
type Attempt = {
  controller: AbortController;
  connected: boolean;
  connectedAt: number;
  complete: (error?: string) => void;
};

/** Mount this behind a dynamic import; the SDK and microphone stay off the room's startup path. */
export function RoomAgentVoice(props: RoomAgentVoiceProps) {
  return <ConversationProvider key={props.projectId}><VoiceSession {...props} /></ConversationProvider>;
}

function VoiceSession({ getTools, disabled = false, update, autoStart }: RoomAgentVoiceProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [working, setWorking] = useState(0);
  const [caption, setCaption] = useState("");
  const captionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const latest = useRef({ getTools, disabled, update });
  const lastUpdate = useRef(update?.id);
  useLayoutEffect(() => { latest.current = { getTools, disabled, update }; }, [getTools, disabled, update]);
  const conversation = useConversation();
  const { endSession, startSession, sendUserMessage, status } = conversation;

  const stop = useCallback(() => {
    const current = attempt.current;
    attempt.current = null;
    current?.controller.abort();
    current?.complete();
    clearTimeout(captionTimer.current);
    // The provider also tears down a connection that resolves after this call.
    endSession();
    if (mounted.current) { setStarting(false); setWorking(0); setCaption(""); }
  }, [endSession]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); };
  }, [stop]);

  useEffect(() => { if (disabled) stop(); }, [disabled, stop]);

  useEffect(() => {
    // The lazy owner mounts this only in response to the shopper's Talk click.
    if (autoStart) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!update || lastUpdate.current === update.id) return;
    lastUpdate.current = update.id;
    if (status === "connected" && attempt.current?.connected && !attempt.current.controller.signal.aborted) {
      try { sendUserMessage(update.text.slice(0, 4000)); }
      catch {
        const session = attempt.current;
        queueMicrotask(() => {
          if (mounted.current && attempt.current === session) {
            setError("The voice connection was interrupted. Please try again."); stop();
          }
        });
      }
    }
  }, [update, status, sendUserMessage, stop]);

  async function start() {
    if (latest.current.disabled || attempt.current || status === "connecting") return;
    const current: Attempt = { controller: new AbortController(), connected: false, connectedAt: 0, complete: () => {} };
    attempt.current = current;
    const active = () => mounted.current && attempt.current === current && !current.controller.signal.aborted;
    setStarting(true);
    setError("");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Voice needs HTTPS or localhost and a browser with microphone support.");
      }
      const response = await fetch("/api/voice/token", {
        credentials: "same-origin", cache: "no-store", signal: current.controller.signal,
      });
      if (!active()) return;
      const body: unknown = await response.json().catch(() => null);
      if (!active()) return;
      if (!response.ok) {
        throw new Error(response.status === 402 ? "Voice is out of ElevenLabs credits. Add credits to talk to the room."
          : response.status === 503 ? "Voice is not configured on this server yet." : "Could not authorize voice. Please try again.");
      }
      const token = body && typeof body === "object" && "token" in body ? body.token : null;
      if (typeof token !== "string" || !token) throw new Error("The voice service returned an unreadable response.");

      // This installed React SDK returns void from startSession. Await the
      // actual callback outcome instead of treating that return as connected.
      let timeout: ReturnType<typeof setTimeout>;
      const connected = new Promise<string | undefined>((resolve) => {
        let settled = false;
        current.complete = (message) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(message);
        };
        timeout = setTimeout(() => current.complete("Voice took too long to connect. Please try again."), 30_000);
      });
      const tools = latest.current.getTools();
      const clientTools = Object.fromEntries(Object.keys(tools).map((name) => [name,
        async (params: Record<string, unknown>) => {
          if (!active() || !current.connected || latest.current.disabled) return "Not performed: this voice session is no longer active.";
          const tool = tools[name];
          if (!tool) return "Not performed: this action is no longer available.";
          setWorking((value) => value + 1);
          try { return await tool(params); }
          finally { if (active()) setWorking((value) => Math.max(0, value - 1)); }
        },
      ]));
      startSession({
        conversationToken: token, connectionType: "webrtc", clientTools,
        onConnect: () => {
          if (!active()) return;
          current.connected = true;
          current.connectedAt = Date.now();
          lastUpdate.current = latest.current.update?.id;
          current.complete();
        },
        onMessage: (message) => {
          if (!active() || (message.source !== "user" && message.source !== "ai")) return;
          const text = (message.source === "ai" ? message.message.replace(/\[[a-z][a-z ]{0,24}\]\s*/gi, "") : message.message).trim().slice(0, 4000);
          if (message.source === "user" && text.startsWith("[app update]")) return;
          if (text) setLines((previous) => [...previous.slice(-39), { role: message.source === "user" ? "user" : "agent", text }]);
          if (text && message.source === "ai") {
            clearTimeout(captionTimer.current);
            setCaption(text);
            captionTimer.current = setTimeout(() => { if (active()) setCaption(""); }, 9000);
          }
        },
        onError: (message) => {
          if (!active()) return;
          const detail = /permission|notallowed|denied/i.test(message)
            ? "Microphone permission was denied. Allow microphone access and try again."
            : /notfound|no.*microphone|device.*not/i.test(message)
              ? "No microphone was found. Connect one and try again."
              : "Voice could not connect or was interrupted. Please try again.";
          setError(detail);
          current.complete(detail);
          stop();
        },
        onDisconnect: (details) => {
          if (!active()) return;
          const detail = details.reason === "user" ? undefined
            : !current.connected || Date.now() - current.connectedAt < 3000 ? "Voice ended immediately. Check ElevenLabs credits and agent settings, then try again."
              : details.reason === "error" ? "The voice connection was interrupted. Please try again." : undefined;
          if (detail) setError(detail);
          current.complete(detail);
          stop();
        },
      });
      const failure = await connected;
      if (active() && failure) throw new Error(failure);
    } catch (cause) {
      if (active()) {
        setError(cause instanceof Error && cause.name !== "TypeError" ? cause.message : "Could not reach the voice service. Please try again.");
        stop();
      }
    } finally {
      if (mounted.current && (attempt.current === current || !attempt.current)) setStarting(false);
    }
  }

  const live = status === "connected";
  const pending = starting || status === "connecting";
  const conversationRef = useRef(conversation);
  const workingRef = useRef(false);
  useLayoutEffect(() => { conversationRef.current = conversation; workingRef.current = working > 0; });
  const gather = useRef({ value: 0, at: 0 });
  const level = () => {
    const value = conversationRef.current;
    return value.status === "connected" ? Math.max(value.getInputVolume(), value.getOutputVolume()) : 0;
  };
  const motion = () => {
    const now = performance.now(), value = gather.current;
    const dt = value.at ? Math.min(0.1, (now - value.at) / 1000) : 0;
    value.at = now;
    value.value += ((workingRef.current ? 1 : 0) - value.value) * Math.min(1, dt * 5);
    if (value.value < 0.01) return null;
    return { gather: value.value, offset: Math.sin(now / 520) * 0.75 * value.value, stretch: Math.abs(Math.cos(now / 520)) * 0.3, heldLevel: 0.55 };
  };
  const label = pending ? "Connecting" : !live ? "Talk" : working ? "Working" : conversation.isSpeaking ? "Speaking" : conversation.isMuted ? "Muted" : "Listening";
  return <div className="room-voice" aria-label="Voice assistant">
    {caption || error ? <p className="room-voice__caption" data-error={error ? true : undefined} role="status" aria-live="polite">{error || caption}</p> : null}
    <VoiceBeam type="pill" theme="light" colorVariant="sunset" level={level} motion={motion} active={live || pending} className="room-voice__beam">
      <button type="button" className="room-x__pill room-voice__btn" data-live={live || undefined} onClick={live || pending ? stop : () => { void start(); }} disabled={disabled && !live && !pending} aria-pressed={live} aria-label={live || pending ? "Stop talking to the room" : "Talk to the room"}>
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><rect x="7" y="2.5" width="6" height="10" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" /></svg><span>{label}</span>
      </button>
    </VoiceBeam>
    {live ? <button type="button" className="room-x__pill room-voice__mute" onClick={() => conversation.setMuted(!conversation.isMuted)}>{conversation.isMuted ? "Unmute" : "Mute"}</button> : null}
    {lines.length ? <details className="room-voice__transcript-menu"><summary>Transcript</summary><div className="room-agent-voice__transcript" role="log" aria-label="Voice transcript" aria-live="polite" aria-relevant="additions">
      {lines.map((line, index) => <p key={index}><strong>{line.role === "user" ? "You" : "Assistant"}:</strong> {line.text}</p>)}
    </div></details> : null}
  </div>;
}

export default RoomAgentVoice;
