import { existsSync } from "node:fs";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import {
  cli,
  defineAgent,
  llm,
  type JobContext,
  ServerOptions,
  voice
} from "@livekit/agents";
import { DEFAULT_VIN, type Car, type CarImage } from "@vox/core";
import { rankImagesForQuestion } from "@vox/agent-core";
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

const encoder = new TextEncoder();
const FALLBACK_REPLY = "One sec, let me bring that up for you.";
const CARTESIA_VOICE = process.env.CARTESIA_VOICE_ID || "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
const TTS_MODEL_STRING = `cartesia/${process.env.CARTESIA_TTS_MODEL || "sonic-3"}:${CARTESIA_VOICE}` as const;

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
    `You are Vox, a sharp BMW ${car.make} ${car.model} sales specialist standing next to the car with the customer.`,
    "Reply in one or two short, natural spoken sentences — under ~30 words total. Conversational, not a pitch.",
    "Speak as if the customer is right in front of the car: say things like 'right here' or 'check this out', never 'in the image' or 'in this photo'.",
    "Do not use markdown, bullets, headers, asterisks, or emojis — your text is read aloud.",
    "Use only the catalog and the photo notes provided below. Never invent specs, packages, prices, mileage, options, or features not stated.",
    `Catalog: ${car.year} ${car.make} ${car.model} ${car.trim}, ${car.body}, ${car.color}. Features: ${car.features.join(", ")}. Description: ${car.description}`,
    imageContext
  ].join(" ");

  return { system, user: message };
}

class VoxSpecialistVoiceAgent extends voice.Agent {
  private currentImageId: string | undefined;
  private lastHandled = "";
  private lastHandledAt = 0;
  private turnCounter = 0;

  constructor(private readonly ctx: JobContext) {
    super({
      instructions: "You are Vox, a concise BMW M4 specialist who answers using the shared catalog and the on-screen image."
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
      const rawStream = await streamMiniMaxChat({ system, user, maxTokens: 160, timeoutMs: 12_000 });
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
        if (value) buffer += value;
      }
    } finally {
      reader.releaseLock();
    }
    const reply = buffer.replace(/\s+/g, " ").trim();
    if (!reply) return;
    publishSpecialistDataAsync(this.ctx, {
      type: "specialist_turn",
      vin: DEFAULT_VIN,
      reply
    });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log("Vox specialist LiveKit agent connected");
    const specialist = new VoxSpecialistVoiceAgent(ctx);

    void listImages(DEFAULT_VIN)
      .then((images) => specialist.setInitialImage(images[0]?.id))
      .catch((error) => console.warn(`Could not seed initial image: ${error instanceof Error ? error.message : String(error)}`));

    const session = new voice.AgentSession({
      stt: "deepgram/nova-3:en",
      llm: new voice.testing.FakeLLM(),
      tts: TTS_MODEL_STRING,
      userAwayTimeout: null,
      turnHandling: {
        turnDetection: "stt",
        endpointing: {
          mode: "fixed",
          minDelay: 200,
          maxDelay: 1200
        },
        interruption: {
          enabled: true,
          minDuration: 400,
          minWords: 2,
          discardAudioIfUninterruptible: false,
          falseInterruptionTimeout: 1500
        },
        preemptiveGeneration: {
          enabled: true,
          maxSpeechDuration: 8000,
          maxRetries: 2
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
      await session.start({ agent: specialist, room: ctx.room });
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
