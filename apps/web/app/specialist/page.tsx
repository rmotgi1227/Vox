"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  ArrowUp,
  CalendarCheck,
  MessageSquare,
  Mic,
  PhoneOff,
  User,
} from "lucide-react";
import type { ModelProfile, ModelProfileId, SpecialistState, ViewState } from "@vox/core";
import {
  DEFAULT_MODEL_PROFILE_ID,
  DEFAULT_VIN,
  ViewUpdateEventSchema,
  resolveModelProfile,
} from "@vox/core";
import { Canvas } from "./Canvas";
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
  /** legacy `reply` field — present on wire but superseded by reply_delta/reply_done */
  reply?: string;
  /** selectedImageId may arrive on wire but is intentionally unused here — canvas comes from view_update only */
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

type ViewUpdateEvent = {
  type: "view_update";
  view: ViewState;
};

type BookingConfirmedEvent = {
  type: "booking_confirmed";
  slot: string;
  carLabel?: string;
  phone?: string;
  smsStatus?: string;
};

type BookingPendingEvent = {
  type: "booking_pending";
};

type BookingConfirmation = {
  slot: string;
  carLabel?: string;
  smsStatus?: string;
};

type DataEvent = AgentTurnEvent | AgentStatusEvent | ReplyDeltaEvent | ReplyDoneEvent | ViewUpdateEvent | BookingConfirmedEvent | BookingPendingEvent;

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

