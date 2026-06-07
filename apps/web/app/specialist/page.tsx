"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ImageIcon,
  MessageSquare,
  Mic,
  PhoneOff,
  User,
} from "lucide-react";
import type { ModelProfile, ModelProfileId, SpecialistState } from "@vox/core";
import {
  DEFAULT_MODEL_PROFILE_ID,
  DEFAULT_VIN,
  MODEL_PROFILES,
  resolveModelProfile,
} from "@vox/core";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { NoiseBackground } from "@/components/ui/noise-background";
import { AgentVisualizer, type AgentVizMode } from "@/components/ui/agent-visualizer";
import { getLiveKitToken, getSpecialistState, sendSpecialistMessage } from "@/lib/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Message = { role: "user" | "assistant"; text: string; streaming?: boolean };

type LiveKitRoomLike = {
  disconnect(): void;
  startAudio?: () => Promise<void>;
  remoteParticipants?: Map<string, {
    trackPublications?: Map<string, { track?: unknown }>;
  }>;
  localParticipant: {
    setMicrophoneEnabled(enabled: boolean): Promise<unknown>;
    isMicrophoneEnabled?: boolean;
  };
};

type AgentTurnEvent = {
  type: "specialist_turn";
  transcript?: string;
  reply?: string;
  selectedImageId?: string;
  action?: unknown;
  sources?: unknown;
};

type AgentStatusEvent = {
  type: "agent_status";
  status?: string;
  transcript?: string;
  isFinal?: boolean;
  error?: string;
};

type ReplyDeltaEvent = {
  type: "reply_delta";
  text: string;
};

type ReplyDoneEvent = {
  type: "reply_done";
  reply: string;
};

type DataEvent = AgentTurnEvent | AgentStatusEvent | ReplyDeltaEvent | ReplyDoneEvent;

// ---------------------------------------------------------------------------
// Voice state machine
// ---------------------------------------------------------------------------

type VoiceState = "idle" | "connecting" | "connected" | "error";

// ---------------------------------------------------------------------------
// Utility: localStorage-backed model profile
// ---------------------------------------------------------------------------

const PROFILE_STORAGE_KEY = "vox.model.profile";

function loadStoredProfile(): ModelProfile {
  if (typeof window === "undefined") return resolveModelProfile(DEFAULT_MODEL_PROFILE_ID);
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    return resolveModelProfile(raw);
  } catch {
    return resolveModelProfile(DEFAULT_MODEL_PROFILE_ID);
  }
}

