"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ImageIcon, Mic, X } from "lucide-react";
import type { SpecialistState } from "@vox/core";
import { DEFAULT_VIN } from "@vox/core";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { NoiseBackground } from "@/components/ui/noise-background";
import { getLiveKitToken, getSpecialistState, sendSpecialistMessage } from "@/lib/api";

type Message = { role: "user" | "assistant"; text: string };
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
};
type AgentStatusEvent = {
  type: "agent_status";
  status?: string;
  transcript?: string;
  isFinal?: boolean;
  error?: string;
};

export default function SpecialistPage() {
  const [state, setState] = useState<SpecialistState | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [error, setError] = useState("");
  const [voiceStatus, setVoiceStatus] = useState("Voice");
  const [listening, setListening] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const remoteAudioRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<LiveKitRoomLike | null>(null);
  const agentJoinedRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    getSpecialistState(DEFAULT_VIN)
      .then((next) => {
        setState(next);
        setSelectedImageId(next.selectedImageId);
      })
      .catch((err) => setError(err.message));
    return () => roomRef.current?.disconnect();
  }, []);

  const selectedImage = useMemo(
    () => state?.images.find((image) => image.id === selectedImageId) ?? state?.images[0],
    [state, selectedImageId]
  );

  async function ask(text: string) {
    const clean = text.trim();
    if (!clean || busy) return;
    setDraft("");
    setBusy(true);
    setError("");
    setMessages((items) => [...items, { role: "user", text: clean }]);
    try {
      setImageBusy(true);
      const turn = await sendSpecialistMessage({ vin: DEFAULT_VIN, message: clean, currentImageId: selectedImageId, includeAudio: true });
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

  function humanizeStatus(raw: string): string {
    const key = raw.toLowerCase().trim();
    const map: Record<string, string> = {
      voice: "Voice",
      connecting: "Connecting…",
      "waiting for specialist…": "Waiting…",
      "specialist joined": "Connected",
      "starting mic": "Connecting…",
      "mic live": "Listening",
      live: "Listening",
      initializing: "Connecting…",
      listening: "Listening",
      hearing: "Listening",
      thinking: "Thinking…",
      speaking: "Speaking…",
      error: "Reconnecting…",
      "tap to resume audio": "Tap to resume"
    };
    return map[key] ?? capitalize(raw);
  }

  function applyAgentTurn(event: AgentTurnEvent) {
    if (event.selectedImageId) setSelectedImageId(event.selectedImageId);
    setLiveTranscript("");
    setMessages((items) => {
      const next = [...items];
      if (event.transcript) next.push({ role: "user", text: capitalize(event.transcript) });
      if (event.reply) next.push({ role: "assistant", text: event.reply });
      return next;
    });
  }

  function applyAgentStatus(event: AgentStatusEvent) {
    if (event.error) setError(event.error);
    if (event.transcript) setLiveTranscript(capitalize(event.transcript));
    if (event.status) setVoiceStatus(humanizeStatus(event.status));
  }

  function attachRemoteAudio(track: unknown) {
    const maybeAudioTrack = track as {
      kind?: string;
      attach?: () => HTMLMediaElement;
      detach?: () => HTMLMediaElement[];
    };
    if (maybeAudioTrack.kind !== "audio" || !maybeAudioTrack.attach) return;
    remoteAudioRef.current?.replaceChildren();
    const element = maybeAudioTrack.attach();
    element.autoplay = true;
    element.setAttribute("playsinline", "true");
    element.style.display = "none";
    remoteAudioRef.current?.appendChild(element);
    void element.play().catch(() => {
      setVoiceStatus("Tap to resume audio");
    });
  }

  function detachRemoteAudio(track: unknown) {
    const maybeAudioTrack = track as { detach?: () => HTMLMediaElement[] };
    for (const element of maybeAudioTrack.detach?.() ?? []) {
      element.remove();
    }
  }

  async function attachExistingRemoteAudio(room: LiveKitRoomLike) {
    for (const participant of room.remoteParticipants?.values() ?? []) {
      for (const publication of participant.trackPublications?.values() ?? []) {
        if (publication.track) attachRemoteAudio(publication.track);
      }
    }
    await room.startAudio?.().catch(() => {
      setVoiceStatus("Tap to resume audio");
    });
  }

  async function ensureLiveKitRoom() {
    if (roomRef.current) return;
    const roomName = `vox-specialist-${DEFAULT_VIN.toLowerCase()}-${Date.now()}`;
    const session = await getLiveKitToken({
      roomName,
      identity: `shopper-${Date.now()}`
    });
    const { Room, RoomEvent } = await import("livekit-client");
    const room = new Room();
    let resolveAgentJoined: (() => void) | undefined;
    agentJoinedRef.current = new Promise<void>((resolve) => {
      resolveAgentJoined = resolve;
    });
    room.on(RoomEvent.ConnectionStateChanged, (status: string) => {
      if (status !== "connected") setVoiceStatus(status);
    });
    room.on(RoomEvent.ParticipantConnected, () => {
      setVoiceStatus("Specialist joined");
      resolveAgentJoined?.();
    });
    room.on(RoomEvent.LocalTrackPublished, () => {
      setVoiceStatus("Mic live");
    });
    room.on(RoomEvent.TrackSubscribed, (track: unknown) => {
      attachRemoteAudio(track);
      setVoiceStatus("Live");
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: unknown) => {
      detachRemoteAudio(track);
    });
    room.on(RoomEvent.Disconnected, () => {
      remoteAudioRef.current?.replaceChildren();
      setLiveTranscript("");
      setListening(false);
      setVoiceStatus("Voice");
      roomRef.current = null;
    });
    room.on(RoomEvent.DataReceived, (payload: Uint8Array, _participant, _kind, topic) => {
      if (topic !== "vox.specialist.turn") return;
      try {
        const event = JSON.parse(new TextDecoder().decode(payload)) as AgentTurnEvent | AgentStatusEvent;
        if (event.type === "specialist_turn") applyAgentTurn(event);
        if (event.type === "agent_status") applyAgentStatus(event);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not parse agent event");
      }
    });
    await room.connect(session.url, session.token, { autoSubscribe: true });
    setVoiceStatus("Starting mic");
    roomRef.current = room;
    await attachExistingRemoteAudio(room);
  }

  async function startVoice() {
    if (listening) {
      await roomRef.current?.localParticipant.setMicrophoneEnabled(false);
      roomRef.current?.disconnect();
      roomRef.current = null;
      setListening(false);
      setVoiceStatus("Voice");
      return;
    }
    setError("");
    setVoiceStatus("Connecting");
    try {
      await ensureLiveKitRoom();
      setVoiceStatus("Waiting for specialist…");
      await Promise.race([
        agentJoinedRef.current ?? Promise.resolve(),
        new Promise<void>((resolve) => setTimeout(resolve, 6_000))
      ]);
      await roomRef.current?.localParticipant.setMicrophoneEnabled(true);
      await roomRef.current?.startAudio?.().catch(() => {
        setVoiceStatus("Tap to resume audio");
      });
      if (roomRef.current?.localParticipant.isMicrophoneEnabled === false) {
        throw new Error("Microphone did not publish. Check browser mic permission.");
      }
      setListening(true);
      setVoiceStatus("Live");
    } catch (err) {
      setListening(false);
      setVoiceStatus("Voice");
      setError(err instanceof Error ? err.message : "Voice failed");
    }
  }

  if (!state) {
    return (
      <main className="specialist-shell">
        <Card className="specialist-frame specialist-loading">Loading specialist workspace...</Card>
      </main>
    );
  }

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
                <h1>{state.car.year} {state.car.make} {state.car.model}</h1>
              </div>
              <div className="stage-meta">
                <span className="stage-meta-price">
                  {state.car.price != null ? `$${state.car.price.toLocaleString()}` : "Inquire for price"}
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
            <button
              type="button"
              className={`detail-btn ${detailOpen ? "on" : ""}`}
              onClick={() => setDetailOpen((open) => !open)}
              aria-pressed={detailOpen}
            >
              {detailOpen ? "Close" : "Detail"}
            </button>
          </div>

          <div className="image-canvas">
            {selectedImage ? (
              <img className="hero-image" src={selectedImage.url} alt={selectedImage.caption} />
            ) : (
              <div className="empty-image">
                <ImageIcon />
              </div>
            )}

            {imageBusy ? (
              <div className="canvas-badge">
                <span className="canvas-spinner" /> Finding the right view…
              </div>
            ) : selectedImage ? (
              <div className="canvas-caption">{selectedImage.role.replaceAll("_", " ")}</div>
            ) : null}

            {detailOpen ? (
              <div className="detail-panel" role="dialog" aria-label="Vehicle details">
                <div className="detail-head">
                  <div>
                    <span className="eyebrow">Overview</span>
                    <h2>{state.car.year} {state.car.make} {state.car.model}</h2>
                  </div>
                  <button type="button" className="detail-close" onClick={() => setDetailOpen(false)} aria-label="Close details">
                    <X size={18} />
                  </button>
                </div>

                <div className="detail-specs">
                  {[
                    { label: "Trim", value: state.car.trim },
                    { label: "Body", value: state.car.body },
                    { label: "Drivetrain", value: state.car.drivetrain },
                    { label: "Fuel", value: state.car.fuel },
                    { label: "Color", value: state.car.color },
                    { label: "Mileage", value: `${state.car.mileage.toLocaleString()} mi` },
                    { label: "Availability", value: state.car.availability },
                    { label: "Price", value: state.car.price != null ? `$${state.car.price.toLocaleString()}` : "Inquire" }
                  ].map((spec) => (
                    <div className="spec" key={spec.label}>
                      <span>{spec.label}</span>
                      <strong>{spec.value}</strong>
                    </div>
                  ))}
                </div>

                {state.car.features.length ? (
                  <div className="detail-block">
                    <h3>Features</h3>
                    <div className="chips">
                      {state.car.features.map((feature) => (
                        <span className="chip" key={feature}>{feature}</span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {state.car.description ? (
                  <div className="detail-block">
                    <h3>About this vehicle</h3>
                    <p className="detail-desc">{state.car.description}</p>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        <aside className="chat-panel">
          <div className="chat-log">
            {messages.length === 0 ? (
              <div className="empty-log">
                <h2>Ask anything about your BMW M4</h2>
                <p>Start a conversation by voice, or type below — I&rsquo;ll walk you through every detail.</p>
              </div>
            ) : null}
            {messages.map((message, i) => (
              <div key={i} className={`message ${message.role}`}>{message.text}</div>
            ))}
            {liveTranscript ? <div className="message user live">{liveTranscript}</div> : null}
            {error ? <div className="message assistant">Error: {error}</div> : null}
          </div>

          <div className="composer">
            <NoiseBackground
              containerClassName="voice-cta-noise w-full rounded-full p-2"
              gradientColors={[
                "rgb(190, 190, 195)",
                "rgb(150, 150, 155)",
                "rgb(220, 220, 225)"
              ]}
              noiseIntensity={0.55}
              speed={0.14}
              animating={!busy}
            >
              <button
                type="button"
                className={`voice-cta ${listening ? "on" : ""}`}
                onClick={startVoice}
                disabled={busy}
                aria-pressed={listening}
                title="Talk to the specialist"
              >
                <span className="voice-cta-mic"><Mic size={18} /></span>
                <span className="voice-cta-label">
                  {listening || voiceStatus !== "Voice" ? voiceStatus : "Start Conversation"}
                </span>
              </button>
            </NoiseBackground>

            <div className="text-row">
              <Textarea
                id="composer-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask(draft);
                  }
                }}
                rows={1}
                placeholder="or type a message"
              />
              <button
                type="button"
                className="pill-btn pill-send"
                onClick={() => ask(draft)}
                disabled={busy || !draft.trim()}
                aria-label="Send"
              >
                <ArrowUp size={18} />
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
