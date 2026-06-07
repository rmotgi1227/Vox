"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImageIcon, Mic, Send } from "lucide-react";
import type { SpecialistState } from "@vox/core";
import { DEFAULT_VIN } from "@vox/core";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { getLiveKitToken, getSpecialistState, selectSpecialistImage, sendSpecialistMessage } from "@/lib/api";

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
  const audioRef = useRef<HTMLAudioElement>(null);
  const remoteAudioRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<LiveKitRoomLike | null>(null);

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
      const turn = await sendSpecialistMessage({ vin: DEFAULT_VIN, message: clean, currentImageId: selectedImageId, deferImage: true });
      setMessages((items) => [...items, { role: "assistant", text: turn.reply }]);
      if (turn.audioBase64 && audioRef.current) {
        audioRef.current.src = `data:audio/mp3;base64,${turn.audioBase64}`;
        await audioRef.current.play().catch(() => {});
      }
      if (turn.needsImage) {
        setImageBusy(true);
        void selectSpecialistImage({
          vin: DEFAULT_VIN,
          message: clean,
          currentImageId: selectedImageId,
          desiredVisualTarget: turn.desiredVisualTarget
        }).then((imageTurn) => {
          if (imageTurn.selectedImageId) setSelectedImageId(imageTurn.selectedImageId);
        }).catch((err) => {
          setError(err instanceof Error ? err.message : "Image selection failed");
        }).finally(() => setImageBusy(false));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Message failed");
    } finally {
      setBusy(false);
    }
  }

  function applyAgentTurn(event: AgentTurnEvent) {
    if (event.selectedImageId) setSelectedImageId(event.selectedImageId);
    setLiveTranscript("");
    setMessages((items) => [
      ...items,
      ...(event.transcript ? [{ role: "user" as const, text: event.transcript }] : []),
      ...(event.reply ? [{ role: "assistant" as const, text: event.reply }] : [])
    ]);
  }

  function applyAgentStatus(event: AgentStatusEvent) {
    if (event.error) setError(event.error);
    if (event.transcript) setLiveTranscript(event.transcript);
    if (event.status) setVoiceStatus(event.status);
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
    room.on(RoomEvent.ConnectionStateChanged, (status: string) => {
      setVoiceStatus(status === "connected" ? "Connected" : status);
    });
    room.on(RoomEvent.ParticipantConnected, () => {
      setVoiceStatus("Agent joined");
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
      await roomRef.current?.localParticipant.setMicrophoneEnabled(true);
      await roomRef.current?.startAudio?.().catch(() => {
        setVoiceStatus("Tap to resume audio");
      });
      if (roomRef.current?.localParticipant.isMicrophoneEnabled === false) {
        throw new Error("Microphone did not publish. Check browser mic permission.");
      }
      setListening(true);
      setVoiceStatus("Mic live");
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
            <h1>{state.car.year} {state.car.make} {state.car.model}</h1>
            <span>{imageBusy ? "finding view" : (selectedImage?.role.replaceAll("_", " ") ?? "Image")}</span>
          </div>

          <div className="image-canvas">
            {selectedImage ? (
              <img className="hero-image" src={selectedImage.url} alt={selectedImage.caption} />
            ) : (
              <div className="empty-image">
                <ImageIcon />
              </div>
            )}
          </div>

          <div className="thumbs">
            {state.images.map((image) => (
              <button key={image.id} className={`thumb ${image.id === selectedImage?.id ? "on" : ""}`} onClick={() => setSelectedImageId(image.id)} aria-label={`View ${image.caption}`}>
                <img src={image.url} alt={image.caption} />
              </button>
            ))}
          </div>
        </section>

        <aside className="chat-panel">
          <div className="chat-log">
            {messages.length === 0 ? (
              <p className="empty-log">Chat history / log</p>
            ) : null}
            {messages.map((message, i) => (
              <div key={i} className={`message ${message.role}`}>{message.text}</div>
            ))}
            {liveTranscript ? <div className="message user live">{liveTranscript}</div> : null}
            {error ? <div className="message assistant">Error: {error}</div> : null}
          </div>

          <Button className="voice-button" variant="secondary" onClick={startVoice} disabled={busy} title="Join LiveKit, listen, send transcript, and play voice back">
            <Mic size={16} /> {listening ? voiceStatus : "Voice"}
          </Button>

          <div className="composer">
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask about this M4..." />
            <Button onClick={() => ask(draft)} disabled={busy}><Send size={16} /> Send</Button>
          </div>
          <audio ref={audioRef} />
          <div ref={remoteAudioRef} aria-hidden="true" />
        </aside>
      </Card>
    </main>
  );
}
