import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import {
  audioFramesFromFile,
  cli,
  defineAgent,
  llm,
  type JobContext,
  ServerOptions,
  voice
} from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import { DEFAULT_VIN, type SpecialistTurn } from "@vox/core";
import { chooseMiniMaxSpecialistImage, generateMiniMaxFastTurn, getCar, listImages, searchMoss, synthesizeSpeech } from "@vox/ai";

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

async function publishSpecialistData(ctx: JobContext, data: Record<string, unknown>) {
  const localParticipant = ctx.room.localParticipant;
  if (!localParticipant) return;
  await localParticipant.publishData(encoder.encode(JSON.stringify(data)), {
    reliable: true,
    topic: "vox.specialist.turn"
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

async function collectText(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out += value;
    }
    return out;
  } finally {
    reader.releaseLock();
  }
}

async function createSpeechAudioStream(text: string): Promise<ReadableStream<AudioFrame> | null> {
  if (!text.trim()) return null;
  const audio = await synthesizeSpeech(text);
  if (!audio.audioBase64) return null;
  console.log(`Vox TTS provider: ${audio.provider ?? "unknown"}`);
  const filePath = path.join(os.tmpdir(), `vox-tts-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
  await writeFile(filePath, Buffer.from(audio.audioBase64, "base64"));
  return audioFramesFromFile(filePath, { sampleRate: 44100, numChannels: 1, format: "mp3" });
}

class VoxSpecialistVoiceAgent extends voice.Agent {
  private currentImageId: string | undefined;
  private lastHandled = "";
  private lastHandledAt = 0;

  constructor(private readonly ctx: JobContext) {
    super({
      instructions: "You are Vox, a concise BMW M4 specialist. Use the shared specialist orchestrator for every answer."
    });
  }

  override async llmNode(chatCtx: llm.ChatContext): Promise<ReadableStream<string> | null> {
    const message = latestUserText(chatCtx);
    if (!message) return textStream("I did not catch that. Please ask again.");
    const turn = await this.handleShopperMessage(message);
    return textStream(turn?.reply ?? "");
  }

  async handleShopperMessage(message: string): Promise<SpecialistTurn | undefined> {
    const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();
    const now = Date.now();
    if (normalized === this.lastHandled && now - this.lastHandledAt < 4_000) return undefined;
    this.lastHandled = normalized;
    this.lastHandledAt = now;
    console.log(`Vox specialist turn: ${message}`);
    const [car, images] = await Promise.all([getCar(DEFAULT_VIN), listImages(DEFAULT_VIN)]);
    if (!car) return undefined;
    const currentImage = images.find((image) => image.id === this.currentImageId);
    const fast = await generateMiniMaxFastTurn({ car, message, currentImage });
    const turn: SpecialistTurn = {
      reply: fast.reply,
      selectedImageId: this.currentImageId,
      action: { type: "keep_current_image" },
      sources: [{ type: "catalog", id: car.vin, label: `${car.year} ${car.make} ${car.model}` }]
    };

    await publishSpecialistData(this.ctx, {
      type: "specialist_turn",
      vin: DEFAULT_VIN,
      transcript: message,
      reply: turn.reply,
      action: turn.action,
      sources: turn.sources
    });
    if (fast.needsImage) {
      void this.chooseAndPublishImage(message, fast.desiredVisualTarget).catch((error) => {
        console.warn(`Image planner failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return turn;
  }

  private async chooseAndPublishImage(message: string, desiredVisualTarget?: string | null) {
    const [car, images, mossResults] = await Promise.all([
      getCar(DEFAULT_VIN),
      listImages(DEFAULT_VIN),
      searchMoss(desiredVisualTarget || message, DEFAULT_VIN)
    ]);
    if (!car) return;
    const plan = await chooseMiniMaxSpecialistImage({
      car,
      images,
      message,
      currentImageId: this.currentImageId,
      desiredVisualTarget,
      mossResults
    });
    const selectedImage = plan.selectedImageId ? images.find((image) => image.id === plan.selectedImageId) : undefined;
    if (!selectedImage) return;
    this.currentImageId = selectedImage.id;
    await publishSpecialistData(this.ctx, {
      type: "specialist_turn",
      vin: DEFAULT_VIN,
      selectedImageId: selectedImage.id,
      action: { type: "show_image", imageId: selectedImage.id, reason: plan.actionReason || selectedImage.caption },
      sources: [
        { type: "catalog", id: car.vin, label: `${car.year} ${car.make} ${car.model}` },
        { type: "image", id: selectedImage.id, label: selectedImage.caption }
      ]
    });
  }

  override async ttsNode(text: ReadableStream<string>): Promise<ReadableStream<AudioFrame> | null> {
    const reply = await collectText(text);
    return createSpeechAudioStream(reply);
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    console.log("Vox specialist LiveKit agent connected");
    const specialist = new VoxSpecialistVoiceAgent(ctx);

    const session = new voice.AgentSession({
      stt: "deepgram/nova-3:en",
      userAwayTimeout: null,
      turnHandling: {
        turnDetection: "stt",
        endpointing: {
          mode: "fixed",
          minDelay: 950,
          maxDelay: 2400
        },
        interruption: {
          enabled: true,
          minDuration: 950,
          minWords: 3,
          discardAudioIfUninterruptible: false,
          falseInterruptionTimeout: 2200
        },
        preemptiveGeneration: {
          enabled: false
        }
      }
    });
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
      console.log(`LiveKit STT ${event.isFinal ? "final" : "partial"}: ${event.transcript}`);
      if (!event.transcript.trim()) return;
      void publishSpecialistData(ctx, {
        type: "agent_status",
        status: event.isFinal ? "Thinking" : "Hearing",
        transcript: event.transcript,
        isFinal: event.isFinal
      }).catch((error) => console.warn(`Could not publish transcript event: ${error instanceof Error ? error.message : String(error)}`));
    });
    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
      console.log(`LiveKit agent state: ${event.oldState} -> ${event.newState}`);
      void publishSpecialistData(ctx, {
        type: "agent_status",
        status: event.newState
      }).catch((error) => console.warn(`Could not publish state event: ${error instanceof Error ? error.message : String(error)}`));
    });
    session.on(voice.AgentSessionEventTypes.Error, (event) => {
      const message = String((event as { error?: unknown }).error ?? "LiveKit agent error");
      console.warn(message);
      void publishSpecialistData(ctx, {
        type: "agent_status",
        status: "Error",
        error: message
      }).catch((error) => console.warn(`Could not publish error event: ${error instanceof Error ? error.message : String(error)}`));
    });
    await session.start({
      agent: specialist,
      room: ctx.room
    });
  }
});

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: "vox-specialist",
  logLevel: "info",
  port: Number(process.env.LIVEKIT_AGENT_PORT ?? 8081)
}));
