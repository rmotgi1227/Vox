import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Car, CarImage, ImageRole } from "@vox/core";
import { CarImageSchema, CarSchema, DEFAULT_VIN } from "@vox/core";
import { z } from "zod";

const root = findRepoRoot(process.cwd());
const catalogPath = path.join(root, "data", "catalog.json");
const imagesPath = path.join(root, "data", "images.json");
const uploadRoot = path.join(root, "public", "uploads", "cars");
const mossCachePath = path.join(root, ".moss-cache");

let catalogCache: Promise<Car[]> | undefined;
let imagesCache: Promise<CarImage[]> | undefined;

function invalidateDataCaches(): void {
  catalogCache = undefined;
  imagesCache = undefined;
}

export type MossSearchResult = {
  id: string;
  label: string;
  text: string;
  score?: number;
  docType?: "catalog" | "image" | "unknown";
  metadata?: Record<string, string>;
};

type MossDoc = {
  id: string;
  text: string;
  score?: number;
  metadata?: Record<string, string>;
};

type MossClientLike = {
  loadIndex(indexName: string, options: { cachePath: string }): Promise<unknown>;
  query(indexName: string, query: string, options: {
    topK: number;
    filter?: { field: string; condition: { $eq: string } };
  }): Promise<{ docs: MossDoc[] }>;
};

type MossClientCache = {
  signature: string;
  client: MossClientLike;
  loaded: Promise<void>;
};

const MiniMaxSpecialistPlanSchema = z.object({
  reply: z.string().min(1),
  selectedImageId: z.string().nullable().optional(),
  actionReason: z.string().optional()
});

const MiniMaxTurnIntentSchema = z.object({
  needsImage: z.boolean(),
  desiredVisualTarget: z.string().nullable(),
  answerFocus: z.string().min(1),
  replyIfNoImage: z.string().nullable().optional()
});

const MiniMaxFastTurnSchema = z.object({
  reply: z.string().min(1),
  needsImage: z.boolean(),
  desiredVisualTarget: z.string().nullable().optional()
});

let mossClientCache: MossClientCache | undefined;