// TEMP A/B brain toggle, persisted in localStorage. Read fresh at connect time
// so the dropdown choice always applies on the next connect.
const BRAIN_STORAGE_KEY = "vox.brain.mode";
type BrainMode = "single" | "double";
function loadBrainMode(): BrainMode {
  if (typeof window === "undefined") return "single";
  try {
    return localStorage.getItem(BRAIN_STORAGE_KEY) === "double" ? "double" : "single";
  } catch {
    return "single";
  }
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function SpecialistPage() {
  const [state, setState] = useState<SpecialistState | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | undefined>();
  const [viewState, setViewState] = useState<ViewState>({
    layout: "single",
    items: [],
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [error, setError] = useState("");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [bookingConfirmation, setBookingConfirmation] = useState<BookingConfirmation | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [activeProfile] = useState<ModelProfile>(() => loadStoredProfile());
  // TEMP A/B: single vs double brain (applies on next connect).
  const [brainMode, setBrainMode] = useState<BrainMode>(() => loadBrainMode());
  // hover-to-disconnect state
  const [buttonHovered, setButtonHovered] = useState(false);
  // visualizer-only signals — never feed the voiceState machine / button label
  const [agentTrack, setAgentTrack] = useState<MediaStreamTrack | null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentVizMode>("listening");
  // Phase-1 dev harness: ?canvas=demo cycles through hardcoded ViewStates.
  const [demoIndex, setDemoIndex] = useState(0);
  // Lazily read from URL to avoid SSR/client hydration mismatch.
  const [isCanvasDemo] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("canvas") === "demo"
  );

  const audioRef = useRef<HTMLAudioElement>(null);
  const remoteAudioRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<LiveKitRoomLike | null>(null);
  // True once the shopper has connected at least once this page session, so a
  // disconnect → reconnect gets a short "how can I help?" not the full opener.
  const hasConnectedRef = useRef(false);
  const agentJoinedRef = useRef<Promise<void> | null>(null);
  const agentJoinedResolveRef = useRef<(() => void) | undefined>(undefined);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const shownBookingKeysRef = useRef<Set<string>>(new Set());

  // Scroll chat log to bottom when messages update
  useEffect(() => {
    const log = chatLogRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
  }, [messages, liveTranscript, busy, error, bookingConfirmation]);

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

        // Seed initial ViewState from the first image (or the selectedImageId).
        const seedId = next.selectedImageId ?? next.images[0]?.id;
        if (seedId) {
          setViewState({
            layout: "single",
            items: [{ kind: "image", carId: DEFAULT_VIN, imageId: seedId }],
          });
        }

        // Preload all images so grid/compare/zoom don't flash.
        for (const img of next.images) {
          const el = new window.Image();
          el.src = img.url;
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Load failed"));
    return () => roomRef.current?.disconnect();
  }, []);

  const selectedImage = useMemo(
    () => state?.images.find((image) => image.id === selectedImageId) ?? state?.images[0],
    [state, selectedImageId]
  );

  // True while a Nano Banana visualization is rendering (canvas shows the 3-dot
  // loader). We pause the mic during this so the shopper waits for the image
  // instead of talking over the ~15-20s generation.
  const isGenerating = useMemo(
    () => viewState.items.some((it) => it.kind === "generated" && it.status === "pending"),
    [viewState]
  );

  // Pause / resume the mic around generation.
  useEffect(() => {
    if (voiceState !== "connected") return;
    void roomRef.current?.localParticipant.setMicrophoneEnabled(!isGenerating).catch(() => {});
  }, [isGenerating, voiceState]);

  // -------------------------------------------------------------------------
  // Phase-1 dev harness — ?canvas=demo
  // Cycles through hardcoded ViewStates so every layout can be seen without
  // running the agent. Entirely inert in production (no ?canvas=demo param).
  // -------------------------------------------------------------------------

  const demoViewStates = useMemo<ViewState[]>(() => {
    if (!state || state.images.length === 0) return [];
    // ids[0] is guaranteed by the length guard above.
    const ids = state.images.map((img) => img.id) as [string, ...string[]];
    const id0 = ids[0];
    const id1 = ids[1] ?? id0;
    const id2 = ids[2] ?? id0;
    const id3 = ids[3] ?? id0;
    return [
      // 0 — single
      {
        layout: "single",
        items: [{ kind: "image", carId: DEFAULT_VIN, imageId: id0 }],
        caption: "Single — exterior front",
      },
      // 1 — grid of 4
      {
        layout: "grid",
        items: ([id0, id1, id2, id3] as string[]).map((id) => ({
          kind: "image" as const,
          carId: DEFAULT_VIN,
          imageId: id,
        })),
        caption: "Grid — 4 images",
      },
      // 2 — compare
      {
        layout: "compare",
        items: [
          { kind: "image", carId: DEFAULT_VIN, imageId: id0 },
          { kind: "image", carId: DEFAULT_VIN, imageId: id1 },
        ],
        caption: "Compare — front vs rear",
      },
      // 3 — zoom
      {
        layout: "single",
        items: [{ kind: "image", carId: DEFAULT_VIN, imageId: id0 }],
        zoom: { itemIndex: 0, region: [0.3, 0.2, 0.4, 0.6] as [number, number, number, number] },
        caption: "Zoom — center region",
      },
      // 4 — annotated
      {
        layout: "single",
        items: [{ kind: "image", carId: DEFAULT_VIN, imageId: id0 }],
        marks: [
          { itemIndex: 0, box: [0.1, 0.1, 0.25, 0.2] as [number, number, number, number], label: "M Badge" },
          { itemIndex: 0, box: [0.6, 0.6, 0.3, 0.3] as [number, number, number, number], label: "Caliper" },
        ],
        caption: "Annotated — marks demo",
      },
    ];
  }, [state]);

  // When demo mode is active, override viewState with the current demo step.
  useEffect(() => {
    if (!isCanvasDemo || demoViewStates.length === 0) return;
    const vs = demoViewStates[demoIndex % demoViewStates.length];
    if (vs) setViewState(vs);
  }, [isCanvasDemo, demoIndex, demoViewStates]);

  // -------------------------------------------------------------------------
  // DEV CONSOLE HOOK — drive the canvas directly from the browser console,
  // FULLY decoupled from the voice agent / LiveKit. Proves the render path works
  // (setViewState → <Canvas>) independent of who produces the actions. Usage:
  //   __voxShowRole("exterior_rear")    → grid of rear images ("show me the back")
  //   __voxShowRole("wheel") / "interior_front" / "dashboard" / "detail"
  //   __voxShowRole("exterior_front", 1) → single image
  //   __voxView({ layout:"single", items:[{kind:"image",carId:"BMW-M4",imageId:"<id>"}] })
  // -------------------------------------------------------------------------
  useEffect(() => {
    const w = window as unknown as {
      __voxShowRole?: (role: string, limit?: number) => void;
      __voxZoom?: (role?: string, region?: [number, number, number, number]) => void;
      __voxView?: (v: ViewState) => void;
    };
    w.__voxShowRole = (role, limit = 4) => {
      const imgs = (state?.images ?? []).filter((i) => i.role === role).slice(0, limit);
      if (imgs.length === 0) {
        console.warn(
          `[vox] no images with role "${role}". Available roles:`,
          [...new Set((state?.images ?? []).map((i) => i.role))]
        );
        return;
      }
      setViewState({
        layout: imgs.length > 1 ? "grid" : "single",
        items: imgs.map((i) => ({ kind: "image", carId: DEFAULT_VIN, imageId: i.id })),
        caption: `${role} (${imgs.length})`,
      });
      console.log(`[vox] __voxShowRole("${role}") → ${imgs.length} image(s) on canvas`);
    };
    // Zoom: single image of `role` with a normalized [x,y,w,h] region (0..1).
    w.__voxZoom = (role = "exterior_front", region = [0.3, 0.2, 0.4, 0.4]) => {
      const img = (state?.images ?? []).find((i) => i.role === role) ?? state?.images?.[0];
      if (!img) {
        console.warn(`[vox] no images to zoom`);
        return;
      }
      setViewState({
        layout: "single",
        items: [{ kind: "image", carId: DEFAULT_VIN, imageId: img.id }],
        zoom: { itemIndex: 0, region },
        caption: `zoom ${role}`,
      });
      console.log(`[vox] __voxZoom("${role}", [${region}])`);
    };
    w.__voxView = (v) => setViewState(v);
    return () => {
      delete w.__voxShowRole;
      delete w.__voxZoom;
      delete w.__voxView;
    };
  }, [state]);

  // -------------------------------------------------------------------------
  // Text chat
  // -------------------------------------------------------------------------

  async function ask(text: string) {
    const clean = text.trim();
    if (!clean || busy) return;
    setDraft("");
    setBusy(true);
    setError("");
    setBookingConfirmation(null);
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
      if (turn.selectedImageId) {
        setSelectedImageId(turn.selectedImageId);
        // Legacy bridge: map selectedImageId → single-image ViewState so the
        // typed-chat path still drives the canvas without the agent protocol.
        setViewState({
          layout: "single",
          items: [{ kind: "image", carId: DEFAULT_VIN, imageId: turn.selectedImageId }],
        });
      }
      setMessages((items) => [...items, { role: "assistant", text: turn.reply }]);
      if (turn.bookingSlot) {
        showBookingConfirmation({
          slot: turn.bookingSlot,
          carLabel: state?.car ? `${state.car.year} ${state.car.make} ${state.car.model}` : undefined,
          smsStatus: turn.smsStatus,
        });
      }
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
    // Voice canvas authority is EXCLUSIVELY the view_update event.
    // specialist_turn must NEVER force a ViewState — doing so would clobber
    // multi-image grid/compare layouts that arrived via view_update just prior.
    // Any selectedImageId on this event is intentionally ignored here.
    setLiveTranscript("");
    setMessages((items) => {
      const next = [...items];
      if (event.transcript) {
        setBookingConfirmation(null);
        next.push({ role: "user", text: capitalize(event.transcript) });
      }
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

  function showBookingConfirmation(next: BookingConfirmation) {
    const key = `${next.slot}|${next.carLabel ?? ""}`;
    if (shownBookingKeysRef.current.has(key)) return;
    shownBookingKeysRef.current.add(key);
    setBookingConfirmation(next);
  }

  function applyBookingConfirmed(event: BookingConfirmedEvent) {
    showBookingConfirmation({
      slot: event.slot,
      carLabel: event.carLabel,
      smsStatus: event.smsStatus,
    });
  }

  function applyBookingPending() {
    setBookingConfirmation(null);
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
      returning: hasConnectedRef.current,
      brainMode: loadBrainMode(),
    });
    const { Room, RoomEvent } = await import("livekit-client");
    // Capture-side cleanup runs in the browser BEFORE audio is encoded/sent —
    // the biggest lever for the "too much background noise / echo" problem.
    // echoCancellation stops the agent's own TTS (over speakers) bleeding back
    // into the mic. (voiceIsolation — Chrome's experimental ML suppression —
    // was removed: it's an unproven capture constraint and a possible suspect
    // for the mic not publishing; these three are the safe LiveKit defaults.)
    const room = new Room({
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

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
          // TEMP DIAG: log every agent event so we can see if view_update arrives.
          console.log(
            "[vox] recv",
            event.type,
            event.type === "view_update"
              ? `layout=${(event as ViewUpdateEvent).view?.layout} items=${(event as ViewUpdateEvent).view?.items?.length}`
              : ""
          );
          if (event.type === "view_update") {
            // Canvas agent protocol: replace local ViewState with the agent's view.
            // Validate with Zod so a malformed event never crashes the canvas.
            const parsed = ViewUpdateEventSchema.safeParse(event);
            if (!parsed.success) {
              console.warn("[vox] view_update REJECTED by schema:", JSON.stringify(parsed.error.issues).slice(0, 500));
            } else {
              const view = parsed.data.view;
              console.log("[vox] applying view_update → setViewState", view.layout, view.zoom ? "(zoom)" : "");
              if (view.zoom) {
                // Live zoom: show the FULL image first, then apply the zoom a beat
                // later so the CSS transition animates full → zoomed (otherwise the
                // image mounts already-zoomed with no motion).
                setViewState({ ...view, zoom: undefined });
                setTimeout(() => setViewState(view), 500);
              } else {
                setViewState(view);
              }
            }
          } else if (event.type === "specialist_turn") applyAgentTurn(event);
          else if (event.type === "agent_status") applyAgentStatus(event);
          else if (event.type === "reply_delta") applyReplyDelta(event);
          else if (event.type === "reply_done") applyReplyDone(event);
          else if (event.type === "booking_confirmed") applyBookingConfirmed(event);
          else if (event.type === "booking_pending") applyBookingPending();
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
      // Mark connected so the next reconnect skips the full first-time opener.
      hasConnectedRef.current = true;
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

          {/* Canvas — pure renderer driven by viewState */}
          <div className="canvas-outer">
            <Canvas
              viewState={viewState}
              images={state.images}
              imageBusy={imageBusy}
            />
            {/* Phase-1 dev harness — only visible when ?canvas=demo */}
            {isCanvasDemo && demoViewStates.length > 0 && (
              <div className="canvas-demo-controls">
                <span className="canvas-demo-label">
                  Demo {(demoIndex % demoViewStates.length) + 1}/{demoViewStates.length}:&nbsp;
                  {demoViewStates[demoIndex % demoViewStates.length]?.layout}
                </span>
                <button
                  type="button"
                  className="canvas-demo-btn"
                  onClick={() => setDemoIndex((n) => (n - 1 + demoViewStates.length) % demoViewStates.length)}
                  aria-label="Previous demo state"
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="canvas-demo-btn"
                  onClick={() => setDemoIndex((n) => (n + 1) % demoViewStates.length)}
                  aria-label="Next demo state"
                >
                  ›
                </button>
              </div>
            )}
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
            {liveTranscript ? (
              <div className="message user live">{liveTranscript}</div>
            ) : null}
            {bookingConfirmation ? (
              <div className="booking-card" role="status" aria-label="Test drive booked">
                <div className="booking-card-icon" aria-hidden="true">
                  <CalendarCheck size={18} strokeWidth={2.2} />
                </div>
                <div className="booking-card-copy">
                  <div className="booking-card-eyebrow">Test drive booked</div>
                  <div className="booking-card-slot">{bookingConfirmation.slot}</div>
                  {bookingConfirmation.carLabel ? <div className="booking-card-car">{bookingConfirmation.carLabel}</div> : null}
                </div>
              </div>
            ) : null}
            {/* Typing loader while a reply is pending — both the typed path (busy)
                and the voice path (agent is "thinking" and hasn't begun streaming
                a reply bubble yet). Sits directly under the latest user input. */}
            {(busy ||
              (agentActivity === "thinking" &&
                !(messages[messages.length - 1]?.role === "assistant" &&
                  messages[messages.length - 1]?.streaming))) ? (
              <div className="message typing" role="status" aria-label="Specialist is typing">
                <span />
                <span />
                <span />
              </div>
            ) : null}
            {error ? <div className="message assistant">Error: {error}</div> : null}
          </div>

          <div className="composer" ref={composerRef}>
            {/* TEMP A/B brain selector — applies on next connect */}
            <div className="brain-toggle-temp">
              <span className="brain-toggle-label">Brain</span>
              <select
                className="brain-toggle-select"
                value={brainMode}
                onChange={(e) => {
                  const m = e.target.value === "double" ? "double" : "single";
                  setBrainMode(m);
                  try {
                    localStorage.setItem(BRAIN_STORAGE_KEY, m);
                  } catch {
                    // ignore storage errors
                  }
                }}
              >
                <option value="single">Single brain</option>
                <option value="double">Double brain</option>
              </select>
              {voiceState === "connected" ? (
                <span className="brain-toggle-hint">reconnect to apply</span>
              ) : null}
            </div>
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
