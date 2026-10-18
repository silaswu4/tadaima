"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "./RoomAgentVoice.css";

export type RoomAgentVoiceProps = {
  projectId: string;
  tools: Record<string, (params: Record<string, unknown>) => Promise<string>>;
  disabled?: boolean;
  update?: { id: string; text: string };
};

type Line = { role: "user" | "agent"; text: string };
type Attempt = {
  controller: AbortController;
  connected: boolean;
  complete: (error?: string) => void;
};

/** Mount this behind a dynamic import; the SDK and microphone stay off the room's startup path. */
export function RoomAgentVoice(props: RoomAgentVoiceProps) {
  return <ConversationProvider key={props.projectId}><VoiceSession {...props} /></ConversationProvider>;
}

function VoiceSession({ tools, disabled = false, update }: RoomAgentVoiceProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const mounted = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const latest = useRef({ tools, disabled, update });
  const lastUpdate = useRef(update?.id);
  useLayoutEffect(() => { latest.current = { tools, disabled, update }; }, [tools, disabled, update]);
  const conversation = useConversation();
  const { endSession, startSession, sendUserMessage, status } = conversation;

  const stop = useCallback(() => {
    const current = attempt.current;
    attempt.current = null;
    current?.controller.abort();
    current?.complete();
    // The provider also tears down a connection that resolves after this call.
    endSession();
    if (mounted.current) setStarting(false);
  }, [endSession]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); };
  }, [stop]);

  useEffect(() => { if (disabled) stop(); }, [disabled, stop]);

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
    const current: Attempt = { controller: new AbortController(), connected: false, complete: () => {} };
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
      if (!response.ok) {
        throw new Error(response.status === 503 ? "Voice is not configured on this server yet." : "Could not authorize voice. Please try again.");
      }
      const body: unknown = await response.json();
      if (!active()) return;
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
      const clientTools = Object.fromEntries(Object.keys(latest.current.tools).map((name) => [name,
        async (params: Record<string, unknown>) => {
          if (!active() || !current.connected || latest.current.disabled) return "Not performed: this voice session is no longer active.";
          const tool = latest.current.tools[name];
          if (!tool) return "Not performed: this action is no longer available.";
          return tool(params);
        },
      ]));
      startSession({
        conversationToken: token, connectionType: "webrtc", clientTools,
        onConnect: () => {
          if (!active()) return;
          current.connected = true;
          lastUpdate.current = latest.current.update?.id;
          current.complete();
        },
        onMessage: (message) => {
          if (!active() || (message.source !== "user" && message.source !== "ai")) return;
          const text = message.message.trim().slice(0, 4000);
          if (message.source === "user" && text.startsWith("[app update]")) return;
          if (text) setLines((previous) => [...previous.slice(-39), { role: message.source === "user" ? "user" : "agent", text }]);
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
        onDisconnect: () => {
          if (!active()) return;
          const detail = current.connected ? undefined : "Voice disconnected before it was ready. Please try again.";
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
  return (
    <section className="room-agent-voice__voice" aria-label="Voice assistant">
      <p role="status">{live ? conversation.isSpeaking ? "Assistant speaking" : conversation.isMuted ? "Microphone muted" : "Listening" : pending ? "Connecting voice…" : "Voice is off"}</p>
      <div className="room-agent-voice__controls">
        {live ? <button type="button" className="room-x__chip-btn" onClick={() => conversation.setMuted(!conversation.isMuted)}>{conversation.isMuted ? "Unmute" : "Mute"}</button> : null}
        {live || pending
          ? <button type="button" className="room-x__chip-btn" onClick={stop}>Stop voice</button>
          : <button type="button" className="room-x__chip-btn" disabled={disabled} onClick={() => { void start(); }}>Start voice</button>}
      </div>
      {error ? <p role="alert" className="room-agent-voice__error">{error}</p> : null}
      <p className="room-agent-voice__note">Starting voice enables your microphone. Stop voice to end the conversation.</p>
      {lines.length ? <div className="room-agent-voice__transcript" role="log" aria-label="Voice transcript" aria-live="polite" aria-relevant="additions">
        {lines.map((line, index) => <p key={index}><strong>{line.role === "user" ? "You" : "Assistant"}:</strong> {line.text}</p>)}
      </div> : null}
    </section>
  );
}

export default RoomAgentVoice;
