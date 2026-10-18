"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { VoiceBeam } from "voice-glow";
import "./RoomVoice.css";

export type RoomAgentVoiceProps = {
  projectId: string;
  getTools(): Record<string, (params: Record<string, unknown>) => Promise<string>>;
  disabled?: boolean;
  /** Something the agent should know and say (a finished live search). Sent once per id. */
  update?: { id: string; text: string };
};

/** Mount this behind a dynamic import; the SDK stays off the room's startup path. */
export function RoomAgentVoice(props: RoomAgentVoiceProps) {
  return <ConversationProvider key={props.projectId}><VoiceSession {...props} /></ConversationProvider>;
}

const PTT_KEY = "Space";
/** A press shorter than this is a tap: it latches the mic open (phones, headsets) until the next tap. */
const TAP_MS = 250;
/** Connected but untouched this long: hang up to save credits. The next press reconnects. */
const IDLE_MS = 4 * 60 * 1000;

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * Push to talk. Hold Space (or hold the Talk pill) to speak, let go and the
 * agent answers. Works in first person, where the pointer is captured and
 * nothing can be clicked. The session connects on the first press and stays
 * up, so later presses are instant.
 */
function VoiceSession({ getTools, disabled = false, update }: RoomAgentVoiceProps) {
  const [open, setOpen] = useState(false); // mic open: held or latched
  const [latched, setLatched] = useState(false);
  const [error, setError] = useState("");
  const [caption, setCaption] = useState("");
  const [working, setWorking] = useState(0);
  const conversation = useConversation({ micMuted: !open });
  const convo = useRef(conversation);
  const latest = useRef({ getTools, disabled });
  const pressedAt = useRef(0);
  const lastUse = useRef(0);
  const connecting = useRef(false);
  const captionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sent = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    convo.current = conversation;
    latest.current = { getTools, disabled };
  });

  const live = conversation.status === "connected";
  const pending = conversation.status === "connecting";

  async function connect() {
    if (connecting.current || convo.current.status === "connected" || convo.current.status === "connecting") return;
    connecting.current = true;
    setError("");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Voice needs HTTPS or localhost and a microphone.");
      const res = await fetch("/api/voice/token", { credentials: "same-origin", cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
      if (!res.ok || !body?.token) throw new Error(body?.error ?? "Voice isn't available right now.");
      const tools = latest.current.getTools();
      const clientTools = Object.fromEntries(
        Object.entries(tools).map(([name, tool]) => [
          name,
          async (params: Record<string, unknown>) => {
            setWorking((n) => n + 1);
            lastUse.current = Date.now();
            try {
              return await tool(params);
            } finally {
              setWorking((n) => Math.max(0, n - 1));
            }
          },
        ]),
      );
      convo.current.startSession({
        conversationToken: body.token,
        connectionType: "webrtc",
        clientTools,
        onMessage: (m) => {
          if (m.source !== "ai") return;
          const text = m.message.replace(/\[[a-z][a-z ]{0,24}\]\s*/gi, "").trim();
          if (!text) return;
          lastUse.current = Date.now();
          clearTimeout(captionTimer.current);
          setCaption(text);
          captionTimer.current = setTimeout(() => setCaption(""), 9000);
        },
        onError: (message) => setError(/permission|notallowed|denied/i.test(message) ? "Microphone blocked. Allow it in the browser to talk." : "Voice was interrupted. Press again to reconnect."),
        onDisconnect: (details) => {
          setOpen(false);
          setLatched(false);
          setWorking(0);
          if (details.reason === "error") setError("Voice disconnected. Press again to reconnect.");
        },
      });
      lastUse.current = Date.now();
    } catch (e) {
      setError((e as Error).message);
      setOpen(false);
      setLatched(false);
    } finally {
      connecting.current = false;
    }
  }

  function press() {
    if (latest.current.disabled) return;
    pressedAt.current = Date.now();
    lastUse.current = Date.now();
    setError("");
    setOpen(true);
    void connect();
  }

  function release() {
    if (!pressedAt.current) return;
    const tap = Date.now() - pressedAt.current < TAP_MS;
    pressedAt.current = 0;
    lastUse.current = Date.now();
    if (tap) {
      // a tap toggles hands-free; a hold is push to talk
      const next = !latched;
      setLatched(next);
      setOpen(next);
    } else {
      setLatched(false);
      setOpen(false);
    }
  }

  // hold Space anywhere in the room (not while typing)
  const pressRef = useRef(press);
  const releaseRef = useRef(release);
  useLayoutEffect(() => {
    pressRef.current = press;
    releaseRef.current = release;
  });
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== PTT_KEY || editable(e.target)) return;
      e.preventDefault();
      if (!e.repeat) pressRef.current();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== PTT_KEY || editable(e.target)) return;
      e.preventDefault();
      releaseRef.current();
    };
    window.addEventListener("keydown", down, { capture: true });
    window.addEventListener("keyup", up, { capture: true });
    return () => {
      window.removeEventListener("keydown", down, { capture: true });
      window.removeEventListener("keyup", up, { capture: true });
    };
  }, []);

  // dev only: lets browser tests say what the shopper would
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __tadaimaVoice?: { say(text: string): void; status(): string } };
    w.__tadaimaVoice = { say: (text) => convo.current.sendUserMessage(text), status: () => convo.current.status };
    return () => {
      delete w.__tadaimaVoice;
    };
  }, []);

  // hang up when untouched for a while; the next press reconnects
  useEffect(() => {
    const t = setInterval(() => {
      const c = convo.current;
      if (c.status === "connected" && !c.isSpeaking && Date.now() - lastUse.current > IDLE_MS && !pressedAt.current) c.endSession();
    }, 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (disabled && convo.current.status === "connected") convo.current.endSession();
  }, [disabled]);
  useEffect(() => () => convo.current.endSession(), []);

  // tell the agent about a finished live search, once
  useEffect(() => {
    if (!update || sent.current === update.id || !live) return;
    sent.current = update.id;
    lastUse.current = Date.now();
    conversation.sendUserMessage(update.text.slice(0, 4000));
  }, [update, live, conversation]);

  const level = () => {
    const c = convo.current;
    return c.status === "connected" ? Math.max(c.getInputVolume(), c.getOutputVolume()) : 0;
  };
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
    return { gather: g.value, offset: Math.sin(now / 520) * 0.75 * g.value, stretch: Math.abs(Math.cos(now / 520)) * 0.3, heldLevel: 0.55 };
  };

  const label = pending || (open && !live) ? "Connecting" : open ? "Listening" : working ? "Working" : conversation.isSpeaking ? "Speaking" : "Talk";

  return (
    <div className="room-voice" data-tour="talk">
      {(caption || error) && (
        <p className="room-voice__caption" data-error={error ? true : undefined} role="status" aria-live="polite">
          {error || caption}
        </p>
      )}
      <VoiceBeam type="pill" theme="light" colorVariant="sunset" level={level} motion={motion} active={live || open} className="room-voice__beam">
        <button
          type="button"
          className="room-x__pill room-voice__btn"
          data-live={open || undefined}
          disabled={disabled}
          aria-pressed={open}
          aria-label={latched ? "Stop listening" : "Hold to talk to the room"}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            press();
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.repeat) {
              e.preventDefault();
              press();
            }
          }}
          onKeyUp={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              release();
            }
          }}
        >
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <rect x="7" y="2.5" width="6" height="10" rx="3" />
            <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
          </svg>
          <span>{label}</span>
          {label === "Talk" ? <span className="room-voice__key" aria-hidden="true">hold Space</span> : null}
        </button>
      </VoiceBeam>
    </div>
  );
}

export default RoomAgentVoice;