function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(path.join(dir, "data", "catalog.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export async function readCatalog(): Promise<Car[]> {
  if (!catalogCache) {
    catalogCache = readFile(catalogPath, "utf8")
      .then((raw) => CarSchema.array().parse(JSON.parse(raw)))
      .catch((error) => {
        catalogCache = undefined;
        throw error;
      });
  }
  return catalogCache;
}

export async function readImages(): Promise<CarImage[]> {
  if (!imagesCache) {
    imagesCache = readFile(imagesPath, "utf8")
      .then((raw) => CarImageSchema.array().parse(JSON.parse(raw)))
      .catch((error) => {
        imagesCache = undefined;
        throw error;
      });
  }
  return imagesCache;
}

export async function writeImages(images: CarImage[]): Promise<void> {
  await writeFile(imagesPath, JSON.stringify(CarImageSchema.array().parse(images), null, 2) + "\n");
  invalidateDataCaches();
}

export async function getCar(vin = DEFAULT_VIN): Promise<Car | undefined> {
  const cars = await readCatalog();
  return cars.find((car) => car.vin === vin);
}

export async function listImages(vin = DEFAULT_VIN): Promise<CarImage[]> {
  const images = await readImages();
  return images.filter((image) => image.vin === vin);
}

export async function saveUploadedImage(input: {
  vin: string;
  fileName: string;
  bytes: Uint8Array;
}): Promise<CarImage> {
  const id = `img_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const ext = path.extname(input.fileName).toLowerCase() || ".jpg";
  const dir = path.join(uploadRoot, input.vin);
  await mkdir(dir, { recursive: true });
  const safeName = `${id}${ext}`;
  const fsPath = path.join(dir, safeName);
  await writeFile(fsPath, input.bytes);

  const image: CarImage = {
    id,
    vin: input.vin,
    url: `/uploads/cars/${input.vin}/${safeName}`,
    role: "unknown",
    viewpoint: "uploaded image pending review",
    caption: `Uploaded image ${input.fileName}`,
    visibleFeatures: [],
    conditionNotes: [],
    searchTags: [],
    likelyQuestions: [],
    confidence: 0,
    status: "pending"
  };
  const images = await readImages();
  images.push(image);
  await writeImages(images);
  return image;
}

export async function ingestImageObject(imageId: string): Promise<CarImage | undefined> {
  const images = await readImages();
  const idx = images.findIndex((image) => image.id === imageId);
  if (idx < 0) return undefined;
  const current = images[idx];
  if (!current) return undefined;
  const role = inferRoleFromText(`${current.caption} ${current.url}`);
  const next: CarImage = {
    ...current,
    role,
    viewpoint: current.viewpoint || `${role.replaceAll("_", " ")} uploaded image`,
    caption: await analyzeImageFallback(current, role),
    visibleFeatures: featuresForRole(role),
    conditionNotes: current.conditionNotes ?? [],
    searchTags: [...new Set([...(current.searchTags ?? []), role.replaceAll("_", " "), ...featuresForRole(role)])],
    confidence: role === "unknown" ? 0.35 : 0.72,
    status: "processed"
  };
  images[idx] = next;
  await writeImages(images);
  return next;
}

export async function copySeedImageForTests(sourceUrl: string, vin = DEFAULT_VIN): Promise<CarImage> {
  const source = path.join(root, "public", sourceUrl.replace(/^\//, ""));
  const id = `img_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const dir = path.join(uploadRoot, vin);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${id}.jpg`);
  await copyFile(source, target);
  return {
    id,
    vin,
    url: `/uploads/cars/${vin}/${id}.jpg`,
    role: "unknown",
    viewpoint: "copied seed image pending review",
    caption: "Copied seed image",
    visibleFeatures: [],
    conditionNotes: [],
    searchTags: [],
    likelyQuestions: [],
    confidence: 0,
    status: "pending"
  };
}

export function inferRoleFromText(text: string): ImageRole {
  const low = text.toLowerCase();
  if (/(trunk|cargo|boot)/.test(low)) return "trunk";
  if (/(dashboard|dash|cockpit|screen)/.test(low)) return "dashboard";
  if (/(interior|cabin|seat|console)/.test(low)) return "interior_front";
  if (/(wheel|tire|brake|rim)/.test(low)) return "wheel";
  if (/(rear|back|taillight)/.test(low)) return "exterior_rear";
  if (/(front|exterior|headlight)/.test(low)) return "exterior_front";
  return "unknown";
}

function featuresForRole(role: ImageRole): string[] {
  const map: Record<ImageRole, string[]> = {
    exterior_front: ["front fascia", "headlights", "paint"],
    exterior_rear: ["rear profile", "taillights", "liftgate"],
    interior_front: ["front seats", "dashboard", "center console"],
    interior_rear: ["rear seats", "legroom", "second row"],
    dashboard: ["driver display", "infotainment", "controls"],
    trunk: ["cargo area", "storage", "load floor"],
    wheel: ["wheel", "tire", "brake"],
    detail: ["detail", "trim"],
    unknown: []
  };
  return map[role];
}

async function analyzeImageFallback(image: CarImage, role: ImageRole): Promise<string> {
  if (process.env.MINIMAX_API_KEY && process.env.VOX_ENABLE_MINIMAX_IMAGE_INGEST === "1") {
    return `${image.caption}. MiniMax image ingestion is configured for this adapter, but structured vehicle-image tagging is currently using fallback role inference.`;
  }
  if (role === "unknown") return `${image.caption}. The image needs manual review before specialist use.`;
  return `${image.caption}. Classified as ${role.replaceAll("_", " ")} from filename and upload context.`;
}

export async function generateMiniMaxReply(input: {
  system: string;
  user: string;
}): Promise<string> {
  const key = process.env.MINIMAX_API_KEY;
  if (process.env.VOX_PROVIDER_MODE === "mock") {
    return mockReply(input.user);
  }
  if (!key) throw new Error("MINIMAX_API_KEY is required for real chat generation. Set VOX_PROVIDER_MODE=mock only for local tests.");
  const resp = await fetch("https://api.minimax.io/v1/text/chatcompletion_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "MiniMax-Text-01",
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user }
      ],
      max_tokens: 72,
      temperature: 0.25
    }),
    signal: AbortSignal.timeout(12_000)
  });
  if (!resp.ok) throw new Error(`MiniMax text error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const base = data.base_resp ?? {};
  if (base.status_code) throw new Error(`MiniMax text error ${base.status_code}: ${base.status_msg}`);
  const text = String(data.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("MiniMax returned an empty text response.");
  return compactReply(text);
}

export async function generateMiniMaxFastTurn(input: {
  car: Car;
  message: string;
  currentImage?: CarImage;
}): Promise<{ reply: string; needsImage: boolean; desiredVisualTarget?: string | null }> {
  if (process.env.VOX_PROVIDER_MODE === "mock") {
    return {
      reply: mockReply(input.message),
      needsImage: true,
      desiredVisualTarget: input.message
    };
  }
  const parsed = MiniMaxFastTurnSchema.parse(await callMiniMaxJson({
    system: [
      "You are Vox, a concise BMW M4 visual specialist.",
      "Decide needsImage and reply in JSON. Reply is one short natural sentence, under 12 words.",
      "When needsImage is true, the reply is ONLY a brief acknowledgement like 'Pulling that up.' or 'Here is that view.' — never make any claim about visible features, presence/absence, condition, or measurements; the next step provides the real answer.",
      "needsImage is true when the shopper asks about, names, or wants to see/inspect any part, area, view, or feature of the car (interior, wheels, trunk, dashboard, roof, shifter, etc.), or asks a yes/no question about a visible feature.",
      "needsImage is false ONLY for pure greetings, social chat, or questions clearly unrelated to anything visible.",
      "Shopper jargon: 'stick' = gear selector/shifter; 'whole/entire/full car' = wide exterior overview.",
      "When needsImage is true, desiredVisualTarget is a short natural-language description of the ideal image.",
      "Return strict JSON only with keys reply, needsImage, desiredVisualTarget."
    ].join(" "),
    user: JSON.stringify({
      shopperMessage: input.message,
      car: {
        year: input.car.year,
        make: input.car.make,
        model: input.car.model,
        trim: input.car.trim,
        body: input.car.body,
        color: input.car.color,
        features: input.car.features,
        description: input.car.description
      },
      currentImage: input.currentImage ? {
        id: input.currentImage.id,
        role: input.currentImage.role,
        caption: input.currentImage.caption,
        visibleFeatures: input.currentImage.visibleFeatures
      } : null
    }),
    maxTokens: 80,
    timeoutMs: 6_000
  }));
  return {
    reply: compactReply(parsed.reply),
    needsImage: parsed.needsImage,
    desiredVisualTarget: parsed.desiredVisualTarget
  };
}

export async function chooseMiniMaxSpecialistImage(input: {
  car: Car;
  images: CarImage[];
  message: string;
  currentImageId?: string;
  desiredVisualTarget?: string | null;
  mossResults: MossSearchResult[];
}): Promise<{ reply: string; selectedImageId?: string | null; actionReason?: string }> {
  if (process.env.VOX_PROVIDER_MODE === "mock") {
    throw new Error("MiniMax image planner is disabled in mock provider mode.");
  }
  const allowedIds = new Set(input.images.map((image) => image.id));
  const imageOptions = input.images.map((image) => ({
    id: image.id,
    role: image.role,
    description: [
      image.viewpoint,
      image.caption,
      `Visible: ${image.visibleFeatures.join(", ")}`,
      image.conditionNotes.length ? `Evidence: ${image.conditionNotes.join(", ")}` : "",
      image.searchTags.length ? `Aliases: ${image.searchTags.join(", ")}` : "",
      image.likelyQuestions.length ? `Useful for: ${image.likelyQuestions.join(" ")}` : ""
    ].filter(Boolean).join(" ")
  }));
  const parsed = MiniMaxSpecialistPlanSchema.parse(await callMiniMaxJson({
    system: [
      "You are Vox, a friendly car salesperson walking a shopper through this BMW in person.",
      "Choose the best image id for the shopper's desired visual target by reasoning over IMAGE_OPTIONS.",
      "If the shopper is only greeting, chatting, or asking a non-visual fact with no useful supporting photo, selectedImageId must be null.",
      "For yes/no questions about visible physical vehicle features, choose the best supporting image if one exists.",
      "Do not use literal substring matching; infer the relevant vehicle view or part semantically.",
      "Use automotive shopper language: for example, stick usually means gear selector, shifter, shift lever, or center-console transmission selector.",
      "Prefer the most specific image whose description directly names the requested part or view.",
      "For yes/no feature questions, do not answer yes if the selected image description says the feature is absent.",
      "Decision examples: a greeting like 'hey how are you' returns selectedImageId null; 'show me the stick' chooses the gear selector/shifter image; a visible feature question should choose supporting evidence if available.",
      "If the selected image text says a requested feature is not present, the reply must start with no/not present rather than yes.",
      "Only return an id from IMAGE_OPTIONS, or null if there is no useful visual match.",
      // Persona for the spoken reply:
      "Talk like a friend showing them the car, not a brochure. Relaxed, warm, get to the point.",
      "Mostly just answer the question directly. Only sometimes open with a quick acknowledgement like 'Yeah, good question' or 'Oh nice' — do not start every reply that way; vary it and often skip it.",
      "Point them to what's on screen when it helps ('you can see it here on the left'), and add one concrete spec only if it is present in the car data or image description.",
      "Keep it short and natural: usually one or two sentences, like talking to a buddy.",
      "Never oversell, never hype, never stack adjectives or push the sale. If you don't know an exact number or measurement, just say so casually instead of inventing it.",
      "Return strict JSON only with keys reply, selectedImageId, actionReason."
    ].join(" "),
    user: JSON.stringify({
      shopperMessage: input.message,
      desiredVisualTarget: input.desiredVisualTarget || input.message,
      currentImageId: input.currentImageId ?? null,
      car: {
        year: input.car.year,
        make: input.car.make,
        model: input.car.model,
        body: input.car.body,
        color: input.car.color,
        features: input.car.features,
        description: input.car.description
      },
      imageOptions
    }),
    maxTokens: 220,
    timeoutMs: 14_000
  }));
  const selectedImageId = parsed.selectedImageId && allowedIds.has(parsed.selectedImageId)
    ? parsed.selectedImageId
    : null;
  return {
    reply: compactReply(parsed.reply),
    selectedImageId,
    actionReason: parsed.actionReason
  };
}

export async function generateMiniMaxSpecialistPlan(input: {
  car: Car;
  images: CarImage[];
  message: string;
  currentImageId?: string;
  mossResults: MossSearchResult[];
}): Promise<{ reply: string; selectedImageId?: string | null; actionReason?: string }> {
  if (process.env.VOX_PROVIDER_MODE === "mock") {
    throw new Error("MiniMax specialist planner is disabled in mock provider mode.");
  }
  const currentImage = input.images.find((image) => image.id === input.currentImageId);
  const intent = MiniMaxTurnIntentSchema.parse(await callMiniMaxJson({
    system: [
      "You are Vox, a concise BMW sales specialist.",
      "Classify the shopper's turn before any image selection.",
      "Do not choose an image id here.",
      "Infer intent semantically, including colloquial automotive language and corrections to the previous image.",
      "If the shopper is only greeting or chatting, needsImage is false and replyIfNoImage is a natural short response.",
      "If they ask to see, inspect, compare, or identify a car part/view/feature, needsImage is true.",
      "For visual turns, desiredVisualTarget should describe the ideal image in natural language.",
      "Return strict JSON only with keys needsImage, desiredVisualTarget, answerFocus, replyIfNoImage."
    ].join(" "),
    user: JSON.stringify({
      shopperMessage: input.message,
      currentImage: currentImage ? {
        id: currentImage.id,
        role: currentImage.role,
        caption: currentImage.caption,
        visibleFeatures: currentImage.visibleFeatures
      } : null,
      car: {
        year: input.car.year,
        make: input.car.make,
        model: input.car.model,
        trim: input.car.trim,
        body: input.car.body,
        color: input.car.color,
        features: input.car.features,
        description: input.car.description
      }
    }),
    maxTokens: 180
  }));

  if (!intent.needsImage) {
    return {
      reply: compactReply(intent.replyIfNoImage || "Hey, I’m here. What do you want to see or know about this M4?"),
      selectedImageId: null,
      actionReason: "No visual change requested."
    };
  }

  const allowedIds = new Set(input.images.map((image) => image.id));
  const imageOptions = input.images.map((image) => ({
    id: image.id,
    role: image.role,
    description: [
      image.viewpoint,
      image.caption,
      `Visible: ${image.visibleFeatures.join(", ")}`,
      image.conditionNotes.length ? `Evidence: ${image.conditionNotes.join(", ")}` : "",
      image.searchTags.length ? `Aliases: ${image.searchTags.join(", ")}` : "",
      image.likelyQuestions.length ? `Useful for: ${image.likelyQuestions.join(" ")}` : ""
    ].filter(Boolean).join(" ")
  }));

  const parsed = MiniMaxSpecialistPlanSchema.parse(await callMiniMaxJson({
    system: [
      "You are Vox, a BMW visual browsing agent.",
      "Choose the best image id for the desired visual target by reasoning over IMAGE_OPTIONS.",
      "If the shopper is only greeting, chatting, or asking a non-visual fact with no useful supporting photo, selectedImageId must be null.",
      "For yes/no questions about visible physical vehicle features, choose the best supporting image if one exists.",
      "Do not use literal substring matching; infer the relevant vehicle view or part semantically.",
      "Use automotive shopper language: for example, stick usually means gear selector, shifter, shift lever, or center-console transmission selector.",
      "Prefer the most specific image whose description directly names the requested part or view.",
      "For yes/no feature questions, do not answer yes if the selected image description says the feature is absent.",
      "Decision examples: a greeting like 'hey how are you' returns selectedImageId null; 'show me the stick' chooses the gear selector/shifter image; a visible feature question should choose supporting evidence if available.",
      "If the selected image text says a requested feature is not present, the reply must start with no/not present rather than yes.",
      "Only return an id from IMAGE_OPTIONS, or null if there is no useful visual match.",
      "If the chosen image cannot prove an exact fact, say that briefly instead of guessing.",
      "Reply like a salesperson: direct, natural, one short sentence, ideally under 22 words.",
      "Return strict JSON only with keys reply, selectedImageId, actionReason."
    ].join(" "),
    user: JSON.stringify({
      shopperMessage: input.message,
      desiredVisualTarget: intent.desiredVisualTarget,
      answerFocus: intent.answerFocus,
      currentImageId: input.currentImageId ?? null,
      car: {
        year: input.car.year,
        make: input.car.make,
        model: input.car.model,
        body: input.car.body,
        color: input.car.color,
        features: input.car.features,
        description: input.car.description
      },
      imageOptions
    }),
    maxTokens: 220
  }));
  const selectedImageId = parsed.selectedImageId && allowedIds.has(parsed.selectedImageId)
    ? parsed.selectedImageId
    : null;
  return {
    reply: compactReply(parsed.reply),
    selectedImageId,
    actionReason: parsed.actionReason
  };
}

export async function synthesizeMiniMaxSpeech(text: string): Promise<{ audioBase64?: string }> {
  const key = process.env.MINIMAX_API_KEY;
  if (!key || process.env.VOX_PROVIDER_MODE === "mock") return {};
  const group = process.env.MINIMAX_GROUP_ID;
  const url = new URL("https://api.minimax.io/v1/t2a_v2");
  if (group) url.searchParams.set("GroupId", group);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "speech-02-hd",
      text,
      stream: false,
      voice_setting: { voice_id: "Friendly_Person", speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 }
    }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!resp.ok) throw new Error(`MiniMax TTS error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const audioHex = data.data?.audio;
  if (!audioHex) return {};
  return { audioBase64: Buffer.from(audioHex, "hex").toString("base64") };
}

export type SpeechSynthesisResult = {
  audioBase64?: string;
  mimeType?: string;
  provider?: "cartesia" | "minimax";
};

export async function synthesizeCartesiaSpeech(text: string): Promise<SpeechSynthesisResult> {
  const key = process.env.CARTESIA_API_KEY;
  if (!key || process.env.VOX_PROVIDER_MODE === "mock") return {};
  const voiceId = process.env.CARTESIA_VOICE_ID ?? "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
  const modelId = process.env.CARTESIA_MODEL_ID ?? "sonic-3.5";
  const resp = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: {
      "X-API-Key": key,
      "Cartesia-Version": process.env.CARTESIA_VERSION ?? "2024-11-13",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model_id: modelId,
      transcript: text,
      voice: { mode: "id", id: voiceId },
      language: "en",
      output_format: {
        container: "mp3",
        encoding: "mp3",
        sample_rate: 44100,
        bit_rate: 128000
      },
      generation_config: { volume: 1, speed: 1.25 }
    }),
    signal: AbortSignal.timeout(12_000)
  });
  if (!resp.ok) throw new Error(`Cartesia TTS error ${resp.status}: ${await resp.text()}`);
  const bytes = Buffer.from(await resp.arrayBuffer());
  if (!bytes.length) return {};
  return {
    audioBase64: bytes.toString("base64"),
    mimeType: resp.headers.get("content-type") ?? "audio/mpeg",
    provider: "cartesia"
  };
}

export async function synthesizeSpeech(text: string): Promise<SpeechSynthesisResult> {
  try {
    const cartesia = await synthesizeCartesiaSpeech(text);
    if (cartesia.audioBase64) return cartesia;
  } catch (error) {
    console.warn(`Cartesia TTS failed; falling back to MiniMax: ${error instanceof Error ? error.message : String(error)}`);
  }
  const minimax = await synthesizeMiniMaxSpeech(text);
  return minimax.audioBase64
    ? { ...minimax, mimeType: "audio/mpeg", provider: "minimax" }
    : {};
}

export async function searchMoss(query: string, vin: string): Promise<MossSearchResult[]> {
  const pid = process.env.MOSS_PROJECT_ID;
  const key = process.env.MOSS_PROJECT_KEY;
  const catalogIndex = process.env.MOSS_CATALOG_INDEX;
  const imagesIndex = process.env.MOSS_IMAGES_INDEX;
  if (!pid || !key || !catalogIndex || !imagesIndex || process.env.VOX_PROVIDER_MODE === "mock") {
    return searchMossFallback(query, vin);
  }

  try {
    const client = await getLoadedMossClient(pid, key, catalogIndex, imagesIndex);
    const filter = { field: "car_id", condition: { $eq: vin } };
    const [catalog, images] = await Promise.all([
      client.query(catalogIndex, query, { topK: 3, filter }),
      client.query(imagesIndex, query, { topK: 8, filter })
    ]);
    return [
      ...images.docs.map((doc) => ({
        id: doc.id,
        label: doc.metadata?.role ?? doc.metadata?.image_id ?? "image",
        text: doc.text,
        score: doc.score,
        docType: "image" as const,
        metadata: doc.metadata
      })),
      ...catalog.docs.map((doc) => ({
        id: doc.id,
        label: doc.metadata?.title ?? "catalog",
        text: doc.text,
        score: doc.score,
        docType: "catalog" as const,
        metadata: doc.metadata
      }))
    ];
  } catch (error) {
    console.warn(`Moss search failed; using local fallback: ${error instanceof Error ? error.message : String(error)}`);
    return searchMossFallback(query, vin);
  }
}

export async function warmMossIndexes(): Promise<void> {
  const pid = process.env.MOSS_PROJECT_ID;
  const key = process.env.MOSS_PROJECT_KEY;
  const catalogIndex = process.env.MOSS_CATALOG_INDEX;
  const imagesIndex = process.env.MOSS_IMAGES_INDEX;
  if (!pid || !key || !catalogIndex || !imagesIndex || process.env.VOX_PROVIDER_MODE === "mock") return;
  await getLoadedMossClient(pid, key, catalogIndex, imagesIndex);
}

export async function searchMossFallback(query: string, vin: string): Promise<MossSearchResult[]> {
  const [car, images] = await Promise.all([getCar(vin), listImages(vin)]);
  const words = query.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
  const scoreText = (text: string) => words.reduce((score, word) => score + (text.toLowerCase().includes(word) ? 1 : 0), 0);
  const out: MossSearchResult[] = [];
  if (car) {
    out.push({
      id: car.vin,
      label: `${car.year} ${car.make} ${car.model}`,
      text: car.description,
      score: scoreText(car.description),
      docType: "catalog",
      metadata: { car_id: car.vin, doc_type: "car" }
    });
  }
  for (const image of images) {
    const text = `${image.caption} ${image.visibleFeatures.join(", ")} ${(image.likelyQuestions ?? []).join(", ")} ${image.role}`;
    out.push({
      id: image.id,
      label: image.role,
      text,
      score: scoreText(text),
      docType: "image",
      metadata: { car_id: image.vin, image_id: image.id, role: image.role, url: image.url, doc_type: "image" }
    });
  }
  return out
    .filter((item) => (item.score ?? 0) > 0 || item.docType === "catalog")
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 8);
}

async function getLoadedMossClient(
  pid: string,
  key: string,
  catalogIndex: string,
  imagesIndex: string
): Promise<MossClientLike> {
  const signature = `${pid}:${catalogIndex}:${imagesIndex}`;
  if (mossClientCache?.signature === signature) {
    await mossClientCache.loaded;
    return mossClientCache.client;
  }

  const { MossClient } = await import("@moss-dev/moss");
  const client = new MossClient(pid, key) as MossClientLike;
  const cacheBase = path.join(mossCachePath, pid);
  const loaded = Promise.all([
    client.loadIndex(catalogIndex, { cachePath: path.join(cacheBase, catalogIndex) }),
    client.loadIndex(imagesIndex, { cachePath: path.join(cacheBase, imagesIndex) })
  ]).then(() => undefined);

  const nextCache: MossClientCache = { signature, client, loaded };
  mossClientCache = nextCache;
  try {
    await loaded;
  } catch (error) {
    if (mossClientCache === nextCache) mossClientCache = undefined;
    throw error;
  }
  return client;
}

function mockReply(user: string): string {
  const low = user.toLowerCase();
  if (low.includes("trunk") || low.includes("cargo")) return "I’ll show the closest uploaded cargo or detail view available for this M4.";
  if (low.includes("interior") || low.includes("seat")) return "Here’s the cabin view; focus on the driver cockpit, front seats, and center console.";
  if (low.includes("wheel") || low.includes("brake")) return "I’ll pull up the wheel detail so you can inspect the tire and brake area closely.";
  return "This BMW M4 demo is set up as a visual specialist workspace; ask for a view and I’ll switch images.";
}

async function callMiniMaxJson(input: {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs?: number;
}): Promise<unknown> {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY is required for the specialist planner.");
  const resp = await fetch("https://api.minimax.io/v1/text/chatcompletion_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "MiniMax-Text-01",
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user }
      ],
      max_tokens: input.maxTokens,
      temperature: 0.1
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 14_000)
  });
  if (!resp.ok) throw new Error(`MiniMax planner error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const base = data.base_resp ?? {};
  if (base.status_code) throw new Error(`MiniMax planner error ${base.status_code}: ${base.status_msg}`);
  const text = String(data.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("MiniMax planner returned an empty response.");
  return parseJsonObject(text);
}

function parseJsonObject(text: string): unknown {
  const direct = tryParseJson(text);
  if (direct !== undefined) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = tryParseJson(text.slice(start, end + 1));
    if (sliced !== undefined) return sliced;
  }
  throw new Error(`MiniMax planner did not return valid JSON: ${text}`);
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function compactReply(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function streamMiniMaxChat(input: {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<ReadableStream<string>> {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new Error("MINIMAX_API_KEY is required for streamMiniMaxChat.");
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);
  const resp = await fetch("https://api.minimax.io/v1/text/chatcompletion_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.MINIMAX_MODEL || "MiniMax-Text-01",
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user }
      ],
      max_tokens: input.maxTokens ?? 220,
      temperature: 0.3,
      stream: true
    }),
    signal: controller.signal
  });
  if (!resp.ok || !resp.body) {
    clearTimeout(timeoutHandle);
    throw new Error(`MiniMax stream error ${resp.status}: ${await resp.text().catch(() => "")}`);
  }

  const decoder = new TextDecoder();
  const reader = resp.body.getReader();
  let buffer = "";

  return new ReadableStream<string>({
    async pull(controllerOut) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            clearTimeout(timeoutHandle);
            controllerOut.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let newlineIdx: number;
          let enqueued = false;
          while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
                base_resp?: { status_code?: number; status_msg?: string };
              };
              if (json.base_resp?.status_code) {
                clearTimeout(timeoutHandle);
                controllerOut.error(new Error(`MiniMax stream ${json.base_resp.status_code}: ${json.base_resp.status_msg ?? ""}`));
                return;
              }
              const delta = json.choices?.[0]?.delta?.content;
              if (delta) {
                controllerOut.enqueue(delta);
                enqueued = true;
              }
              if (json.choices?.[0]?.finish_reason) {
                clearTimeout(timeoutHandle);
                controllerOut.close();
                return;
              }
            } catch {
              // ignore malformed SSE chunks
            }
          }
          if (enqueued) return;
        }
      } catch (error) {
        clearTimeout(timeoutHandle);
        controllerOut.error(error);
      }
    },
    cancel(reason) {
      clearTimeout(timeoutHandle);
      controller.abort();
      void reader.cancel(reason).catch(() => {});
    }
  });
}
