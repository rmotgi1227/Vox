import { existsSync } from "node:fs";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import {
  cli,
  defineAgent,
  inference,
  llm,
  type JobContext,
  ServerOptions,
  voice
} from "@livekit/agents";
import { BackgroundVoiceCancellation } from "@livekit/noise-cancellation-node";
import {
  DEFAULT_VIN,
  DEFAULT_MODEL_PROFILE_ID,
  carFactSheet,
  resolveModelProfile,
  type Car,
  type CarImage
} from "@vox/core";
import { rankImagesForQuestion, selectOverviewImage } from "@vox/agent-core";
import { getCar, listImages, streamMiniMaxChat } from "@vox/ai";

config({ path: findRootEnv(process.cwd()) });

function findRootEnv(start: string): string {
  let dir = start;
  while (true) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return ".env";
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// M4 domain keyterms for Deepgram nova-3 keyterm prompting.
// Kept tight (~30 terms) — too many degrades accuracy.
// Passed through LiveKit Inference (no Deepgram API key required).
// ---------------------------------------------------------------------------
const M4_KEYTERMS: string[] = [
  "M4",
  "Competition",
  "xDrive",
  "M xDrive",
  "S58",
  "twin-turbo",
  "TwinPower Turbo",
  "carbon bucket seats",
  "M Carbon",
  "Merino leather",
  "carbon fiber roof",
  "Adaptive M suspension",
  "paddle shifters",
  "gear selector",
  "M Steptronic",
  "Brembo",
  "blue calipers",
  "quad exhaust",
  "Harman Kardon",
  "head-up display",
  "drivetrain",
  "horsepower",
  "torque",
  "Brooklyn Grey",
  "Frozen Brilliant White",
  "Isle of Man Green",
  "M Driver's Package",
  "Executive Package",
  "Laserlight",
  "iDrive",
];

const encoder = new TextEncoder();
const FALLBACK_REPLY = "One sec, let me bring that up for you.";
const CARTESIA_VOICE = process.env.CARTESIA_VOICE_ID || "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";

function publishSpecialistDataAsync(ctx: JobContext, data: Record<string, unknown>) {
  const localParticipant = ctx.room.localParticipant;
  if (!localParticipant) return;
  void localParticipant
    .publishData(encoder.encode(JSON.stringify(data)), {
      reliable: true,
      topic: "vox.specialist.turn"
    })
    .catch((error) => {
      console.warn(`publishSpecialistData failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}

function latestUserText(chatCtx: llm.ChatContext): string {
  for (const item of [...chatCtx.items].reverse()) {
    if (item.type !== "message") continue;
    const message = item as llm.ChatMessage;
    if (message.role === "user" && message.textContent) return message.textContent;
  }
  return "";
}

function textStream(text: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    }
  });
}

function buildVoicePrompt(input: {
  car: Car;
  image: CarImage | undefined;
  message: string;
}): { system: string; user: string } {
  const { car, image, message } = input;
  const imageContext = image
    ? [
        `You are currently showing the customer this view: ${image.caption}`,
        image.visibleFeatures.length ? `Visible in the photo: ${image.visibleFeatures.join(", ")}.` : "",
        image.conditionNotes?.length ? `Notes: ${image.conditionNotes.join(", ")}.` : ""
      ].filter(Boolean).join(" ")
    : "No specific photo is up right now.";

  const system = [
    `You are Vox, a warm, sharp BMW ${car.make} ${car.model} sales specialist talking with a customer. You sell by being genuinely helpful, never pushy.`,
    "This is a VOICE conversation — lead with what you say. A screen beside you can show a photo as a visual aid, but it is secondary: most turns are just talking, and you should not steer every answer toward an image.",
    "Reply in one or two short, natural spoken sentences — under ~30 words total. Conversational, not a pitch.",
    "Silently read what they're doing: small talk, a spec or fact question, a request to SEE something, something ambiguous, or an objection or buying signal. Then:",
    "- Spec or fact (price, mileage, 0-60, horsepower, mpg, transmission, packages, 'is it fast', 'good on gas'): just answer it straight from the catalog below. Don't mention the screen or a photo at all.",
    "- They clearly want to SEE something: bring it up and say a quick word about it ('here's the rear — check out the quad tips'). Only then reference the screen.",
    "- Ambiguous (you'd be guessing): ask ONE short question back, then stop and wait — don't answer yet.",
    "- Objection or buying signal: acknowledge it, answer plainly, and you may add one soft, helpful question.",
    "Only mention the screen when a relevant photo is actually up for a visual request; otherwise never say 'here' / 'on screen' / 'check this out' — just talk. Never say 'in the image' or 'in this photo'.",
    "Ask at most one question per reply, and never re-ask something you just asked — make a reasonable assumption and move on. Never ask what the catalog already answers; just answer it.",
    "Do not use markdown, bullets, headers, asterisks, or emojis — your text is read aloud. Never read specs like a brochure list; give the one or two numbers they actually asked for.",
    "Use only the catalog and the photo notes provided below. Never invent specs, packages, prices, mileage, options, or features not stated; if you don't have a fact, say so casually.",
    `Catalog: ${carFactSheet(car)}`,
    imageContext
  ].join(" ");

  return { system, user: message };
}

class VoxSpecialistVoiceAgent extends voice.Agent {
  private currentImageId: string | undefined;
  private lastHandled = "";
  private lastHandledAt = 0;
  private turnCounter = 0;

  constructor(
    private readonly ctx: JobContext,
    private readonly llmModel: string
  ) {
    super({
      instructions: "You are Vox, a voice-first BMW M4 sales specialist. You hold a natural spoken conversation; a screen beside you can show photos as a visual aid, but you lead with talking, not images."
    });
  }

  setInitialImage(id: string | undefined) {
    this.currentImageId = id;
  }

  override async llmNode(chatCtx: llm.ChatContext): Promise<ReadableStream<string> | null> {
    const message = latestUserText(chatCtx);
    if (!message) return textStream("I didn't catch that — could you say it again?");

    const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();
    const now = Date.now();
    if (normalized === this.lastHandled && now - this.lastHandledAt < 1_200) {
      return textStream("");
    }
    this.lastHandled = normalized;
    this.lastHandledAt = now;
    const turnId = ++this.turnCounter;
    console.log(`Vox turn #${turnId}: ${message}`);

    try {
      const [car, images] = await Promise.all([getCar(DEFAULT_VIN), listImages(DEFAULT_VIN)]);
      if (!car) return textStream("I can't find this vehicle right now.");

      const ranked = rankImagesForQuestion(message, images);
      const heuristicWinner = ranked[0]?.image;
      const topScore = ranked[0]?.score ?? 0;

      const imageForReply = topScore >= 6 ? heuristicWinner : images.find((image) => image.id === this.currentImageId);

      if (heuristicWinner && topScore >= 6 && heuristicWinner.id !== this.currentImageId) {
        this.currentImageId = heuristicWinner.id;
        publishSpecialistDataAsync(this.ctx, {
          type: "specialist_turn",
          vin: DEFAULT_VIN,
          transcript: message,
          selectedImageId: heuristicWinner.id,
          action: { type: "show_image", imageId: heuristicWinner.id, reason: heuristicWinner.caption },
          sources: [
            { type: "catalog", id: car.vin, label: `${car.year} ${car.make} ${car.model}` },
            { type: "image", id: heuristicWinner.id, label: heuristicWinner.caption }
          ]
        });
      } else {
        publishSpecialistDataAsync(this.ctx, {
          type: "specialist_turn",
          vin: DEFAULT_VIN,
          transcript: message
        });
      }

      const { system, user } = buildVoicePrompt({ car, image: imageForReply, message });
      const rawStream = await streamMiniMaxChat({
        system,
        user,
        model: this.llmModel,
        maxTokens: 160,
        timeoutMs: 12_000
      });
      const tokenStream = rawStream as unknown as ReadableStream<string>;
      return this.teeAndPublishReply(tokenStream);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`llmNode failed: ${detail}`);
      publishSpecialistDataAsync(this.ctx, { type: "agent_status", status: "Error", error: detail });
      return textStream(FALLBACK_REPLY);
    }
  }

  private teeAndPublishReply(tokenStream: ReadableStream<string>): ReadableStream<string> {
    const [speakStream, captureStream] = tokenStream.tee();
    void this.captureReplyText(captureStream).catch((err) => {
      console.warn(`reply capture failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return speakStream;
  }

  private async captureReplyText(stream: ReadableStream<string>): Promise<void> {
    const reader = stream.getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          // Task 5: publish each chunk as it arrives so the UI renders text incrementally.
          publishSpecialistDataAsync(this.ctx, { type: "reply_delta", text: value });
        }
      }
    } finally {
      reader.releaseLock();
    }
    const reply = buffer.replace(/\s+/g, " ").trim();
    if (!reply) return;
    // Task 5: terminal event — full assembled reply text.
    publishSpecialistDataAsync(this.ctx, { type: "reply_done", reply });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log("Vox specialist LiveKit agent connected");

    // -----------------------------------------------------------------------
    // Task 3: Read dispatch metadata to resolve the model profile.
    // The API encodes { vin, profileId } in the RoomAgentDispatch metadata.
    // ctx.job.metadata is the raw JSON string from that dispatch.
    // Fall back to DEFAULT_MODEL_PROFILE_ID if metadata is absent or invalid.
    // -----------------------------------------------------------------------
    let profileId: string | undefined;
    try {
      const raw = ctx.job.metadata;
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed.profileId === "string") {
          profileId = parsed.profileId;
        }
      }
    } catch {
      // malformed metadata — use default
    }
    const profile = resolveModelProfile(profileId ?? DEFAULT_MODEL_PROFILE_ID);
    console.log(`Vox profile: ${profile.id} (llm=${profile.llmModel}, tts=${profile.ttsModel})`);

    // Build TTS string from profile: "cartesia/<ttsModel>:<voiceId>"
    const ttsString = `cartesia/${profile.ttsModel}:${CARTESIA_VOICE}`;

    const specialist = new VoxSpecialistVoiceAgent(ctx, profile.llmModel);

    void listImages(DEFAULT_VIN)
      .then((images) => specialist.setInitialImage(selectOverviewImage(images)?.id ?? images[0]?.id))
      .catch((error) => console.warn(`Could not seed initial image: ${error instanceof Error ? error.message : String(error)}`));

    // -----------------------------------------------------------------------
    // Deepgram nova-3 STT via LiveKit Inference — billed on LiveKit credits,
    // no Deepgram API key required. modelOptions.keyterms boosts recognition
    // of the M4 domain vocabulary (our Wispr-Flow accuracy goal).
    // -----------------------------------------------------------------------
    const sttOption = new inference.STT<"deepgram/nova-3">({
      model: "deepgram/nova-3",
      language: "en",
      modelOptions: { keyterms: M4_KEYTERMS }
    });

    const session = new voice.AgentSession({
      stt: sttOption,
      llm: new voice.testing.FakeLLM(),
      tts: ttsString,
      userAwayTimeout: null,
      turnHandling: {
        turnDetection: "stt",
        // Dynamic endpointing adapts to the speaker's pace and waits out
        // mid-sentence pauses ("walk me through the, like, ... estimates")
        // instead of firing on every brief silence.
        endpointing: {
          mode: "dynamic",
          minDelay: 600,
          maxDelay: 3500
        },
        interruption: {
          enabled: true,
          minDuration: 500,
          minWords: 3,
          discardAudioIfUninterruptible: false,
          falseInterruptionTimeout: 2000
        },
        // Disabled: speculative generation before the turn is committed was
        // firing the LLM on partial utterances, publishing a chat bubble whose
        // audio then got discarded when the shopper kept talking.
        preemptiveGeneration: {
          enabled: false
        }
      }
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
      console.log(`STT ${event.isFinal ? "final" : "partial"}: ${event.transcript}`);
      if (!event.transcript.trim()) return;
      publishSpecialistDataAsync(ctx, {
        type: "agent_status",
        status: event.isFinal ? "thinking" : "hearing",
        transcript: event.transcript,
        isFinal: event.isFinal
      });
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
      console.log(`agent state: ${event.oldState} -> ${event.newState}`);
      publishSpecialistDataAsync(ctx, {
        type: "agent_status",
        status: event.newState
      });
    });
    session.on(voice.AgentSessionEventTypes.Error, (event) => {
      const message = String((event as { error?: unknown }).error ?? "LiveKit agent error");
      console.warn(message);
      publishSpecialistDataAsync(ctx, {
        type: "agent_status",
        status: "error",
        error: message
      });
    });

    try {
      // Task 1: BackgroundVoiceCancellation — strips background voices and
      // ambient noise before the STT pipeline sees the audio.
      await session.start({
        agent: specialist,
        room: ctx.room,
        inputOptions: { noiseCancellation: BackgroundVoiceCancellation() }
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`Failed to start AgentSession: ${detail}`);
      publishSpecialistDataAsync(ctx, {
        type: "agent_status",
        status: "error",
        error: `Agent session failed to start: ${detail}`
      });
      throw error;
    }
  }
});

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: "vox-specialist",
  logLevel: "info",
  port: Number(process.env.LIVEKIT_AGENT_PORT ?? 8081)
}));