function persistProfile(id: ModelProfileId) {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, id);
  } catch {
    // ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// ModelSelector component
// ---------------------------------------------------------------------------

function ModelSelector({
  activeProfile,
  onSelect,
}: {
  activeProfile: ModelProfile;
  onSelect: (profile: ModelProfile) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onPointer(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  return (
    <div className="model-selector" ref={containerRef}>
      <button
        type="button"
        className="model-selector-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${activeProfile.label}`}
      >
        <span className="model-selector-label">{activeProfile.label}</span>
        <ChevronDown
          size={13}
          strokeWidth={2.2}
          className={`model-selector-chevron${open ? " open" : ""}`}
        />
      </button>

      {open ? (
        <div className="model-selector-dropdown" role="listbox" aria-label="Select model">
          {MODEL_PROFILES.map((profile) => {
            const isActive = profile.id === activeProfile.id;
            return (
              <button
                key={profile.id}
                type="button"
                role="option"
                aria-selected={isActive}
                className={`model-selector-option${isActive ? " active" : ""}`}
                onClick={() => {
                  onSelect(profile);
                  setOpen(false);
                }}
              >
                <span className="model-option-check">
                  {isActive ? <Check size={13} strokeWidth={2.5} /> : null}
                </span>
                <span className="model-option-text">
                  <span className="model-option-label">{profile.label}</span>
                  <span className="model-option-desc">{profile.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SpecialistPage() {
  const [state, setState] = useState<SpecialistState | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [error, setError] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [activeProfile, setActiveProfile] = useState<ModelProfile>(() => loadStoredProfile());
  // hover-to-disconnect state
  const [buttonHovered, setButtonHovered] = useState(false);
  // visualizer-only signals — never feed the voiceState machine / button label
  const [agentTrack, setAgentTrack] = useState<MediaStreamTrack | null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentVizMode>("listening");

  const audioRef = useRef<HTMLAudioElement>(null);
  const remoteAudioRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<LiveKitRoomLike | null>(null);
  const agentJoinedRef = useRef<Promise<void> | null>(null);
  const agentJoinedResolveRef = useRef<(() => void) | undefined>(undefined);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  // Scroll chat log to bottom when messages update
  useEffect(() => {
    const log = chatLogRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
  }, [messages, liveTranscript, busy, error]);

  // Chat popover keyboard/click-outside handling
  useEffect(() => {
    if (!chatOpen) return;
    chatInputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setChatOpen(false);
    }
    function onPointer(e: MouseEvent) {
      if (!composerRef.current?.contains(e.target as Node)) setChatOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [chatOpen]);

  // Initial load + cleanup
  useEffect(() => {
    getSpecialistState(DEFAULT_VIN)
      .then((next) => {
        setState(next);
        setSelectedImageId(next.selectedImageId);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Load failed"));
    return () => roomRef.current?.disconnect();
  }, []);

  const selectedImage = useMemo(
    () => state?.images.find((image) => image.id === selectedImageId) ?? state?.images[0],
    [state, selectedImageId]
  );

  // -------------------------------------------------------------------------
  // Text chat
  // -------------------------------------------------------------------------

  async function ask(text: string) {
    const clean = text.trim();
    if (!clean || busy) return;
    setDraft("");
    setBusy(true);
    setError("");
    setMessages((items) => [...items, { role: "user", text: clean }]);
    try {
      setImageBusy(true);
      const history = messages.slice(-12).map((m) => ({ role: m.role, text: m.text }));
      const turn = await sendSpecialistMessage({
        vin: DEFAULT_VIN,
        message: clean,
        currentImageId: selectedImageId,
        includeAudio: true,
        history,
      });
      if (turn.selectedImageId) setSelectedImageId(turn.selectedImageId);
      setMessages((items) => [...items, { role: "assistant", text: turn.reply }]);
      setImageBusy(false);
      if (turn.audioBase64 && audioRef.current) {
        audioRef.current.src = `data:audio/mp3;base64,${turn.audioBase64}`;
        await audioRef.current.play().catch(() => {});
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Message failed");
    } finally {
      setBusy(false);
    }
  }

  function capitalize(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return trimmed;
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  // -------------------------------------------------------------------------
  // Remote audio
  // -------------------------------------------------------------------------

  function attachRemoteAudio(track: unknown) {
    const maybeAudioTrack = track as {
      kind?: string;
      attach?: () => HTMLMediaElement;
      detach?: () => HTMLMediaElement[];
      mediaStreamTrack?: MediaStreamTrack;
    };
    if (maybeAudioTrack.kind !== "audio" || !maybeAudioTrack.attach) return;
    remoteAudioRef.current?.replaceChildren();
    const element = maybeAudioTrack.attach();
    element.autoplay = true;
    element.setAttribute("playsinline", "true");
    element.style.display = "none";
    remoteAudioRef.current?.appendChild(element);
    // Feed the on-button visualizer from the agent's live audio.
    if (maybeAudioTrack.mediaStreamTrack) setAgentTrack(maybeAudioTrack.mediaStreamTrack);
    void element.play().catch(() => {
      // Audio autoplay blocked; user must tap — handled gracefully
    });
  }

  function detachRemoteAudio(track: unknown) {
    const maybeAudioTrack = track as { detach?: () => HTMLMediaElement[] };
    for (const element of maybeAudioTrack.detach?.() ?? []) {
      element.remove();
    }
    setAgentTrack(null);
  }

  async function attachExistingRemoteAudio(room: LiveKitRoomLike) {
    for (const participant of room.remoteParticipants?.values() ?? []) {
      for (const publication of participant.trackPublications?.values() ?? []) {
        if (publication.track) attachRemoteAudio(publication.track);
      }
    }
    await room.startAudio?.().catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Data-channel event handlers
  // -------------------------------------------------------------------------

  function applyAgentTurn(event: AgentTurnEvent) {
    if (event.selectedImageId) setSelectedImageId(event.selectedImageId);
    setLiveTranscript("");
    setMessages((items) => {
      const next = [...items];
      if (event.transcript) next.push({ role: "user", text: capitalize(event.transcript) });
      // legacy `reply` field — ignored when using reply_delta/reply_done flow
      if (event.reply) next.push({ role: "assistant", text: event.reply });
      return next;
    });
  }

  function applyAgentStatus(event: AgentStatusEvent) {
    if (event.error) setError(event.error);
    // Route live transcript to chat log only — never to the button
    if (event.transcript) setLiveTranscript(capitalize(event.transcript));
    // agent_status status values (listening/thinking/speaking) do NOT update voiceState;
    // they only drive the on-button visualizer.
    if (event.status) {
      const key = event.status.toLowerCase().trim();
      if (key === "speaking") setAgentActivity("speaking");
      else if (key === "thinking") setAgentActivity("thinking");
      else if (key === "listening" || key === "hearing") setAgentActivity("listening");
    }
  }

  function applyReplyDelta(event: ReplyDeltaEvent) {
    setMessages((items) => {
      const last = items[items.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        // Append delta to the in-progress bubble
        return [
          ...items.slice(0, -1),
          { ...last, text: last.text + event.text },
        ];
      }
      // Create a new streaming bubble
      return [...items, { role: "assistant", text: event.text, streaming: true }];
    });
  }

  function applyReplyDone(event: ReplyDoneEvent) {
    setMessages((items) => {
      const last = items[items.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        // Finalize: reconcile with authoritative full text, clear streaming flag
        return [...items.slice(0, -1), { role: "assistant", text: event.reply }];
      }
      // Bubble wasn't started via deltas — just push it
      return [...items, { role: "assistant", text: event.reply }];
    });
    setLiveTranscript("");
  }

  // -------------------------------------------------------------------------
  // LiveKit room management
  // -------------------------------------------------------------------------

  async function ensureLiveKitRoom(profileId: ModelProfileId) {
    if (roomRef.current) return;
    const roomName = `vox-specialist-${DEFAULT_VIN.toLowerCase()}-${Date.now()}`;
    const session = await getLiveKitToken({
      roomName,
      identity: `shopper-${Date.now()}`,
      profileId,
    });
    const { Room, RoomEvent } = await import("livekit-client");
    const room = new Room();

    agentJoinedRef.current = new Promise<void>((resolve) => {
      agentJoinedResolveRef.current = resolve;
    });

    // --- IMPORTANT: Do NOT expose raw transport state to the button. ---
    // All intermediate states (connecting, connected, etc.) are collapsed
    // into the single "connecting" held state until truly ready.

    room.on(RoomEvent.ParticipantConnected, () => {
      agentJoinedResolveRef.current?.();
    });

    room.on(RoomEvent.TrackSubscribed, (track: unknown) => {
      attachRemoteAudio(track);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: unknown) => {
      detachRemoteAudio(track);
    });

    room.on(RoomEvent.Disconnected, () => {
      remoteAudioRef.current?.replaceChildren();
      setLiveTranscript("");
      setVoiceState("idle");
      setAgentTrack(null);
      setAgentActivity("listening");
      roomRef.current = null;
    });

    room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, _participant: unknown, _kind: unknown, topic: string | undefined) => {
        if (topic !== "vox.specialist.turn") return;
        try {
          const event = JSON.parse(new TextDecoder().decode(payload)) as DataEvent;
          if (event.type === "specialist_turn") applyAgentTurn(event);
          else if (event.type === "agent_status") applyAgentStatus(event);
          else if (event.type === "reply_delta") applyReplyDelta(event);
          else if (event.type === "reply_done") applyReplyDone(event);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not parse agent event");
        }
      }
    );

    await room.connect(session.url, session.token, { autoSubscribe: true });
    roomRef.current = room;
    await attachExistingRemoteAudio(room);
  }

  // -------------------------------------------------------------------------
  // Voice connect / disconnect
  // -------------------------------------------------------------------------

  async function disconnect() {
    await roomRef.current?.localParticipant.setMicrophoneEnabled(false).catch(() => {});
    roomRef.current?.disconnect();
    roomRef.current = null;
    setVoiceState("idle");
  }

  const startVoice = useCallback(async () => {
    // Disconnect branch
    if (voiceState === "connected") {
      await disconnect();
      return;
    }

    setError("");
    setVoiceState("connecting");

    try {
      await ensureLiveKitRoom(activeProfile.id);

      // Wait for agent participant to join (timeout 6 s)
      await Promise.race([
        agentJoinedRef.current ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
      ]);

      // Enable local mic
      await roomRef.current?.localParticipant.setMicrophoneEnabled(true);

      // Attempt to start audio context (autoplay unlocking)
      await roomRef.current?.startAudio?.().catch(() => {});

      if (roomRef.current?.localParticipant.isMicrophoneEnabled === false) {
        throw new Error("Microphone did not publish. Check browser mic permission.");
      }

      setVoiceState("connected");
    } catch (err) {
      // Clean up on failure
      roomRef.current?.disconnect();
      roomRef.current = null;
      setVoiceState("error");
      setError(err instanceof Error ? err.message : "Voice failed");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceState, activeProfile.id]);

  // -------------------------------------------------------------------------
  // Profile selection + reconnect-on-change
  // -------------------------------------------------------------------------

  const handleProfileSelect = useCallback(async (profile: ModelProfile) => {
    persistProfile(profile.id);
    setActiveProfile(profile);

    if (voiceState === "connected") {
      // Reconnect with new profile so the backend uses the new LLM + TTS
      setVoiceState("connecting");
      try {
        // Disconnect current room
        await roomRef.current?.localParticipant.setMicrophoneEnabled(false).catch(() => {});
        roomRef.current?.disconnect();
        roomRef.current = null;

        // Re-establish with new profile
        await ensureLiveKitRoom(profile.id);

        await Promise.race([
          agentJoinedRef.current ?? Promise.resolve(),
          new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
        ]);

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
        const switchedRoom = roomRef.current as LiveKitRoomLike | null;
        if (switchedRoom !== null) {
          await switchedRoom.localParticipant.setMicrophoneEnabled(true);
          await switchedRoom.startAudio?.().catch(() => {});

          if (switchedRoom.localParticipant.isMicrophoneEnabled === false) {
            throw new Error("Microphone did not publish after model switch.");
          }
        }

        setVoiceState("connected");
      } catch (err) {
        roomRef.current?.disconnect();
        roomRef.current = null;
        setVoiceState("error");
        setError(err instanceof Error ? err.message : "Reconnect failed");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceState]);

  // -------------------------------------------------------------------------
  // Button rendering helpers
  // -------------------------------------------------------------------------

  function renderVoiceButtonContent() {
    switch (voiceState) {
      case "idle":
        return (
          <>
            <span className="voice-cta-mic"><Mic size={18} /></span>
            <span className="voice-cta-label">Start Conversation</span>
          </>
        );
      case "connecting":
        return (
          <>
            <span className="voice-cta-mic">
              <span className="connecting-dots" aria-hidden="true">
                <span /><span /><span />
              </span>
            </span>
            <span className="voice-cta-label">Connecting</span>
          </>
        );
      case "connected":
        if (buttonHovered) {
          return (
            <>
              <span className="voice-cta-mic"><PhoneOff size={18} /></span>
              <span className="voice-cta-label">Disconnect</span>
            </>
          );
        }
        return (
          <>
            <AgentVisualizer track={agentTrack} mode={agentActivity} />
            <span className="voice-cta-label">Connected</span>
          </>
        );
      case "error":
        return (
          <>
            <span className="voice-cta-mic"><Mic size={18} /></span>
            <span className="voice-cta-label">Reconnecting…</span>
          </>
        );
    }
  }

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  if (!state) {
    return (
      <main className="specialist-shell">
        <Card className="specialist-frame specialist-loading">Loading specialist workspace...</Card>
      </main>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <main className="specialist-shell">
      <Card className="specialist-frame">
        <section className="image-stage">
          <div className="stage-topline">
            <div className="stage-title">
              <div className="stage-heading">
                <img
                  className="brand-logo"
                  src={`/logos/${state.car.make.toLowerCase()}_logo.png`}
                  alt={`${state.car.make} logo`}
                />
                <div className="stage-heading-text">
                  <ModelSelector
                    activeProfile={activeProfile}
                    onSelect={handleProfileSelect}
                  />
                  <h1>{state.car.year} {state.car.make} {state.car.model}</h1>
                </div>
              </div>
              <div className="stage-meta">
                <span className="stage-meta-price">
                  {state.car.price != null
                    ? `$${state.car.price.toLocaleString()}`
                    : "Inquire for price"}
                </span>
                <span className="stage-meta-dot" aria-hidden="true" />
                <span>{state.car.mileage.toLocaleString()} mi</span>
                <span className="stage-meta-dot" aria-hidden="true" />
                <span>{state.car.drivetrain}</span>
                <span className="stage-meta-dot" aria-hidden="true" />
                <span>{state.car.fuel}</span>
                {state.car.availability === "available" ? (
                  <span className="status-pill">Available</span>
                ) : null}
              </div>
            </div>
            <div className="specialist-avatar" aria-hidden="true">
              <User size={56} strokeWidth={1.4} />
            </div>
          </div>

          <div className="image-canvas">
            {selectedImage ? (
              <figure className="canvas-figure">
                <img
                  className="hero-image"
                  src={selectedImage.url}
                  alt={selectedImage.caption}
                />
                {!imageBusy ? (
                  <figcaption className="canvas-caption">
                    {selectedImage.role.replaceAll("_", " ")}
                  </figcaption>
                ) : null}
              </figure>
            ) : (
              <div className="empty-image">
                <ImageIcon />
              </div>
            )}

            {imageBusy ? (
              <div className="canvas-badge">
                <span className="canvas-spinner" /> Finding the right view…
              </div>
            ) : null}
          </div>
        </section>

        <aside className="chat-panel">
          <div className="chat-log" ref={chatLogRef}>
            {messages.length === 0 ? (
              <div className="empty-log">
                <h2>Ask anything about your BMW M4</h2>
              </div>
            ) : null}
            {messages.map((message, i) => (
              <div key={i} className={`message ${message.role}`}>
                {message.text}
              </div>
            ))}
            {busy ? (
              <div className="message typing" role="status" aria-label="Specialist is typing">
                <span />
                <span />
                <span />
              </div>
            ) : null}
            {liveTranscript ? (
              <div className="message user live">{liveTranscript}</div>
            ) : null}
            {error ? <div className="message assistant">Error: {error}</div> : null}
          </div>

          <div className="composer" ref={composerRef}>
            <div className="composer-actions">
              {chatOpen ? (
                <div className="chat-popover" role="dialog" aria-label="Type a message">
                  <div className="text-row">
                    <Textarea
                      ref={chatInputRef}
                      id="composer-input"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void ask(draft);
                        }
                      }}
                      rows={1}
                      placeholder="Type a message"
                    />
                    <button
                      type="button"
                      className="pill-btn pill-send"
                      onClick={() => void ask(draft)}
                      disabled={busy || !draft.trim()}
                      aria-label="Send"
                    >
                      <ArrowUp size={18} />
                    </button>
                  </div>
                </div>
              ) : null}

              <NoiseBackground
                containerClassName="voice-cta-noise rounded-full p-1.5"
                gradientColors={[
                  "rgb(190, 190, 195)",
                  "rgb(150, 150, 155)",
                  "rgb(220, 220, 225)",
                ]}
                noiseIntensity={0.55}
                speed={0.14}
                animating={voiceState !== "connected"}
              >
                <button
                  type="button"
                  className={`voice-cta${voiceState === "connected" ? " on" : ""}${voiceState === "connected" && buttonHovered ? " hover-disconnect" : ""}`}
                  onClick={() => void startVoice()}
                  disabled={busy || voiceState === "connecting"}
                  aria-pressed={voiceState === "connected"}
                  title={
                    voiceState === "connected"
                      ? "Disconnect"
                      : "Talk to the specialist"
                  }
                  onMouseEnter={() => setButtonHovered(true)}
                  onMouseLeave={() => setButtonHovered(false)}
                >
                  {renderVoiceButtonContent()}
                </button>
              </NoiseBackground>

              <button
                type="button"
                className={`chat-toggle ${chatOpen ? "on" : ""}`}
                onClick={() => setChatOpen((open) => !open)}
                aria-pressed={chatOpen}
                aria-label="Type a message"
              >
                <MessageSquare size={18} strokeWidth={2} />
                <span className="chat-toggle-label">Chat</span>
              </button>
            </div>
          </div>
          <audio ref={audioRef} />
          <div ref={remoteAudioRef} aria-hidden="true" />
        </aside>
      </Card>
    </main>
  );
}
