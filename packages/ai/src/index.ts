import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Car, CarImage, ImageRole, CanvasAction, ViewState } from "@vox/core";
import { CarImageSchema, CarSchema, DEFAULT_VIN, ImageRoleSchema, carFactSheet, CanvasActionSchema } from "@vox/core";
import { z } from "zod";

const root = findRepoRoot(process.cwd());
const catalogPath = path.join(root, "data", "catalog.json");
const imagesPath = path.join(root, "data", "images.json");
const uploadRoot = path.join(root, "public", "uploads", "cars");
const mossCachePath = path.join(root, ".moss-cache");

let catalogCache: Promise<Car[]> | undefined;
let imagesCache: Promise<CarImage[]> | undefined;
let catalogMtimeMs = 0; // mtime of the catalog file backing catalogCache

function invalidateDataCaches(): void {
  catalogCache = undefined;
  imagesCache = undefined;
  catalogMtimeMs = 0;
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

const SpecialistTurnPlanSchema = z.object({
  intent: z.enum(["greeting", "spec_fact", "visual", "clarify", "objection"]),
  needsImage: z.boolean(),
  selectedImageId: z.string().nullable().optional(),
  askedClarifyingQuestion: z.boolean().optional().default(false),
  reply: z.string().min(1)
});

const UnsiloedImageAnalysisSchema = z.object({
  role: ImageRoleSchema.optional().default("unknown"),
  viewpoint: z.string().optional().default(""),
  caption: z.string().optional().default("Uploaded vehicle image analyzed by Unsiloed."),
  visibleFeatures: z.array(z.string()).optional().default([]),
  conditionNotes: z.array(z.string()).optional().default([]),
  searchTags: z.array(z.string()).optional().default([]),
  likelyQuestions: z.array(z.string()).optional().default([]),
  confidence: z.number().min(0).max(1).optional().default(0.75)
});

type UnsiloedImageAnalysis = z.infer<typeof UnsiloedImageAnalysisSchema>;

export type SpecialistTurnPlan = {
  intent: "greeting" | "spec_fact" | "visual" | "clarify" | "objection";
  needsImage: boolean;
  selectedImageId: string | null;
  askedClarifyingQuestion: boolean;
  reply: string;
};

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
  // mtime-aware: another process (the API marking a car sold) may have rewritten
  // catalog.json. Re-read when the file is newer than what we cached so the voice
  // agent picks up sold status on its next turn without a restart.
  let freshMtime = catalogMtimeMs;
  try {
    freshMtime = (await stat(catalogPath)).mtimeMs;
  } catch {
    // stat failed — fall through and let readFile surface the error
  }
  if (catalogCache && freshMtime > catalogMtimeMs) {
    catalogCache = undefined;
  }
  if (!catalogCache) {
    catalogMtimeMs = freshMtime;
    catalogCache = readFile(catalogPath, "utf8")
      .then((raw) => CarSchema.array().parse(JSON.parse(raw)))
      .catch((error) => {
        catalogCache = undefined;
        catalogMtimeMs = 0;
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

export async function writeCatalog(cars: Car[]): Promise<void> {
  await writeFile(catalogPath, JSON.stringify(CarSchema.array().parse(cars), null, 2) + "\n");
  invalidateDataCaches();
}

// Flip a car's availability to "sold" and persist. Returns the updated car (or
// undefined if the vin isn't found). The file write + cache invalidation make
// the change visible to the voice agent (separate process) on its next turn.
export async function markCarSold(vin: string): Promise<Car | undefined> {
  const cars = await readCatalog();
  let updated: Car | undefined;
  const next = cars.map((car) => {
    if (car.vin !== vin) return car;
    updated = { ...car, availability: "sold" as const };
    return updated;
  });
  if (!updated) return undefined;
  await writeCatalog(next);
  return updated;
}

// Set of vins that are currently sold — used to keep sold cars out of cross-sell.
async function soldVins(): Promise<Set<string>> {
  const cars = await readCatalog();
  return new Set(cars.filter((car) => car.availability === "sold").map((car) => car.vin));
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
    status: "pending",
    boxes: [],
    zoomTargets: {},
    pairs: []
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
  const unsiloed = await analyzeImageWithUnsiloed(current).catch((error) => {
    console.warn(`Unsiloed image ingestion failed; using fallback: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  });
  const nextRole = unsiloed?.role ?? role;
  const nextFeatures = unsiloed?.visibleFeatures.length ? unsiloed.visibleFeatures : featuresForRole(nextRole);
  const next: CarImage = {
    ...current,
    role: nextRole,
    viewpoint: unsiloed?.viewpoint || current.viewpoint || `${nextRole.replaceAll("_", " ")} uploaded image`,
    caption: unsiloed?.caption || await analyzeImageFallback(current, nextRole),
    visibleFeatures: nextFeatures,
    conditionNotes: unsiloed?.conditionNotes.length ? unsiloed.conditionNotes : current.conditionNotes ?? [],
    searchTags: [...new Set([
      ...(current.searchTags ?? []),
      ...(unsiloed?.searchTags ?? []),
      nextRole.replaceAll("_", " "),
      ...nextFeatures
    ])],
    likelyQuestions: unsiloed?.likelyQuestions.length ? unsiloed.likelyQuestions : current.likelyQuestions ?? [],
    confidence: unsiloed?.confidence ?? (nextRole === "unknown" ? 0.35 : 0.72),
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
    status: "pending",
    boxes: [],
    zoomTargets: {},
    pairs: []
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

function mimeForImagePath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  throw new Error(`Unsiloed image ingestion supports JPEG, PNG, and TIFF uploads; got ${ext || "unknown extension"}.`);
}

function imagePathFromUrl(url: string): string {
  const relativePath = url.replace(/^\//, "");
  const filePath = path.join(root, "public", relativePath);
  if (!filePath.startsWith(path.join(root, "public"))) {
    throw new Error(`Refusing to read image outside public directory: ${url}`);
  }
  return filePath;
}

function unsiloedVehiclePrompt(): string {
  return [
    "Analyze this dealership vehicle image for a voice-first car sales specialist.",
    "Return only a JSON object with keys: role, viewpoint, caption, visibleFeatures, conditionNotes, searchTags, likelyQuestions, confidence.",
    "role must be one of: exterior_front, exterior_rear, interior_front, interior_rear, dashboard, trunk, wheel, detail, unknown.",
    "visibleFeatures should name concrete visible objects or attributes. conditionNotes should mention only visible condition evidence, or be empty.",
    "likelyQuestions should be short shopper questions this image can answer. confidence must be from 0 to 1."
  ].join(" ");
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Unsiloed response did not include a JSON object.");
  return JSON.parse(source.slice(start, end + 1));
}

function collectUnsiloedText(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectUnsiloedText);

  const record = value as Record<string, unknown>;
  const ownText = ["content", "markdown", "html", "text"]
    .map((key) => record[key])
    .filter((item): item is string => typeof item === "string");
  return [
    ...ownText,
    ...Object.entries(record)
      .filter(([key]) => !["content", "markdown", "html", "text"].includes(key))
      .flatMap(([, item]) => collectUnsiloedText(item))
  ];
}

async function pollUnsiloedParseJob(jobId: string, apiKey: string): Promise<unknown> {
  const timeoutMs = Number(process.env.UNSILOED_PARSE_TIMEOUT_MS ?? 45_000);
  const intervalMs = Number(process.env.UNSILOED_PARSE_POLL_MS ?? 2_500);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`https://prod.visionapi.unsiloed.ai/parse/${jobId}`, {
      headers: {
        accept: "application/json",
        "api-key": apiKey
      }
    });
    if (!response.ok) {
      throw new Error(`Unsiloed parse status ${response.status}: ${await response.text()}`);
    }
    const data = await response.json() as { status?: string; message?: string };
    const status = String(data.status ?? "").toLowerCase();
    if (status === "succeeded" || status === "success" || status === "completed") return data;
    if (status === "failed" || status === "error") {
      throw new Error(`Unsiloed parse failed: ${data.message ?? "unknown error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Unsiloed parse timed out after ${timeoutMs}ms.`);
}

async function analyzeImageWithUnsiloed(image: CarImage): Promise<UnsiloedImageAnalysis | undefined> {
  if (process.env.VOX_ENABLE_UNSILOED_INGEST !== "1") return undefined;
  const apiKey = process.env.UNSILOED_API_KEY;
  if (!apiKey) throw new Error("UNSILOED_API_KEY is required when VOX_ENABLE_UNSILOED_INGEST=1.");

  const filePath = imagePathFromUrl(image.url);
  const mime = mimeForImagePath(filePath);
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mime }), path.basename(filePath));
  form.set("segment_filter", "all");
  form.set("output_fields", JSON.stringify({ html: false, markdown: true, ocr: false, image: false, content: true, bbox: false, confidence: true }));
  form.set("segment_analysis", JSON.stringify({
    Picture: {
      html: "VLM",
      markdown: "VLM",
      model_id: process.env.UNSILOED_IMAGE_MODEL || "nova",
      vlm: unsiloedVehiclePrompt()
    },
    Text: {
      html: "VLM",
      markdown: "VLM",
      model_id: process.env.UNSILOED_IMAGE_MODEL || "nova",
      vlm: unsiloedVehiclePrompt()
    }
  }));

  const response = await fetch("https://prod.visionapi.unsiloed.ai/parse", {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": apiKey
    },
    body: form
  });
  if (!response.ok) {
    throw new Error(`Unsiloed parse ${response.status}: ${await response.text()}`);
  }
  const created = await response.json() as { job_id?: string };
  if (!created.job_id) throw new Error("Unsiloed parse response did not include job_id.");

  const result = await pollUnsiloedParseJob(created.job_id, apiKey);
  const text = collectUnsiloedText(result).join("\n").trim();
  if (!text) throw new Error("Unsiloed parse result did not include text content.");
  return UnsiloedImageAnalysisSchema.parse(extractJsonObject(text));
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

export type SmsSendResult = {
  sid: string;
  status: string;
  provider: "linq";
};

export type BookingParseResult = {
  date: Date;
  hour24: number;
  minutes: number;
  normalizedLabel: string;
};

export type BookingDetails = {
  date?: Date;
  time?: { hour24: number; minutes: number };
  phone?: string;
  parsedBooking?: BookingParseResult;
};

const SPOKEN_DIGIT: Record<string, string> = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9"
};

const SPOKEN_NUMBER: Record<string, number> = {
  one: 1,
  first: 1,
  two: 2,
  second: 2,
  three: 3,
  third: 3,
  four: 4,
  fourth: 4,
  five: 5,
  fifth: 5,
  six: 6,
  sixth: 6,
  seven: 7,
  seventh: 7,
  eight: 8,
  eighth: 8,
  nine: 9,
  ninth: 9,
  ten: 10,
  tenth: 10,
  eleven: 11,
  eleventh: 11,
  twelve: 12,
  twelfth: 12,
  thirteen: 13,
  thirteenth: 13,
  fourteen: 14,
  fourteenth: 14,
  fifteen: 15,
  fifteenth: 15,
  sixteen: 16,
  sixteenth: 16,
  seventeen: 17,
  seventeenth: 17,
  eighteen: 18,
  eighteenth: 18,
  nineteen: 19,
  nineteenth: 19,
  twenty: 20,
  twentieth: 20,
  "twenty one": 21,
  "twenty first": 21,
  "twenty two": 22,
  "twenty second": 22,
  "twenty three": 23,
  "twenty third": 23,
  "twenty four": 24,
  "twenty fourth": 24,
  "twenty five": 25,
  "twenty fifth": 25,
  "twenty six": 26,
  "twenty sixth": 26,
  "twenty seven": 27,
  "twenty seventh": 27,
  "twenty eight": 28,
  "twenty eighth": 28,
  "twenty nine": 29,
  "twenty ninth": 29,
  thirty: 30,
  thirtieth: 30,
  "thirty one": 31,
  "thirty first": 31
};

const SPOKEN_YEAR: Record<string, number> = {
  "twenty twenty six": 2026,
  "twenty twenty seven": 2027,
  "twenty twenty eight": 2028,
  "twenty twenty nine": 2029,
  "twenty thirty": 2030
};

const BOOKING_MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
};

const SPOKEN_NUMBER_PATTERN = Object.keys(SPOKEN_NUMBER)
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replaceAll(" ", "\\s+"))
  .join("|");

const SPOKEN_YEAR_PATTERN = Object.keys(SPOKEN_YEAR)
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replaceAll(" ", "\\s+"))
  .join("|");

function spokenNumberValue(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  return SPOKEN_NUMBER[raw.toLowerCase().replace(/\s+/g, " ").trim()];
}

function spokenYearValue(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  return SPOKEN_YEAR[raw.toLowerCase().replace(/\s+/g, " ").trim()];
}

function extractSpokenDigits(text: string): string {
  const tokens = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const runs: string[] = [];
  let current = "";
  for (const token of tokens) {
    const digit = SPOKEN_DIGIT[token];
    if (digit !== undefined) {
      current += digit;
      continue;
    }
    if (current.length >= 10) runs.push(current);
    current = "";
  }
  if (current.length >= 10) runs.push(current);
  for (const run of runs) {
    if (run.length === 10) return run;
    if (run.length === 11 && run.startsWith("1")) return run;
    if (run.length > 10) return run.slice(0, 10);
  }
  return "";
}

export function extractPhoneNumber(text: string): string | undefined {
  const match = text.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  const digits = match ? match[0].replace(/\D/g, "") : extractSpokenDigits(text);
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

export function looksLikeBookingRequest(message: string): boolean {
  return /\b(book|booking|schedule|appointment|test drive|drive it|come see)\b/.test(message);
}

export function bookingPrompt(): string {
  return "I can help set up a test drive. Tell me the day and a time between 11 AM and 3 PM.";
}

function formatBookingDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  });
}

function formatBookingTime(time: { hour24: number; minutes: number }): string {
  return new Date(2026, 0, 1, time.hour24, time.minutes).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  });
}

function parseBookingTimeToken(raw: string): { hour24: number; minutes: number } | undefined {
  const match = raw.trim().toLowerCase().match(/^(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(am|pm)?$/);
  const hourToken = match?.[1];
  if (!hourToken) return undefined;
  const hour = /^\d+$/.test(hourToken) ? Number(hourToken) : spokenNumberValue(hourToken);
  const minutes = Number(match?.[2] ?? "0");
  const meridiem = match?.[3];
  if (hour === undefined || !Number.isFinite(minutes) || minutes < 0 || minutes > 59) return undefined;
  if (meridiem === "am") return { hour24: hour === 12 ? 0 : hour, minutes };
  if (meridiem === "pm") return { hour24: hour === 12 ? 12 : hour + 12, minutes };
  return hour <= 23 ? { hour24: hour, minutes } : undefined;
}

function extractBookingTime(message: string): { hour24: number; minutes: number } | undefined {
  const lower = message.toLowerCase();
  const timeWord = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
  const explicit = [...lower.matchAll(new RegExp(`\\b(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)|(?:${timeWord})\\s*(?:am|pm))\\b`, "g"))];
  const explicitToken = explicit.at(-1)?.[1];
  if (explicitToken) return parseBookingTimeToken(explicitToken);
  const contextual = [...lower.matchAll(new RegExp(`\\b(?:at|for|@)\\s*(\\d{1,2}(?::\\d{2})?|${timeWord})\\b`, "g"))];
  const contextualToken = contextual.at(-1)?.[1];
  return contextualToken ? parseBookingTimeToken(contextualToken) : undefined;
}

function parseBookingDate(message: string): Date | undefined {
  const base = new Date();
  const today = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const weekdayIndex: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6
  };
  const weekday = message.toLowerCase().match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekday) {
    const target = weekdayIndex[weekday[2] as keyof typeof weekdayIndex];
    if (target === undefined) return undefined;
    let daysAhead = target - today.getDay();
    if (daysAhead <= 0) daysAhead += 7;
    const candidate = new Date(today);
    candidate.setDate(today.getDate() + daysAhead);
    return candidate;
  }

  const monthNameDate = message.toLowerCase().match(new RegExp(`\\b(january|february|march|april|may|june|july|august|september|october|november|december)\\s+(\\d{1,2}|${SPOKEN_NUMBER_PATTERN})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}|${SPOKEN_YEAR_PATTERN}))?\\b`));
  if (monthNameDate) {
    const monthName = monthNameDate[1] as keyof typeof BOOKING_MONTH_INDEX;
    const month = BOOKING_MONTH_INDEX[monthName];
    const dayToken = monthNameDate[2];
    if (month !== undefined && dayToken) {
      const day = /^\d+$/.test(dayToken) ? Number(dayToken) : spokenNumberValue(dayToken);
      const year = monthNameDate[3]
        ? (/^\d+$/.test(monthNameDate[3]) ? Number(monthNameDate[3]) : spokenYearValue(monthNameDate[3]))
        : today.getFullYear();
      if (year === undefined) return undefined;
      if (day !== undefined) return new Date(year, month, day);
    }
  }

  const numeric = message.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numeric) {
    const month = Number(numeric[1]) - 1;
    const day = Number(numeric[2]);
    const rawYear = numeric[3];
    let year = rawYear ? Number(rawYear) : today.getFullYear();
    if (rawYear && rawYear.length === 2) year += 2000;
    return new Date(year, month, day);
  }

  const tokens = message.toLowerCase().match(/[a-z]+/g) ?? [];
  const runs: string[] = [];
  let current = "";
  for (const token of tokens) {
    const digit = SPOKEN_DIGIT[token];
    if (digit !== undefined) {
      current += digit;
      continue;
    }
    if (current) runs.push(current);
    current = "";
  }
  if (current) runs.push(current);
  for (const digits of runs.filter((run) => run.length === 4 || run.length === 8)) {
    const month = Number(digits.slice(0, 2)) - 1;
    const day = Number(digits.slice(2, 4));
    const yearDigits = digits.slice(4, 8);
    const year = yearDigits.length === 4 ? Number(yearDigits) : today.getFullYear();
    const candidate = new Date(year, month, day);
    if (candidate.getMonth() === month && candidate.getDate() === day) return candidate;
  }

  return undefined;
}

export function parseBookingRequest(message: string): BookingParseResult | undefined {
  const time = extractBookingTime(message);
  const date = parseBookingDate(message);
  if (!time || !date) return undefined;
  const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), time.hour24, time.minutes);
  return {
    date: candidate,
    hour24: time.hour24,
    minutes: time.minutes,
    normalizedLabel: candidate.toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    })
  };
}

export function parseBookingDetails(message: string): BookingDetails {
  const time = extractBookingTime(message);
  const date = parseBookingDate(message);
  const parsedBooking = parseBookingRequest(message);
  return {
    date,
    time,
    phone: extractPhoneNumber(message),
    parsedBooking
  };
}

export function bookingFollowupPrompt(details: BookingDetails): string {
  if (details.time && (details.time.hour24 < 11 || details.time.hour24 > 15)) {
    const dateText = details.date ? ` on ${formatBookingDate(details.date)}` : "";
    return `Test drives are available between 11 AM and 3 PM. What time in that window works${dateText}?`;
  }
  if (details.date && !details.time) {
    return `What time between 11 AM and 3 PM works for ${formatBookingDate(details.date)}?`;
  }
  if (details.time && !details.date) {
    return `What day works for ${formatBookingTime(details.time)}?`;
  }
  if (details.parsedBooking && !details.phone) {
    return `I can do ${details.parsedBooking.normalizedLabel}. What number should I text the confirmation to?`;
  }
  return bookingPrompt();
}

export function buildVehicleSmsBody(input: { car: Pick<Car, "year" | "make" | "model">; reply: string }): string {
  return `${input.car.year} ${input.car.make} ${input.car.model}: ${input.reply}`.slice(0, 320);
}

export async function sendLinqSms(input: { to: string; body: string }): Promise<SmsSendResult> {
  const apiKey = process.env.LINQ_API_KEY;
  const from = process.env.LINQ_FROM_NUMBER;
  const preferredService = process.env.LINQ_PREFERRED_SERVICE;
  if (!apiKey || !from) throw new Error("Linq is not configured. Set LINQ_API_KEY and LINQ_FROM_NUMBER.");
  const message: Record<string, unknown> = {
    parts: [{ type: "text", value: input.body }],
    idempotency_key: randomUUID()
  };
  if (preferredService) message.preferred_service = preferredService;
  const response = await fetch("https://api.linqapp.com/api/partner/v3/chats", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ from, to: [input.to], message })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Linq SMS failed (${response.status}): ${detail || response.statusText}`);
  }
  const data = await response.json() as { message?: { id?: string; delivery_status?: string } };
  return { sid: data.message?.id ?? "", status: data.message?.delivery_status ?? "queued", provider: "linq" };
}

export async function bookTestDriveAndNotify(input: {
  car: Pick<Car, "year" | "make" | "model">;
  phone?: string;
  parsedBooking: BookingParseResult;
}): Promise<{ reply: string; slot: string; sms?: SmsSendResult }> {
  const slot = input.parsedBooking.normalizedLabel;
  if (!input.phone) {
    return { slot, reply: `Perfect — you're booked for ${slot}.` };
  }
  const sms = await sendLinqSms({
    to: input.phone,
    body: buildVehicleSmsBody({
      car: input.car,
      reply: `Your requested test drive is ${slot}. Reply here and I can help with the next step.`
    })
  });
  return {
    slot,
    sms,
    reply: `Perfect — I have you down for ${slot}, and I texted the details to ${input.phone}.`
  };
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
      "The car object includes a full factSheet with the trim, price, mileage, condition, engine, horsepower, torque, transmission, 0-60, top speed, fuel economy, colors, VIN, stock number, warranty, packages, and options — answer price, mileage, and spec questions directly and accurately from it.",
      "PRICING POLICY: when they ask about price, explain MSRP vs our price if both are in the factSheet. If pricing guidance includes a discount/rebate/incentive range, mention it as a range for an in-person discussion, not a guaranteed out-the-door number. Then lightly suggest going over it during a test drive or visit. Never invent rebates, payments, taxes, fees, or ranges that are not in the factSheet.",
      "Keep it short and natural: usually one or two sentences, like talking to a buddy.",
      "Never oversell, never hype, never stack adjectives or push the sale. If a fact is not in the car data or image description, say so casually instead of inventing it.",
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
        trim: input.car.trim,
        body: input.car.body,
        color: input.car.color,
        price: input.car.price,
        mileage: input.car.mileage,
        availability: input.car.availability,
        factSheet: carFactSheet(input.car)
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

/**
 * Intent-aware, salesperson-style turn planner for the web chat.
 *
 * Unlike chooseMiniMaxSpecialistImage (which is framed as "pick an image"),
 * this classifies the shopper's turn first, answers spec/fact questions
 * directly from the car fact sheet WITHOUT changing the image, only requests an
 * image for genuinely visual turns, and may ask a single clarifying question
 * when a request is ambiguous. One LLM round-trip per turn. The caller treats
 * needsImage / selectedImageId as authoritative.
 */
export async function planSpecialistTurn(input: {
  car: Car;
  images: CarImage[];
  message: string;
  currentImageId?: string;
  history?: { role: "user" | "assistant"; text: string }[];
}): Promise<SpecialistTurnPlan> {
  if (process.env.VOX_PROVIDER_MODE === "mock") {
    const low = input.message.toLowerCase();
    const wantsVisual = /(show|see|look|view|pull up|picture|photo|image|wheel|seat|interior|trunk|dashboard|exterior|color|rim|paint)/.test(low);
    const candidate = wantsVisual ? input.images[0] : undefined;
    return {
      intent: wantsVisual ? "visual" : "spec_fact",
      needsImage: Boolean(candidate),
      selectedImageId: candidate?.id ?? null,
      askedClarifyingQuestion: false,
      reply: mockReply(input.message)
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

  const recentTurns = (input.history ?? []).slice(-8).map((turn) => ({ role: turn.role, text: turn.text }));

  const parsed = SpecialistTurnPlanSchema.parse(await callMiniMaxJson({
    system: [
      "You are Vox, a warm, sharp BMW sales specialist standing next to this car with a shopper. You sell by being genuinely helpful, never pushy — talk like a knowledgeable friend, not a brochure.",
      "Each turn, first silently classify the shopper's latest message into exactly one intent:",
      "greeting — hello, thanks, or small talk with no car question.",
      "spec_fact — asks a value or judgment answerable from the car factSheet: price, mileage, 0-60, horsepower, torque, mpg, transmission, drivetrain, VIN, stock number, warranty, packages, options, or things like 'is it fast' or 'good on gas'.",
      "visual — wants to SEE something, or a yes/no about a VISIBLE physical part best settled by a photo (wheels, seats, paint, curb rash, stitching, body lines).",
      "clarify — you genuinely cannot answer well without guessing because the request or what they're referring to is unclear.",
      "objection — price pushback, comparison shopping, hesitation, or a buying signal (test drive, financing, 'can I see it this weekend').",
      "Then set needsImage true ONLY when intent is visual, or when intent is objection and a specific photo clearly helps. For greeting, spec_fact, and clarify, needsImage is false.",
      "If needsImage is true, choose the single best id from IMAGE_OPTIONS by reasoning semantically over each option's role and description (not substring matching). Shopper slang: 'stick' = gear selector/shifter, 'rims' = wheel, 'screen' or 'nav' = dashboard. If no option genuinely matches, selectedImageId is null and say so casually. If needsImage is false, selectedImageId is null.",
      "GROUNDING: answer price, mileage, and every spec directly and exactly from car.factSheet. Never invent or estimate specs, prices, packages, options, or features. If a fact isn't in the fact sheet, say so casually instead of guessing.",
      "PRICING POLICY: for direct price questions, lead with MSRP vs our price when both are listed: 'MSRP is X; our price is Y.' If car.factSheet includes pricing guidance, add that applicable discounts, rebates, and incentives can bring the discussion into that stated range, while final numbers depend on eligibility and structure. Close with one natural test-drive/visit handoff if it fits. Do not give a guaranteed out-the-door price, monthly payment, tax/fee estimate, or any range not present in car.factSheet.",
      "VISIBLE-FEATURE HONESTY: for a yes/no about something in a photo, if the chosen image's description says the feature is absent, answer no — never yes.",
      "STYLE: keep replies to one or two sentences — spoken, natural, like a friend. This text may be read aloud, so write plain prose only: NO markdown, NO bullet lists, NO URLs, and NEVER any image tags or placeholders like [IMAGE:...] or [image_id]. Never dump a spec list; even for 'tell me about it', give a two-sentence highlight and then ask what they care about. Answer only what they asked plus at most one extra relevant spec. Vary your openers and usually skip them. Never hype, stack adjectives, or pressure.",
      "IMAGE/REPLY CONSISTENCY: only say you're showing, pulling up, or pointing at something when needsImage is true AND you selected an image. If needsImage is false, do not claim to show anything.",
      "BE A SALESPERSON — ASK BACK: when the shopper shares a use-case or goal ('daily driver', 'for the track', 'first car'), pushes back on price, or sends a buying signal, acknowledge it and end with ONE short, helpful question, and set askedClarifyingQuestion true. When the request is genuinely ambiguous, classify clarify, ask ONE clarifying question, give no answer yet, and set askedClarifyingQuestion true.",
      "ANTI-OVER-QUESTIONING (hard rules): never ask something the fact sheet can answer — just answer it. If recentTurns shows your previous reply already ended with a question the shopper has not answered, do NOT ask again — make a reasonable assumption, answer, and offer the alternative in one short clause. One question maximum per turn; at most one question mark in the reply.",
      "Use recentTurns for context and to resolve references like 'the other one', 'that', or 'show me that instead'.",
      "EXAMPLES (shopper -> decision): 'what's the 0-60?' -> spec_fact, needsImage false, answer the number. | 'show me the wheels' -> visual, needsImage true, pick the wheel image. | 'I'm looking for a daily driver' -> clarify, needsImage false, ask what matters most: comfort, economy, or performance? | 'tell me about it' -> spec_fact, needsImage false, two-sentence highlight then ask what they care about most. | 'that's a bit steep' -> objection, needsImage false, empathize and ask what number they had in mind. | 'can I see it this weekend?' -> objection, needsImage false, confirm warmly and ask what day works.",
      "Return STRICT JSON ONLY, no prose or markdown around it, with exactly these keys: intent (one of greeting, spec_fact, visual, clarify, objection), needsImage (boolean), selectedImageId (a string id from IMAGE_OPTIONS or null), askedClarifyingQuestion (boolean), reply (string)."
    ].join(" "),
    user: JSON.stringify({
      shopperMessage: input.message,
      currentImageId: input.currentImageId ?? null,
      recentTurns,
      car: {
        year: input.car.year,
        make: input.car.make,
        model: input.car.model,
        trim: input.car.trim,
        body: input.car.body,
        color: input.car.color,
        price: input.car.price,
        mileage: input.car.mileage,
        availability: input.car.availability,
        factSheet: carFactSheet(input.car)
      },
      imageOptions
    }),
    maxTokens: 320,
    timeoutMs: 14_000
  }));

  const needsImage = parsed.needsImage;
  const selectedImageId = needsImage && parsed.selectedImageId && allowedIds.has(parsed.selectedImageId)
    ? parsed.selectedImageId
    : null;
  const reply = sanitizeReply(parsed.reply);
  return {
    intent: parsed.intent,
    needsImage,
    selectedImageId,
    // Trust a trailing question over the model's self-report of the flag.
    askedClarifyingQuestion: (parsed.askedClarifyingQuestion ?? false) || /\?\s*$/.test(reply),
    reply
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

  // Flagship @inferedge/moss (Rust+WASM, on-device embeddings) — same client API
  // as the old @moss-dev/moss, so loadIndex/query are drop-in. It nests its own
  // cache under <cachePath>/<indexName>/, so we pass a single per-project base
  // dir (kept separate from the old SDK's cache to avoid format collisions).
  const { MossClient } = await import("@inferedge/moss");
  const client = new MossClient(pid, key) as MossClientLike;
  const cacheBase = path.join(mossCachePath, "inferedge", pid);
  const loaded = Promise.all([
    client.loadIndex(catalogIndex, { cachePath: cacheBase }),
    client.loadIndex(imagesIndex, { cachePath: cacheBase })
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
  if (low.includes("price") || low.includes("msrp") || low.includes("how much")) return "MSRP is $92,595, and our price is $89,900. With applicable discounts and rebates, we can talk through the $87,000-$89,900 range in person on a test drive.";
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

// Strip anything that shouldn't appear in a spoken/chat reply: image
// placeholders the model sometimes hallucinates, markdown image/link syntax,
// and stray URLs. The canvas shows images; the reply text never should.
function sanitizeReply(text: string): string {
  return compactReply(
    text
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, "")            // markdown images/links
      .replace(/\[\s*image[^\]]*\]/gi, "")               // [IMAGE: ...] / [image_id ...]
      .replace(/https?:\/\/\S+/g, "")                    // bare URLs
      .replace(/\s+([.,!?:;])/g, "$1")                   // tidy space before punctuation
  );
}

export async function streamMiniMaxChat(input: {
  system: string;
  user: string;
  model?: string;
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
      model: input.model || process.env.MINIMAX_MODEL || "MiniMax-Text-01",
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

// ── STT cleanup (Cerebras) ──────────────────────────────────────────────────
//
// Layer a fast LLM on top of Deepgram to repair recognition errors before the
// transcript is sent to the reply model and shown in the chat. Runs Cerebras
// gpt-oss-120b with modest reasoning — a short correction lands in ~150–350ms,
// dominated by reasoning + network RTT, not the (tiny) output. Note: the public
// Cerebras tier only serves gpt-oss-120b / zai-glm-4.7 (Llama needs a dedicated
// endpoint), so gpt-oss-120b is the default.
//
// Hard rules for the voice critical path:
//  - bounded: a short AbortController timeout; on ANY failure/timeout/mock-mode
//    we return the RAW transcript so a slow or down Cerebras never blocks or
//    breaks a turn.
//  - conservative: temperature 0 + a prompt that only fixes obvious ASR errors
//    and never rephrases, answers, or changes meaning.
//  - cheap: skipped for trivially short turns (greetings) where there is nothing
//    to fix and the round trip isn't worth the latency.

const CEREBRAS_CHAT_URL = "https://api.cerebras.ai/v1/chat/completions";

// ── Cerebras API-key "revolver" ─────────────────────────────────────────────
// Multiple keys multiply the per-key requests-per-minute limit. cerebrasKeys()
// gathers every configured key; cerebrasChatCompletion() round-robins the START
// key per call (spreading load across turns) and, on ANY failure for a key
// (429 rate-limit, 5xx, bad key, network/timeout), rotates to the next key
// before giving up. Add keys as CEREBRAS_API_KEY, CEREBRAS_API_KEY_2, _3, …
// (or a comma-separated CEREBRAS_API_KEYS) — they're discovered automatically.
function cerebrasKeys(): string[] {
  const keys: string[] = [];
  const push = (v: string | undefined) => {
    const t = v?.trim();
    if (t && !keys.includes(t)) keys.push(t);
  };
  for (const part of (process.env.CEREBRAS_API_KEYS ?? "").split(",")) push(part);
  push(process.env.CEREBRAS_API_KEY);
  for (let n = 2; n <= 12; n++) push(process.env[`CEREBRAS_API_KEY_${n}`]);
  return keys;
}

let cerebrasKeyCursor = 0;

async function cerebrasChatCompletion(
  body: Record<string, unknown>,
  opts: { timeoutMs: number }
): Promise<{ choices?: Array<{ message?: { content?: string } }> }> {
  const keys = cerebrasKeys();
  if (keys.length === 0) throw new Error("No Cerebras API key configured (set CEREBRAS_API_KEY).");

  // Advance once per call so consecutive turns start on different keys.
  const start = cerebrasKeyCursor;
  cerebrasKeyCursor = (cerebrasKeyCursor + 1) % keys.length;
  const payload = JSON.stringify(body);

  let lastErr: Error | undefined;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(start + i) % keys.length]!;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const resp = await fetch(CEREBRAS_CHAT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: payload,
        signal: controller.signal
      });
      if (!resp.ok) {
        // 429 / 5xx / bad key — rotate to the next chamber of the revolver.
        lastErr = new Error(`Cerebras ${resp.status}: ${await resp.text().catch(() => "")}`);
        continue;
      }
      return (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    } catch (err) {
      // Timeout / network / abort — try the next key too.
      lastErr = err instanceof Error ? err : new Error(String(err));
      continue;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
  throw lastErr ?? new Error("Cerebras request failed on all keys.");
}

export async function correctTranscript(input: {
  transcript: string;
  carContext?: string;
  model?: string;
  timeoutMs?: number;
}): Promise<string> {
  const raw = input.transcript.trim();
  // No key, mock mode, or too short to be worth a round trip / correction risk.
  if (
    cerebrasKeys().length === 0 ||
    process.env.VOX_PROVIDER_MODE === "mock" ||
    raw.length < 8 ||
    raw.split(/\s+/).length < 2
  ) {
    return raw;
  }

  try {
    const system = [
      "You repair raw speech-to-text transcripts from a live BMW M4 sales conversation.",
      "Return the FULL transcript with ONLY obvious speech-recognition errors fixed: misheard model names, trims, options, colors, and numbers — e.g. 'em four'/'i4' -> 'M4', 'ex drive' -> 'xDrive', 'step tronic' -> 'Steptronic', 'brooklyn gray' -> 'Brooklyn Grey', spelled-out prices or mileage into digits.",
      "Keep EVERY other word, including the question itself. Never drop, add, summarize, answer, reorder, or rephrase. If nothing is clearly misrecognized, return the transcript verbatim.",
      "Output ONLY the corrected transcript text — no quotes, labels, preamble, or explanation.",
      input.carContext ? `The car being discussed: ${input.carContext}.` : ""
    ]
      .filter(Boolean)
      .join(" ");

    const json = await cerebrasChatCompletion({
      model: input.model || process.env.CEREBRAS_MODEL || "gpt-oss-120b",
      messages: [
        { role: "system", content: system },
        { role: "user", content: raw }
      ],
      temperature: 0,
      // gpt-oss is a reasoning model; "low" was prone to dropping words,
      // "medium" stays faithful. Give the cap headroom so reasoning never
      // starves the (short) corrected output — truncation yields empty
      // content and we'd fall back to raw.
      reasoning_effort: "medium",
      max_completion_tokens: 400,
      stream: false
    }, { timeoutMs: input.timeoutMs ?? 600 });

    const corrected = json.choices?.[0]?.message?.content
      ?.replace(/^["'`\s]+|["'`\s]+$/g, "")
      .trim();
    if (!corrected) return raw;
    // Guardrails: reject rewrites that balloon OR gut the transcript — those are
    // the model rephrasing / answering / dropping the question, not correcting
    // recognition. The raw transcript is safer than a mangled one.
    const rawWords = raw.split(/\s+/).length;
    const outWords = corrected.split(/\s+/).length;
    if (corrected.length > raw.length * 2 + 40) return raw;
    if (rawWords >= 4 && outWords < rawWords * 0.6) return raw;
    return corrected;
  } catch {
    // timeout / abort / network / all keys exhausted — never block the turn
    return raw;
  }
}

/**
 * Fast JSON call on Cerebras (OpenAI-compatible). Cerebras inference is ~10–20×
 * MiniMax-Text-01 throughput, so the single-brain decideTurn call returns in
 * ~1s instead of 5–6s. Uses low reasoning effort for speed; relies on the
 * prompt + parseJsonObject for JSON (no response_format, to stay compatible).
 * Throws on any failure so the caller can fall back to MiniMax.
 */
async function callCerebrasJson(input: {
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<unknown> {
  if (cerebrasKeys().length === 0) throw new Error("CEREBRAS_API_KEY is required for callCerebrasJson.");
  const json = await cerebrasChatCompletion({
    model: process.env.CEREBRAS_DECISION_MODEL || process.env.CEREBRAS_MODEL || "gpt-oss-120b",
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user }
    ],
    temperature: 0.2,
    reasoning_effort: "low",
    max_completion_tokens: input.maxTokens ?? 700,
    stream: false
  }, { timeoutMs: input.timeoutMs ?? 8_000 });
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Cerebras returned an empty response.");
  return parseJsonObject(text);
}

// ── Canvas brain (Phase 4) ─────────────────────────────────────────────────────

const DecideCanvasResponseSchema = z.object({
  actions: z.array(z.unknown())
});

/**
 * LLM canvas decider — async, slow-lane (1–3s budget).
 *
 * Asks MiniMax to choose 0–3 CanvasActions from the tool catalog given the
 * current shopper message, the live ViewState, and per-image metadata. Returns
 * [] on any parse failure so the heuristic first-paint stays up. Never throws.
 *
 * VOX_PROVIDER_MODE=mock → returns [] immediately (no API call).
 */
export async function decideCanvasActions(input: {
  message: string;
  viewState: ViewState;
  car: Car;
  images: CarImage[];
  recentTurns?: { role: string; text: string }[];
}): Promise<CanvasAction[]> {
  // Mock mode: no-op. The heuristic first-paint already painted the screen.
  if (process.env.VOX_PROVIDER_MODE === "mock") return [];

  const allowedImageIds = new Set(input.images.map((img) => img.id));

  // Compact image option list for the prompt — id, role, caption, visible features.
  const imageOptions = input.images.map((img) => ({
    id: img.id,
    role: img.role,
    caption: img.caption,
    visibleFeatures: img.visibleFeatures.slice(0, 6)
  }));

  // Compact current-view summary so the LLM knows what's already on screen.
  const currentViewSummary = {
    layout: input.viewState.layout,
    itemCount: input.viewState.items.length,
    items: input.viewState.items.map((item) => {
      if (item.kind === "image") return { kind: "image", imageId: item.imageId };
      if (item.kind === "generated") return { kind: "generated", status: item.status };
      return { kind: item.kind };
    })
  };

  const systemPrompt = [
    "You are the canvas brain for Vox, a BMW M4 sales specialist agent.",
    "Your job: given the shopper's latest message and the current canvas state, choose the MINIMAL set of canvas actions (0–3) that best illustrates what the shopper wants to see.",
    "Return STRICT JSON only: { \"actions\": [ ...action objects... ] }",
    "Each action must conform to one of these schemas (pick op from: showImage, showImages, zoom, compare, annotate, focusCar — NOT generate):",
    "  showImage: { op: \"showImage\", carId: string, imageId: string }",
    "  showImages: { op: \"showImages\", carId?: string, imageIds?: string[], filter?: { role?: string }, limit?: number (max 4) }",
    "  zoom: { op: \"zoom\", itemRef: { carId: string, imageId: string } | { index: number }, region: [x,y,w,h] | \"named-target\" }",
    "  compare: { op: \"compare\", itemRefs: [itemRefA, itemRefB] }",
    "  annotate: { op: \"annotate\", itemRef: itemRef, marks: [{ box: [x,y,w,h], label: string }] }",
    "  focusCar: { op: \"focusCar\", carId: string }",
    "RULES:",
    "- imageId values MUST come from IMAGE_OPTIONS.id. Never invent ids.",
    "- carId is always the image's vin field (use it from IMAGE_OPTIONS).",
    "- If no canvas change is needed (e.g. greeting, pure spec question), return { \"actions\": [] }.",
    "- Keep the list to 0–3 actions. More is not better.",
    "- Choose actions that feel natural and helpful — if the shopper asks to see wheels, showImage the wheel photo.",
    "- For compare/multi-view requests, prefer showImages or compare with explicit imageIds.",
    "- Do not change the canvas unnecessarily if the current view already answers the question.",
    `car: { make: "${input.car.make}", model: "${input.car.model}", vin: "${input.car.vin}" }`
  ].join(" ");

  const userPayload = JSON.stringify({
    shopperMessage: input.message,
    currentCanvas: currentViewSummary,
    recentTurns: (input.recentTurns ?? []).slice(-4),
    imageOptions
  });

  let raw: unknown;
  try {
    raw = await callMiniMaxJson({
      system: systemPrompt,
      user: userPayload,
      maxTokens: 256,
      timeoutMs: 10_000
    });
  } catch (error) {
    // LLM call failed — heuristic first-paint is already on screen, stay silent.
    console.warn(
      `decideCanvasActions: LLM call failed, returning [] — ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }

  // Parse outer envelope.
  const envelope = DecideCanvasResponseSchema.safeParse(raw);
  if (!envelope.success) {
    console.warn(`decideCanvasActions: unexpected response shape, returning []`);
    return [];
  }

  // Validate each action individually; drop any that fail schema validation.
  const validated: CanvasAction[] = [];
  for (const candidate of envelope.data.actions) {
    const parsed = CanvasActionSchema.safeParse(candidate);
    if (!parsed.success) {
      console.warn(`decideCanvasActions: dropped invalid action — ${parsed.error.message}`);
      continue;
    }
    const action = parsed.data;
    // Drop any action that references imageIds not in the allowed set.
    if (action.op === "showImage") {
      if (!allowedImageIds.has(action.imageId)) {
        console.warn(`decideCanvasActions: dropped showImage with unknown imageId ${action.imageId}`);
        continue;
      }
    }
    if (action.op === "showImages" && action.imageIds) {
      const filtered = action.imageIds.filter((id) => allowedImageIds.has(id));
      if (filtered.length === 0) {
        console.warn(`decideCanvasActions: dropped showImages — all imageIds unknown`);
        continue;
      }
      validated.push({ ...action, imageIds: filtered } as CanvasAction);
      continue;
    }
    if (action.op === "zoom") {
      // Validate the itemRef image exists if it's a carId+imageId ref.
      if ("imageId" in action.itemRef && !allowedImageIds.has(action.itemRef.imageId)) {
        console.warn(`decideCanvasActions: dropped zoom with unknown imageId ${action.itemRef.imageId}`);
        continue;
      }
    }
    if (action.op === "compare") {
      // Validate both refs.
      const [refA, refB] = action.itemRefs;
      const aOk = "index" in refA || allowedImageIds.has((refA as { imageId: string }).imageId);
      const bOk = "index" in refB || allowedImageIds.has((refB as { imageId: string }).imageId);
      if (!aOk || !bOk) {
        console.warn(`decideCanvasActions: dropped compare with unknown imageId`);
        continue;
      }
    }
    validated.push(action);
    if (validated.length >= 3) break; // cap at 3
  }

  return validated;
}

const DecideTurnResponseSchema = z.object({
  reply: z.string().min(1),
  actions: z.array(z.unknown()).optional().default([])
});

// Valid role strings for the ImageRole enum (sourced from @vox/core ImageRoleSchema).
const VALID_IMAGE_ROLES = new Set([
  "exterior_front", "exterior_rear", "interior_front", "interior_rear",
  "dashboard", "trunk", "wheel", "detail", "unknown"
]);

/**
 * Pre-repair a raw candidate action object before schema parsing so that small
 * model errors don't silently drop a whole action.
 *
 * Repairs applied (with console.warn):
 *  - showImages: filter.role invalid (e.g. "all" / "mixed") → strip the role so
 *    the filter still renders (by imageIds or unfiltered); clamp limit to ≤ 4.
 *  - showImage / showImages: carId wrong / missing → look up the image by
 *    imageId and use its real vin (the model frequently emits a wrong carId).
 */
function repairCandidateAction(
  candidate: unknown,
  images: CarImage[]
): unknown {
  if (typeof candidate !== "object" || candidate === null) return candidate;
  const c = candidate as Record<string, unknown>;
  const imageById = new Map(images.map((img) => [img.id, img]));

  // Repair showImage — fix carId from real image vin.
  if (c["op"] === "showImage") {
    const imageId = typeof c["imageId"] === "string" ? c["imageId"] : undefined;
    if (imageId) {
      const img = imageById.get(imageId);
      if (img && c["carId"] !== img.vin) {
        console.warn(`validateCanvasActions: repaired showImage carId "${String(c["carId"])}" → "${img.vin}" for imageId ${imageId}`);
        return { ...c, carId: img.vin };
      }
    }
    return c;
  }

  // Repair showImages — fix bad filter.role and clamp limit.
  if (c["op"] === "showImages") {
    let repaired = { ...c };
    // Fix carId from first known imageId if present.
    const imageIds = Array.isArray(repaired["imageIds"]) ? repaired["imageIds"] as string[] : [];
    if (imageIds.length > 0) {
      const firstImg = imageById.get(imageIds[0] ?? "");
      if (firstImg && repaired["carId"] !== firstImg.vin) {
        console.warn(`validateCanvasActions: repaired showImages carId "${String(repaired["carId"])}" → "${firstImg.vin}"`);
        repaired = { ...repaired, carId: firstImg.vin };
      }
    }
    // Fix invalid filter.role.
    if (
      repaired["filter"] !== null &&
      typeof repaired["filter"] === "object" &&
      !Array.isArray(repaired["filter"])
    ) {
      const filter = repaired["filter"] as Record<string, unknown>;
      if (filter["role"] !== undefined && !VALID_IMAGE_ROLES.has(String(filter["role"]))) {
        console.warn(`validateCanvasActions: stripped invalid showImages filter.role "${String(filter["role"])}"`);
        // Remove role key; keep other filter fields (carId, feature, tags).
        const { role: _dropped, ...restFilter } = filter;
        void _dropped;
        repaired = { ...repaired, filter: Object.keys(restFilter).length > 0 ? restFilter : undefined };
      }
    }
    // Clamp limit to 4.
    if (typeof repaired["limit"] === "number" && repaired["limit"] > 4) {
      console.warn(`validateCanvasActions: clamped showImages limit ${repaired["limit"]} → 4`);
      repaired = { ...repaired, limit: 4 };
    }
    return repaired;
  }

  return c;
}

/**
 * Validate raw candidate canvas actions: repair repairable issues (bad role,
 * wrong carId, over-limit), drop any that still fail schema or reference unknown
 * image ids, then cap at 3. Shared by the single-brain and streaming paths.
 */
function validateCanvasActions(
  candidates: unknown[],
  allowedImageIds: Set<string>,
  images: CarImage[] = []
): CanvasAction[] {
  const validated: CanvasAction[] = [];
  for (const rawCandidate of candidates) {
    const candidate = repairCandidateAction(rawCandidate, images);
    const parsed = CanvasActionSchema.safeParse(candidate);
    if (!parsed.success) {
      console.warn(`validateCanvasActions: dropped invalid action — ${parsed.error.message}`);
      continue;
    }
    const action = parsed.data;
    if (action.op === "showImage" && !allowedImageIds.has(action.imageId)) {
      console.warn(`validateCanvasActions: dropped showImage with unknown imageId ${action.imageId}`);
      continue;
    }
    if (action.op === "showImages" && action.imageIds) {
      const filtered = action.imageIds.filter((id) => allowedImageIds.has(id));
      if (filtered.length === 0) {
        console.warn(`validateCanvasActions: dropped showImages — all imageIds unknown`);
        continue;
      }
      validated.push({ ...action, imageIds: filtered } as CanvasAction);
      if (validated.length >= 3) break;
      continue;
    }
    if (action.op === "zoom" && "imageId" in action.itemRef && !allowedImageIds.has(action.itemRef.imageId)) {
      console.warn(`validateCanvasActions: dropped zoom with unknown imageId ${action.itemRef.imageId}`);
      continue;
    }
    if (action.op === "compare") {
      const [refA, refB] = action.itemRefs;
      const aOk = "index" in refA || allowedImageIds.has((refA as { imageId: string }).imageId);
      const bOk = "index" in refB || allowedImageIds.has((refB as { imageId: string }).imageId);
      if (!aOk || !bOk) {
        console.warn(`validateCanvasActions: dropped compare with unknown imageId`);
        continue;
      }
    }
    validated.push(action);
    if (validated.length >= 3) break;
  }
  return validated;
}

/**
 * SINGLE-BRAIN turn decider. One LLM call returns BOTH the spoken reply and the
 * canvas actions, so voice and canvas come from one decision and can never
 * disagree. Throws on hard failure (LLM/parse) so the caller can fall back to
 * the fast heuristic + a generic reply.
 */
export async function decideTurn(input: {
  message: string;
  viewState: ViewState;
  car: Car;
  images: CarImage[];
  recentTurns?: { role: string; text: string }[];
}): Promise<{ reply: string; actions: CanvasAction[] }> {
  if (process.env.VOX_PROVIDER_MODE === "mock") {
    return { reply: mockReply(input.message), actions: [] };
  }

  const allowedImageIds = new Set(input.images.map((img) => img.id));
  // Keep the payload SMALL — sending all 46 full captions + feature lists every
  // turn (~6k tokens) blew the Cerebras tokens-per-minute limit, forcing the
  // slow MiniMax fallback (the 6–7s lag). Role + a short caption is enough to
  // pick the right image.
  const imageOptions = input.images.map((img) => {
    // measures:true → image carries a precomputed MEASUREMENT region (a box whose
    // label includes a figure, e.g. the trunk's "15.5 cu ft"); annotate it for
    // size / "highlight it" asks. Only emitted when present, to keep payload small.
    const hasMeasure = (img.boxes ?? []).some((b) => /\d/.test(b.label));
    return {
      id: img.id,
      role: img.role,
      caption: img.caption.split(/\s+/).slice(0, 14).join(" "),
      ...(hasMeasure ? { measures: true } : {})
    };
  });
  const currentViewSummary = {
    layout: input.viewState.layout,
    items: input.viewState.items.map((item) =>
      item.kind === "image" ? { kind: "image", imageId: item.imageId } : { kind: item.kind }
    )
  };

  const systemPrompt = [
    `You are Vox, a warm, sharp BMW ${input.car.make} ${input.car.model} sales specialist talking with a customer by VOICE. You sell by being genuinely helpful, never pushy.`,
    'You control BOTH what you say and what a screen beside you shows. Return STRICT JSON only: { "reply": string, "actions": [...] }.',
    "reply = exactly what you say out loud: one or two short, natural spoken sentences, under ~30 words, conversational. No markdown, bullets, asterisks, or emojis — it is read aloud.",
    "ENDINGS — do NOT tack a sales hook onto every reply. Most turns should just ANSWER and STOP. Never use canned closers like 'want a closer look?', 'want to see it?', or 'want to check it out in person?'. Only suggest an in-person visit / test drive / coming in when the shopper shows REAL buying intent (pricing or financing talk, availability/scheduling, trade-in, clearly strong interest). Otherwise end cleanly, or — only SOMETIMES — ask ONE genuine, relevant follow-up question that moves things forward.",
    "actions = 0 to 3 canvas actions that put the right photo(s) on screen.",
    "EMPTY actions returns the screen to the main HERO shot of the whole car — the right move for a non-visual turn (pricing, financing, scheduling, 'is it worth it', general chat). Don't reach for a tangential photo when nothing visual is asked. If you're still discussing a specific photo already on screen, keep it up by re-emitting its showImage.",
    "CRITICAL — reply and actions describe the SAME image(s): your spoken words must describe exactly the photo your actions put on screen. If actions is empty, your words must match what is ALREADY on screen (see currentCanvas in the input) — never describe a part/area that is not in the image being shown (e.g. do not say 'the front, kidney grille' when the image on screen is the interior).",
    "READ INTENT LIKE A SHOWROOM PRO: shoppers rarely say 'show me X' — they reveal what matters through concerns, priorities, doubts, and offhand remarks. Whenever the latest message touches ANY physical part, area, capacity, or feature of the car, even indirectly — e.g. 'I'm a little heavy on trunk space' → the trunk/cargo; 'I'm tall' → front seats/headroom; 'how do the brakes hold up' → wheels/calipers; 'I've got a big family' → rear seats — proactively put the best-matching photo on screen AND make your reply speak to THAT topic. Map the shopper's words to IMAGE_OPTIONS by role and caption. Answer the topic they actually raised; never drift to an unrelated feature, and never leave the screen unchanged just because they didn't say the word 'show'.",
    "Decide by intent:",
    "- Greeting / small talk: reply warmly in one line; actions = []. Do not describe a photo.",
    "- A concern, priority, doubt, or offhand mention about a real part or capacity ('a little heavy on trunk space', 'is the back seat tight?', 'how's the rear visibility', 'I haul gear'): SHOW that area (showImage, or showImages for a broad area) AND address the concern honestly in your reply. This is the most common real request — do not leave the screen unchanged.",
    "- ABSTRACT number/fact with NO meaningful photo (mileage, 0-60, top speed, horsepower, torque, mpg, warranty, VIN, stock number, year): SAY the answer from the catalog AND write it on screen with a writeSpec action naming the field(s) — the screen TYPES it out like a notepad. Never type the value yourself; only name the field, the system fills the real number.",
    "- PRICING question (price, cost, 'how much', MSRP, sticker, 'what's the deal on price'): use writeSpec with the SINGLE field \"pricingMath\" — one card laying out MSRP, our price (under MSRP), the after-incentives range, and total possible savings. SAY the matching pitch: MSRP is the sticker, our price is already under it, after discounts/rebates/incentives we can get into that range — then invite them in for a test drive to lock in the real number. (A vague 'is it worth it' / 'justify the price' objection with NO number asked → no card, just talk; screen returns to the hero.) Numbers come from the catalog; never invent them.",
    "- DISCOUNTS question ('what discounts', 'any rebates', 'how low can you go', 'best you can do', 'can you come down'): do NOT show a card and do NOT quote exact discount figures. Warmly steer to an in-person visit — e.g. 'I'd love to walk you through all the discounts in person. Want to book a time to come in?' actions: [] (screen returns to the hero).",
    "- A PHOTOGRAPHABLE part or area, even when they ask 'what kind/type' (the engine, wheels, brakes, seats, trunk, dashboard, screen, exhaust): this is a SHOWROOM — SHOW the photo with showImage, don't writeSpec. E.g. 'what type of engine?' → showImage the engine-bay photo while you SAY the engine type. A part you can point a camera at is always a picture, not a text card.",
    "- They name a specific PART or control (gear shifter/selector, badge, button, vent, screen, stitching, caliper, mirror): show it AND auto-zoom to it. Emit TWO actions: a showImage of the best photo, then a zoom with itemRef {\"index\":0} and a region [x,y,w,h] (0..1) estimating where that part sits so it fills the view. The shopper should NOT have to ask to zoom — a specific part request auto-zooms. Example regions: center-console gear selector ≈ [0.26,0.45,0.42,0.45]; a badge ≈ [0.30,0.30,0.30,0.30]; a button cluster ≈ [0.30,0.55,0.40,0.35].",
    "- They want to SEE a whole area/view (the interior, the front, the seats, the dashboard): ONE showImage of the best photo, no zoom.",
    "- They want MULTIPLE views ('show me everything', 'all the X', 'the interior shots', 'a few angles'): use showImages (grid, up to 4). ONLY use a grid for explicitly plural/overview requests — never for a single part or a zoom.",
    "- 'Zoom in' / 'closer' / 'get closer' / 'look closer': ALWAYS a zoom action on the image CURRENTLY on screen via itemRef {\"index\":0}, NEVER a grid or a category switch. Use a tight centered region like [0.28,0.3,0.44,0.44], and describe what is actually in THAT image.",
    "- A zoom region must be tight enough to be an obvious close-up (w and h roughly 0.3–0.5), not the whole frame.",
    "- Ambiguous: ask ONE short question; actions = []; don't guess.",
    "Use ONLY the catalog facts and image data below — never invent specs, prices, features, or what is visible. If you lack a fact, say so casually.",
    "The shopper's words reach you as a live speech-to-text transcript, so expect occasional recognition errors — misheard model names, trims, or numbers (e.g. 'i4' vs 'M4'). Interpret charitably in the context of selling this M4; if a misheard word would change your answer and you're unsure, ask one quick clarifying question instead of guessing.",
    "Automotive shopper language: 'stick'/'shifter' = gear selector / center-console transmission selector; 'whole/entire car' = wide exterior overview.",
    "Action schemas (prefer showImage / showImages / zoom / compare):",
    '  showImage: { "op":"showImage", "carId":string, "imageId":string }',
    '  showImages: { "op":"showImages", "imageIds":string[], "filter":{"role":string}, "limit":number<=4 }',
    '  zoom: { "op":"zoom", "itemRef":{"carId":string,"imageId":string}, "region":[x,y,w,h] }  (x,y,w,h are 0..1)',
    '  compare: { "op":"compare", "itemRefs":[ref,ref] }',
    '  annotate: { "op":"annotate", "itemRef":{"index":0} }  (draws the image\'s KNOWN labeled regions ON the photo — e.g. the trunk\'s "15.5 cu ft" box. Do NOT pass coordinates or marks; the system fills them.)',
    '  writeSpec: { "op":"writeSpec", "fields":["<field>",...], "title":"<short heading>" }  (writes numbers/specs as text — no photo)',
    '  generate: { "op":"generate", "prompt":string, "baseRef":{"index":0} }  (Nano Banana — creates a NEW photoreal image by editing the photo at baseRef. Use ONLY after the shopper confirms — see GENERATE RULE.)',
    "ANNOTATE RULE: when the shopper asks to highlight / label / 'annotate it', OR asks the SIZE / measurement / capacity / 'how big is it' of an image flagged measures:true (e.g. the trunk), emit an annotate on the image ALREADY on screen (itemRef {\"index\":0}) — do NOT switch photos, do NOT pass coordinates. If that measures:true image isn't on screen yet, showImage it first, then annotate. Prefer annotate over writeSpec whenever a measures:true photo is the subject — the figure belongs ON the picture. Resolve 'it'/'that' against currentCanvas.",
    "SHOW FIRST, QUANTIFY WHEN ASKED: on a plain 'show me / I wanna see the trunk' (no size word), just showImage and keep the reply qualitative ('plenty of room for a coupe') — do NOT annotate and do NOT state the cubic-feet/measurement yet. Save the number AND the annotate for the explicit size follow-up ('how big is it', 'the size of it').",
    "GENERATE RULE (Nano Banana visualization): you can create a NEW photorealistic image by EDITING a real photo — for what our stock photos can't show (the trunk PACKED with luggage, the seats a DIFFERENT color, the car in a setting). This is a LAST resort for when the shopper is genuinely UNCONVINCED ('looks small', 'idk', 'hard to tell') or wants to CUSTOMIZE / 'what would it look like'. NEVER generate unprompted, on first mention, or twice for the same ask. FIRST you must OFFER it in your reply ('want me to show you what it'd look like packed?') with actions:[] — do NOT generate yet. ONLY emit a generate action on the turn the shopper CONFIRMS (yes / sure / go for it / do it). The generate prompt must describe the photoreal edit AND insist on keeping the car, paint, lighting, and background IDENTICAL — change only the requested thing. baseRef is usually {\"index\":0} (the photo on screen). On the generate turn, your reply is a brief 'On it — generating that now, give me a sec.'",
    "VALID writeSpec fields (abstract numbers only — never a photographable part like engine/wheels/seats; show those as a photo): mileage, pricingMath, price, msrp, incentiveRange, horsepower, torque, transmission, zeroToSixty, topSpeed, mpg, seating, doors, warranty, color, interiorColor, drivetrain, fuel, condition, vin, stockNumber, year.",
    "imageId MUST come from IMAGE_OPTIONS.id; carId is the image's vin.",
    "HARD RULE: if your reply says or implies you are showing, pulling up, highlighting, or zooming ANYTHING ('here's…', 'take a look', 'closer look', 'highlighted for you'), then actions MUST be non-empty with the matching action(s). Never narrate a visual with empty actions. If you are NOT changing the screen, do not use show/here/look language.",
    "Examples (use REAL ids from IMAGE_OPTIONS):",
    '  "show me the wheels" -> {"reply":"Here are the M wheels with the blue calipers.","actions":[{"op":"showImage","carId":"<vin>","imageId":"<a wheel id>"}]}',
    '  "I\'m a little heavy on trunk space" -> {"reply":"Totally fair — here\'s the trunk; it swallows more than you\'d think for a coupe.","actions":[{"op":"showImage","carId":"<vin>","imageId":"<a trunk id>"}]}',
    '  "what type of engine is it" -> {"reply":"It\'s a 3-liter M TwinPower twin-turbo inline-six — here\'s the engine bay.","actions":[{"op":"showImage","carId":"<vin>","imageId":"<the engine-bay id>"}]}',
    '  "show me the gear shifter" -> {"reply":"Here\'s the gear selector on the center console.","actions":[{"op":"showImage","carId":"<vin>","imageId":"<an interior id>"},{"op":"zoom","itemRef":{"index":0},"region":[0.26,0.45,0.42,0.45]}]}',
    '  "zoom in" -> {"reply":"Here\'s a closer look.","actions":[{"op":"zoom","itemRef":{"index":0},"region":[0.28,0.3,0.44,0.44]}]}',
    '  "how fast is it" -> {"reply":"Zero to sixty in about 3.8 seconds.","actions":[{"op":"writeSpec","fields":["zeroToSixty"],"title":"Acceleration"}]}',
    '  "how many miles on it" -> {"reply":"It\'s got twelve thousand four hundred miles.","actions":[{"op":"writeSpec","fields":["mileage"]}]}',
    '  "what\'s the price" -> {"reply":"Sticker\'s 92,595, but our price is already under that at 89,900 — and after incentives we can work into the high 80s. Easiest is to come drive it and we\'ll nail it down.","actions":[{"op":"writeSpec","fields":["pricingMath"],"title":"Pricing"}]}',
    '  "what do the discounts look like" -> {"reply":"There\'s real room there — I\'d love to walk you through all the discounts in person. Want to book a time to come in?","actions":[]}',
    '  "how big is the trunk" -> {"reply":"About fifteen and a half cubic feet — roomy for a coupe.","actions":[{"op":"showImage","carId":"<vin>","imageId":"<the trunk id, measures:true>"},{"op":"annotate","itemRef":{"index":0}}]}',
    '  (trunk already on screen) "how big is it?" / "annotate it" -> {"reply":"About fifteen and a half cubic feet — here it is on the photo.","actions":[{"op":"annotate","itemRef":{"index":0}}]}',
    '  (trunk on screen) "hmm that looks kinda small" -> OFFER, no generate yet: {"reply":"It fits more than it looks — want me to show it packed for a weekend trip?","actions":[]}',
    '  (after that offer) "yeah go for it" -> {"reply":"On it — generating that now, give me a sec.","actions":[{"op":"generate","prompt":"Edit this exact BMW M4 trunk photo to show it neatly packed for a weekend trip: two hard-shell carry-on suitcases in the cargo net, a rolled blanket, a duffel bag, and a small backpack. Keep the trunk, car, paint, lighting, and parking-lot background EXACTLY the same — only add realistic luggage that fits the space. Photorealistic.","baseRef":{"index":0}}]}',
    '  "can I get the seats in red?" -> OFFER first: {"reply":"Yeah — want me to mock up red seats so you can see it?","actions":[]}  (then on "yes") {"reply":"On it — one sec.","actions":[{"op":"generate","prompt":"Recolor ONLY the seat upholstery in this exact interior photo to rich red leather; keep the dashboard, trim, carbon fiber, lighting, and everything else identical. Photorealistic.","baseRef":{"index":0}}]}',
    '  "hey there" -> {"reply":"Hey! Want me to walk you through it?","actions":[]}',
    `Catalog: ${carFactSheet(input.car)}`
  ].join(" ");

  const userPayload = JSON.stringify({
    shopperMessage: input.message,
    currentCanvas: currentViewSummary,
    recentTurns: (input.recentTurns ?? []).slice(-4),
    imageOptions
  });

  // Prefer Cerebras (fast inference → ~1s) for the single-brain decision; fall
  // back to MiniMax JSON if Cerebras errors or has no key, so a turn never dies.
  let raw: unknown;
  if (process.env.CEREBRAS_API_KEY) {
    try {
      raw = await callCerebrasJson({ system: systemPrompt, user: userPayload, maxTokens: 700, timeoutMs: 8_000 });
    } catch (error) {
      console.warn(`decideTurn: Cerebras failed, falling back to MiniMax — ${error instanceof Error ? error.message : String(error)}`);
      raw = await callMiniMaxJson({ system: systemPrompt, user: userPayload, maxTokens: 320, timeoutMs: 12_000 });
    }
  } else {
    raw = await callMiniMaxJson({ system: systemPrompt, user: userPayload, maxTokens: 320, timeoutMs: 12_000 });
  }
  const parsed = DecideTurnResponseSchema.parse(raw);
  return {
    reply: compactReply(parsed.reply),
    actions: validateCanvasActions(parsed.actions, allowedImageIds, input.images)
  };
}

// ── Generative visualization (Nano Banana Pro / Gemini 3 Pro Image) ──────────
// Creates a NEW photorealistic image by EDITING a real car photo — for "what
// would it look like" moments our stock photos can't cover (the trunk packed
// with luggage, the seats recolored, the car in a setting). GATED in the agent
// prompt behind an explicit user confirmation; this function just does the call.
// Slow (often 10–30s) — callers run it on a non-blocking lane and show a
// shimmer placeholder. Throws on any failure (incl. 429 quota) so the caller can
// mark the generated item failed.
const GEMINI_IMAGE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export async function generateVisualization(input: {
  prompt: string;
  /** Real image to edit from, as a public URL (e.g. "/cars/BMW-M4/x.webp"). Omit for pure text-to-image. */
  baseImageUrl?: string;
  vin?: string;
  model?: string;
  timeoutMs?: number;
}): Promise<{ id: string; url: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is required for generateVisualization.");
  const model = input.model || process.env.GEMINI_IMAGE_MODEL || "gemini-3-pro-image-preview";

  const parts: Array<Record<string, unknown>> = [{ text: input.prompt }];
  if (input.baseImageUrl) {
    const filePath = path.join(root, "public", input.baseImageUrl.replace(/^\//, ""));
    const bytes = await readFile(filePath);
    const lower = input.baseImageUrl.toLowerCase();
    const mime = lower.endsWith(".png") ? "image/png" : lower.endsWith(".webp") ? "image/webp" : "image/jpeg";
    parts.push({ inline_data: { mime_type: mime, data: bytes.toString("base64") } });
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), input.timeoutMs ?? 60_000);
  try {
    const resp = await fetch(`${GEMINI_IMAGE_URL}/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
      }),
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new Error(`Gemini image error ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
    const json = (await resp.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { data?: string }; inline_data?: { data?: string } }> };
      }>;
    };
    const rparts = json.candidates?.[0]?.content?.parts ?? [];
    const imgPart = rparts.find((p) => p.inlineData?.data ?? p.inline_data?.data);
    const data = imgPart?.inlineData?.data ?? imgPart?.inline_data?.data;
    if (!data) throw new Error("Gemini returned no image data.");

    const vin = input.vin ?? DEFAULT_VIN;
    const id = `gen_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const dir = path.join(uploadRoot, vin);
    await mkdir(dir, { recursive: true });
    const relUrl = `/uploads/cars/${vin}/${id}.png`;
    await writeFile(path.join(root, "public", relUrl.replace(/^\//, "")), Buffer.from(data, "base64"));
    return { id, url: relUrl };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ── Two-call architecture: speech and canvas as INDEPENDENT Cerebras calls ────
// One call talks, one call drives the canvas. They run in parallel — each picks
// its own key via the revolver — so a canvas hiccup never affects speech and
// vice-versa. Replaces the fragile marker-split single call (streamDecideTurn).

/**
 * SPEECH call — returns ONLY the spoken reply (no canvas). Short, conversational,
 * voice-first. Throws on total Cerebras failure so the caller can fall back.
 */
export async function generateSpokenReply(input: {
  message: string;
  car: Car;
  recentTurns?: { role: string; text: string }[];
}): Promise<string> {
  if (process.env.VOX_PROVIDER_MODE === "mock") return mockReply(input.message);
  if (cerebrasKeys().length === 0) throw new Error("CEREBRAS_API_KEY is required for generateSpokenReply.");

  const system = [
    `You are Vox, a warm, sharp BMW ${input.car.make} ${input.car.model} sales specialist talking with a customer by VOICE. Sell by being genuinely helpful, never pushy — talk like a knowledgeable friend, not a brochure.`,
    "Bring real energy: upbeat, confident, a little enthusiastic — the tone of a top salesperson who clearly loves this car. Lead with the answer. Never robotic, never a list of specs.",
    "ENDINGS — do NOT tack a sales hook onto every reply. Most turns should just ANSWER and STOP. Never use canned closers like 'want a closer look?', 'want to see it?', or 'want to check it out in person?'. Only suggest an in-person visit / test drive / coming in when the shopper shows REAL buying intent — pricing or financing talk, availability or scheduling ('can I see it this weekend?'), trade-in, or clearly strong interest. Otherwise end cleanly, or — only SOMETIMES, not every turn — ask ONE genuine, relevant follow-up question that actually moves things forward (e.g. 'what'll you mainly use it for?').",
    "Reply in ONE or two short, punchy spoken sentences, UNDER ~30 words total. No markdown, bullets, asterisks, lists, or emojis — your words are read aloud by text-to-speech.",
    "A separate screen shows the photos, so when they ask to SEE something, say a quick natural line about it ('here's the rear — love those quad tips'), but never list more than one or two features and never read specs like a brochure.",
    "DON'T VOLUNTEER EXACT FIGURES on a 'show me / I wanna see' request. If they just want to SEE the trunk, describe it qualitatively ('plenty of room for a coupe', 'swallows more than you'd think') and STOP — do NOT state the cubic-feet/liters or any measurement, and do NOT add a 'closer look' hook. Save the specific number for when they EXPLICITLY ask about size/capacity ('how big is it', 'the size of it', 'how much fits'). Same for any part: show first, quantify only when asked.",
    "For spec/mileage questions, answer the one fact they asked, straight from the catalog. Don't enumerate everything.",
    "For a price question, use this shape when facts are available: MSRP is X, our price is Y, and after applicable discounts/rebates/incentives we can discuss the stated range in person. Mention a test drive or visit naturally. Never invent a discount range, payment, tax, fee, or out-the-door number.",
    "For a DISCOUNTS question ('what discounts', 'any rebates', 'how low can you go', 'best you can do'): do NOT quote exact discount figures — warmly steer to an in-person visit, e.g. 'I'd love to walk you through all the discounts in person. Want to book a time to come in?'",
    "Stay on the shopper's topic. Read indirect cues like a pro: a concern or offhand remark about a part or capacity ('a little heavy on trunk space', 'is the back tight', 'how are the brakes') is what they want to talk about — speak to THAT, honestly, and never drift to an unrelated feature.",
    "Use ONLY the catalog facts below; never invent specs, prices, or availability. If you lack a fact, say so casually.",
    input.car.availability === "sold"
      ? `IMPORTANT: This ${input.car.make} ${input.car.model} has just been SOLD and is no longer available. Do NOT try to sell it or talk it up. If the shopper asks about it, warmly tell them it just sold, then offer to show them something similar from inventory. Keep it brief and helpful.`
      : "This M4 is CURRENTLY AVAILABLE for sale. NEVER say it is sold, reserved, gone, or unavailable, and do NOT bring up or pitch any other vehicle unless the shopper explicitly asks for alternatives.",
    "The shopper's words are a live speech-to-text transcript and may contain recognition errors (e.g. 'i4'↔'M4', misheard trims/numbers); interpret charitably in the context of selling this M4.",
    `Catalog: ${carFactSheet(input.car)}`
  ].join(" ");

  const userPayload = JSON.stringify({
    shopperMessage: input.message,
    recentTurns: (input.recentTurns ?? []).slice(-4)
  });

  const json = await cerebrasChatCompletion({
    model: process.env.CEREBRAS_SPEECH_MODEL || process.env.CEREBRAS_MODEL || "gpt-oss-120b",
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPayload }
    ],
    temperature: 0.4,
    reasoning_effort: "low",
    max_completion_tokens: 300,
    stream: false
  }, { timeoutMs: 12_000 });

  const text = json.choices?.[0]?.message?.content?.trim() ?? "";
  console.log(`[speech] LLM reply → ${JSON.stringify(text)}`);
  return compactReply(text);
}

/**
 * CANVAS call — returns ONLY validated canvas actions (0–3). NEVER throws;
 * returns [] on any failure (a missing canvas is non-fatal). Defaults to a
 * SINGLE image; only grids on an explicit category / multi-view ask.
 */
export async function decideCanvas(input: {
  message: string;
  viewState: ViewState;
  car: Car;
  images: CarImage[];
  recentTurns?: { role: string; text: string }[];
}): Promise<CanvasAction[]> {
  if (process.env.VOX_PROVIDER_MODE === "mock") return [];
  if (cerebrasKeys().length === 0) return [];

  const allowedImageIds = new Set(input.images.map((img) => img.id));
  const imageOptions = input.images.map((img) => {
    // measures:true → this image carries a precomputed MEASUREMENT region (a box
    // whose label includes a figure, e.g. the trunk's "15.5 cu ft"). The model
    // annotates these for size / "highlight it" requests. Only emitted when
    // present, so the payload stays small.
    const hasMeasure = (img.boxes ?? []).some((b) => /\d/.test(b.label));
    return {
      id: img.id,
      role: img.role,
      caption: img.caption.split(/\s+/).slice(0, 12).join(" "),
      ...(hasMeasure ? { measures: true } : {})
    };
  });

  const system = [
    "You decide what the BMW M4 showroom SCREEN shows for the shopper's latest message. You do NOT speak — another system handles the talking.",
    'Return STRICT JSON only: { "actions": [ ...0 to 3 actions... ] }. No prose, no markdown.',
    "ACTION SCHEMAS:",
    '  showImage:  {"op":"showImage","carId":"<vin>","imageId":"<id from IMAGE_OPTIONS>"}',
    '  showImages: {"op":"showImages","filter":{"role":"<role>"},"limit":<1-4>}',
    '  zoom:       {"op":"zoom","itemRef":{"index":0},"region":[x,y,w,h]}   (x,y,w,h are 0..1 fractions of the current image)',
    '  annotate:   {"op":"annotate","itemRef":{"index":0}}   (draws the image\'s KNOWN labeled regions ON TOP of it — e.g. the trunk\'s "15.5 cu ft" box. Do NOT pass coordinates or marks; the system fills them from the image. itemRef {"index":0} = the image already on screen.)',
    '  compare:    {"op":"compare","itemRefs":[{"index":0},{"index":1}]}',
    '  writeSpec:  {"op":"writeSpec","fields":["<field>",...],"title":"<short heading>"}   (TYPES the fact(s) as text — NO photo)',
    "RULES (follow strictly):",
    "- ANNOTATE: when the shopper asks to highlight / label / mark / 'annotate it', OR asks the SIZE / measurement / capacity / 'how big is it' of an image flagged measures:true (e.g. the trunk), emit {\"op\":\"annotate\",\"itemRef\":{\"index\":0}} on the image ALREADY on screen. Do NOT switch to a different photo, and do NOT pass coordinates — the system draws the known measurement box. If that measures:true image is not yet on screen, emit showImage first, then annotate it. Prefer annotate over writeSpec whenever a measures:true photo is the subject — the number belongs ON the picture. Use currentCanvas (in the user message) to know what is at index 0.",
    "- READ INTENT LIKE A SHOWROOM PRO: shoppers rarely say 'show me X' — they reveal what matters through concerns, priorities, and offhand remarks. Whenever the message touches ANY physical part, area, or capacity, even indirectly ('I'm heavy on trunk space' → trunk; 'I'm tall' → front seats; 'how are the brakes' → wheels/calipers; 'big family' → rear seats), SHOW that area. Do not leave the screen unchanged just because they didn't say 'show'.",
    "- DEFAULT to a SINGLE photo: one showImage of the most relevant image. Use showImages (a grid) ONLY when the shopper clearly asks for a CATEGORY or MULTIPLE views — 'show me the interior', 'a few angles', 'all the exterior shots', 'everything'.",
    "- A specific PART/control named (gear shifter, badge, caliper, vent, screen, mirror): emit TWO actions — showImage the best photo, THEN zoom {\"index\":0} over that part. Regions: gear selector ≈ [0.26,0.45,0.42,0.45]; badge ≈ [0.30,0.30,0.30,0.30]; caliper ≈ [0.35,0.40,0.30,0.35]; mirror ≈ [0.05,0.25,0.25,0.35]; screen ≈ [0.20,0.15,0.55,0.40].",
    "- 'zoom in' / 'closer': zoom the CURRENT image, itemRef {\"index\":0}, region ≈ [0.28,0.30,0.44,0.44]. Do NOT switch image.",
    "- An ABSTRACT number/fact with NO meaningful photo ('how many miles', 'horsepower', '0-60', 'mpg', 'warranty', 'how fast'): use writeSpec with the relevant field(s) — WRITES the fact instead of a photo. Pick the closest field(s) from VALID writeSpec fields; for a broad 'what are the specs' use 3-4 key fields. NEVER type the value yourself — only name the field. Optionally add a short title.",
    "- A PRICING question (price, cost, 'how much', MSRP, sticker): use writeSpec with the SINGLE field \"pricingMath\" — one card showing MSRP → our price (under MSRP) → after-incentives range → total savings.",
    "- A DISCOUNTS question ('what discounts', 'any rebates', 'how low can you go', 'best you can do'): return { \"actions\": [] } — discounts are handled by inviting the shopper in person, NOT with a card. Screen returns to the hero.",
    "- BUT a photographable PART or area — the engine, wheels, brakes, seats, trunk, dashboard, screen, exhaust — is always a PHOTO: use showImage even when they ask 'what kind/type' (e.g. 'what type of engine' → showImage the engine-bay photo, NOT writeSpec). If you can point a camera at it, show it.",
    "- Greeting, chit-chat, financing, scheduling, or a vague 'is it worth it' objection with NO number asked: return { \"actions\": [] }. Empty actions returns the screen to the hero shot of the whole car — do NOT reach for a tangential photo when nothing visual is asked.",
    "- imageId MUST come from IMAGE_OPTIONS.id; carId is the image's vin. NEVER invent ids.",
    "VALID filter.role values: exterior_front, exterior_rear, interior_front, interior_rear, dashboard, trunk, wheel, detail.",
    "VALID writeSpec fields (abstract numbers only — never a photographable part like engine/wheels/seats; show those as a photo): mileage, pricingMath, price, msrp, incentiveRange, horsepower, torque, transmission, zeroToSixty, topSpeed, mpg, seating, doors, warranty, color, interiorColor, drivetrain, fuel, condition, vin, stockNumber, year.",
    "Map shopper words → role (include indirect cues): front → exterior_front; rear/back → exterior_rear; interior/seats/cabin/tall/headroom → interior_front; rear legroom/passengers/family/back seat → interior_rear; dashboard/cockpit/screen → dashboard; wheels/rims/brakes/calipers → wheel; trunk/cargo/luggage/storage/boot/hauling/space for stuff → trunk.",
    `IMAGE_OPTIONS: ${JSON.stringify(imageOptions)}`,
    "currentCanvas (in the user message) lists what is on screen RIGHT NOW — use it to resolve 'it' / 'that' / 'annotate it' / 'zoom in' against the image at index 0 (cross-reference its imageId in IMAGE_OPTIONS to see if it is measures:true).",
    `car vin: "${input.car.vin}"`
  ].join("\n");

  const userPayload = JSON.stringify({
    shopperMessage: input.message,
    currentCanvas: {
      layout: input.viewState.layout,
      items: input.viewState.items.map((it) =>
        it.kind === "image" ? { kind: "image", imageId: it.imageId } : { kind: it.kind }
      )
    },
    recentTurns: (input.recentTurns ?? []).slice(-3)
  });

  let json: { choices?: Array<{ message?: { content?: string } }> };
  try {
    json = await cerebrasChatCompletion({
      model: process.env.CEREBRAS_CANVAS_MODEL || process.env.CEREBRAS_MODEL || "gpt-oss-120b",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPayload }
      ],
      temperature: 0.2,
      reasoning_effort: "low",
      max_completion_tokens: 400,
      stream: false
    }, { timeoutMs: 10_000 });
  } catch (error) {
    console.warn(`decideCanvas: Cerebras failed, returning [] — ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }

  const text = json.choices?.[0]?.message?.content?.trim();
  console.log(`[canvas] LLM raw → ${text ? text.slice(0, 400) : "(empty)"}`);
  if (!text) return [];
  try {
    const raw = parseJsonObject(text);
    const envelope = DecideCanvasResponseSchema.safeParse(raw);
    if (!envelope.success) {
      console.warn("decideCanvas: unexpected response shape, returning []");
      return [];
    }
    const acts = validateCanvasActions(envelope.data.actions, allowedImageIds, input.images);
    console.log(`[canvas] parsed → ${acts.length} action(s): ${JSON.stringify(acts)}`);
    return acts;
  } catch (error) {
    console.warn(`decideCanvas: JSON parse failed, returning [] — ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

// ── Streaming decision core (new architecture) ────────────────────────────────
//
// ONE Cerebras streaming call per turn:
//   1. The model emits the spoken reply first — streamed token-by-token to TTS
//      for real-time voice.
//   2. After the reply the model emits a literal line "<<<CANVAS>>>".
//   3. After the marker the model emits the canvas JSON: {"actions":[...]}.
//
// The state machine in streamDecideTurn intercepts the marker and splits the
// stream: tokens before the marker flow to the caller's ReadableStream<string>
// (which feeds TTS); tokens after the marker are buffered and parsed into
// CanvasAction[] via the same validateCanvasActions path.
//
// Cerebras is the ONLY provider here. On any non-OK response (including 429),
// we THROW immediately so the agent can fall back to its instant heuristic —
// no MiniMax in this path.

const CANVAS_MARKER = "<<<CANVAS>>>";

/**
 * Strip obvious markdown that the model might emit despite prompt instructions.
 * Best-effort: the prompt already forbids it, but defensive stripping prevents
 * asterisks and heading hashes from being read aloud by TTS.
 */
function stripMarkdownToken(token: string): string {
  return token
    .replace(/\*+/g, "")           // bold/italic asterisks
    .replace(/`+/g, "")            // inline code backticks
    .replace(/^#{1,6}\s*/gm, "")   // heading hashes at line start
    .replace(/^\s*\d+\.\s+/gm, ""); // "1. " numbered list markers
}

/**
 * If the text ends with a non-empty PREFIX of CANVAS_MARKER, drop it. This is
 * the held-back suffix from processReplyDelta — if the stream dies mid-marker,
 * the leftover could be "<<<CAN" / "<<<CANVAS>>"; without this it would be
 * spoken aloud. Prose never legitimately ends with a marker prefix.
 */
function stripTrailingPartialMarker(text: string): string {
  for (let n = Math.min(CANVAS_MARKER.length - 1, text.length); n > 0; n -= 1) {
    if (text.endsWith(CANVAS_MARKER.slice(0, n))) return text.slice(0, text.length - n);
  }
  return text;
}

/** Final-flush cleanup for any leftover reply text at stream end. */
function flushReplyText(text: string): string {
  return stripMarkdownToken(stripTrailingPartialMarker(text));
}

/**
 * Build the system prompt for streamDecideTurn. Extracted so it's testable and
 * readable independently of the streaming machinery.
 */
function buildStreamDecidePrompt(input: {
  car: Car;
  images: CarImage[];
  viewState: ViewState;
}): string {
  // Compact image list: id, role, short caption only. Full captions blow token budget.
  const imageOptions = input.images.map((img) => ({
    id: img.id,
    role: img.role,
    caption: img.caption.split(/\s+/).slice(0, 14).join(" ")
  }));

  const currentViewSummary = {
    layout: input.viewState.layout,
    items: input.viewState.items.map((item) =>
      item.kind === "image" ? { kind: "image", imageId: item.imageId } : { kind: item.kind }
    )
  };

  return [
    // ── Persona ──────────────────────────────────────────────────────────────
    `You are Vox, a warm, sharp BMW ${input.car.make} ${input.car.model} sales specialist talking with a customer by VOICE. Sell by being genuinely helpful, never pushy — talk like a knowledgeable friend, never a brochure.`,

    // ── Output format (CRITICAL — the marker must appear exactly) ────────────
    "OUTPUT FORMAT — you MUST follow this exactly or the system breaks:",
    "Line 1+: your spoken reply (one or two short natural sentences, under ~30 words, conversational plain prose).",
    "Then a blank line, then exactly: <<<CANVAS>>>",
    "Then a blank line, then the JSON object: {\"actions\":[...]}",
    "No text before the reply. No text after the JSON. No markdown/bullets/asterisks/numbered lists anywhere — this is read aloud by text-to-speech.",
    "Example output format:",
    "Here are the front seats and center console — really clean stitching on these.",
    "",
    "<<<CANVAS>>>",
    "",
    "{\"actions\":[{\"op\":\"showImages\",\"filter\":{\"role\":\"interior_front\"},\"limit\":4}]}",

    // ── Canvas action schemas ─────────────────────────────────────────────────
    "CANVAS ACTION SCHEMAS (use ONLY these ops):",
    "  showImage: {\"op\":\"showImage\",\"carId\":\"<vin>\",\"imageId\":\"<id from IMAGE_OPTIONS>\"}",
    "  showImages: {\"op\":\"showImages\",\"filter\":{\"role\":\"<role>\"},\"limit\":<1-4>}  OR  {\"op\":\"showImages\",\"imageIds\":[\"<id>\",...]},\"limit\":<1-4>}",
    "  zoom: {\"op\":\"zoom\",\"itemRef\":{\"index\":0},\"region\":[x,y,w,h]}  (x,y,w,h are 0..1 fractions of image)",
    "  compare: {\"op\":\"compare\",\"itemRefs\":[{\"index\":0},{\"index\":1}]}",
    "  writeSpec: {\"op\":\"writeSpec\",\"fields\":[\"<field>\",...],\"title\":\"<short heading>\"}  (writes numbers/specs as TEXT — no photo)",
    "imageId MUST come from IMAGE_OPTIONS.id — never invent ids. carId is always the image's vin field.",
    "VALID writeSpec fields (abstract numbers only — never a photographable part like engine/wheels/seats; show those as a photo): mileage, pricingMath, price, msrp, incentiveRange, horsepower, torque, transmission, zeroToSixty, topSpeed, mpg, seating, doors, warranty, color, interiorColor, drivetrain, fuel, condition, vin, stockNumber, year. Never type the value — only name the field; the system fills the real number.",

    // ── Valid role strings ────────────────────────────────────────────────────
    "VALID filter.role strings (9 total — use exactly one of these, never \"all\" or \"mixed\"):",
    "exterior_front, exterior_rear, interior_front, interior_rear, dashboard, trunk, wheel, detail, unknown.",

    // ── Routing rules (P0 fixes) ──────────────────────────────────────────────
    "ROUTING RULES — follow these strictly:",

    // Rule 0: read implicit intent
    "0. READ INTENT LIKE A SHOWROOM PRO: shoppers rarely say 'show me X' — they reveal what matters through concerns, priorities, and offhand remarks. Whenever the message touches ANY physical part, area, or capacity, even indirectly ('I'm heavy on trunk space' → trunk; 'I'm tall' → front seats; 'how are the brakes' → wheels; 'big family' → rear seats), SHOW that area and make your reply speak to THAT topic. Don't leave the screen unchanged just because they didn't say 'show'.",

    // Rule 1: area/category → grid of up to 4
    "1. Bare AREA or CATEGORY ask (\"the interior\", \"the seats\", \"the front\", \"the dashboard\", \"the exterior\", \"the rear\"): use showImages with filter.role matching that area and limit 4. A 4-image GRID, NOT a single image. Map: interior/seats → interior_front; dashboard/cockpit → dashboard; front → exterior_front; rear/back → exterior_rear; wheels/rims → wheel; trunk/cargo → trunk.",

    // Rule 2: specific part → showImage + zoom
    "2. SPECIFIC PART or control named (gear shifter/selector, badge, button, vent, screen, stitching, caliper, mirror, emblem, knob): emit TWO actions — a showImage of the best photo THEN a zoom with itemRef {\"index\":0} and a region [x,y,w,h] (0..1) estimating where that part sits so it auto-zooms. Never make the shopper ask to zoom. Estimated regions: gear selector/shifter ≈ [0.26,0.45,0.42,0.45]; badge/emblem ≈ [0.30,0.30,0.30,0.30]; button cluster ≈ [0.30,0.55,0.40,0.35]; brake caliper ≈ [0.35,0.40,0.30,0.35]; side mirror ≈ [0.05,0.25,0.25,0.35]; interior screen ≈ [0.20,0.15,0.55,0.40].",

    // Rule 3: explicit plural/overview → grid
    "3. \"Show me everything\" / \"all the X\" / \"a few angles\" / \"show me four images\" / \"N pictures\": use showImages grid (limit 4).",

    // Rule 4: zoom command
    "4. \"Zoom in\" / \"closer\" / \"get closer\" / \"look closer\": ALWAYS zoom the CURRENT image via itemRef {\"index\":0}, region ≈ [0.28,0.3,0.44,0.44]. NEVER switch image or use a grid. Reply must describe what is actually in the current image.",

    // Rule 5: spec/number question → writeSpec; greeting → []
    "5. ABSTRACT number/fact with NO meaningful photo (\"how many miles\", \"horsepower\", \"0-60\", \"mpg\", \"warranty\"): SAY the answer AND use writeSpec with the relevant field(s) — the screen types the fact out like a notepad. Use 3-4 key fields for a broad \"what are the specs\". A PRICING question (price, cost, how much, MSRP, sticker) → writeSpec field \"pricingMath\" (one card: MSRP → our price → after-incentives range → savings) and pitch it: under MSRP, room after incentives, come drive it to finalize. A DISCOUNTS question (what discounts, any rebates, how low can you go) → NO card; warmly invite them in person ('I'd love to walk you through the discounts in person — want to book a time?') and return actions: []. BUT a photographable part (engine, wheels, brakes, seats, exhaust) is always a PHOTO — 'what type of engine' → showImage the engine bay, NOT writeSpec. A greeting, chit-chat, financing, scheduling, or vague 'is it worth it' turn with no number asked: actions: [] — returns the screen to the hero shot. Do not say \"here\" or \"look\", and do not reach for a tangential photo.",

    // ── Reply consistency ─────────────────────────────────────────────────────
    "REPLY CONSISTENCY: your spoken words must describe exactly the photo your actions put on screen. If actions is [], do not claim to show anything — describe specs or chat naturally. Never say \"here's\" or \"take a look\" when actions is empty.",

    // ── Grounding ─────────────────────────────────────────────────────────────
    "GROUNDING: answer specs, price, mileage exactly from Catalog below. Never invent facts. If a fact is missing, say so casually.",

    // ── Examples (compact) ────────────────────────────────────────────────────
    "EXAMPLES (shopper → reply + actions):",
    "\"show me the interior\" → reply: \"Here's the cabin — nice sport seats and the M-specific center console.\" + showImages filter.role interior_front limit 4",
    "\"I'm a little heavy on trunk space\" → reply: \"Totally fair — here's the trunk; it swallows more than you'd think for a coupe.\" + showImage (a trunk id)",
    "\"what type of engine is it\" → reply: \"A 3-liter M TwinPower twin-turbo inline-six — here's the engine bay.\" + showImage (the engine-bay id), NOT writeSpec",
    "\"show me the gear shifter\" → reply: \"Here's the gear selector on the center console.\" + showImage (best interior id) + zoom {index:0} [0.26,0.45,0.42,0.45]",
    "\"zoom in\" → reply: \"Closer look.\" + zoom {index:0} [0.28,0.3,0.44,0.44]",
    "\"show me everything\" → reply: \"Here's a full rundown of the M4.\" + showImages limit 4 (no filter)",
    "\"what's the 0-60?\" → reply: \"Zero to sixty in about 3.8 seconds flat.\" + writeSpec fields:[\"zeroToSixty\"] title:\"Acceleration\"",
    "\"how many miles?\" → reply: \"Twelve thousand four hundred on the odometer.\" + writeSpec fields:[\"mileage\"]",
    "\"hey there\" → reply: \"Hey! What do you want to see on this M4?\" + actions:[]",

    // ── Data ─────────────────────────────────────────────────────────────────
    `IMAGE_OPTIONS: ${JSON.stringify(imageOptions)}`,
    `CURRENT_CANVAS: ${JSON.stringify(currentViewSummary)}`,
    `Catalog: ${carFactSheet(input.car)}`
  ].join("\n");
}

/**
 * STREAMING decision core — ONE Cerebras call per turn.
 *
 * Returns immediately with:
 *   reply   — ReadableStream<string> that emits spoken reply tokens as they
 *             stream (stops at <<<CANVAS>>> marker). Tokens are markdown-stripped.
 *   actions — Promise<CanvasAction[]> that resolves after the stream ends with
 *             the validated canvas actions parsed from the tail. Resolves [] on
 *             any parse failure (a missing canvas is non-fatal).
 *
 * Throws on non-OK Cerebras response (including 429) — caller must handle fallback.
 * NO MiniMax in this path.
 */
export async function streamDecideTurn(input: {
  message: string;
  viewState: ViewState;
  car: Car;
  images: CarImage[];
  recentTurns?: { role: string; text: string }[];
}): Promise<{ reply: ReadableStream<string>; actions: Promise<CanvasAction[]> }> {
  // Mock mode: canned reply stream + empty actions.
  if (process.env.VOX_PROVIDER_MODE === "mock") {
    const cannedReply = mockReply(input.message);
    const replyStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(cannedReply);
        controller.close();
      }
    });
    return { reply: replyStream, actions: Promise.resolve([]) };
  }

  if (cerebrasKeys().length === 0) throw new Error("CEREBRAS_API_KEY is required for streamDecideTurn.");

  const systemPrompt = buildStreamDecidePrompt({
    car: input.car,
    images: input.images,
    viewState: input.viewState
  });

  const userPayload = JSON.stringify({
    shopperMessage: input.message,
    recentTurns: (input.recentTurns ?? []).slice(-4)
  });

  // Single NON-STREAMING Cerebras call through the key revolver (round-robin +
  // on-429 failover). The previous token-streaming state machine intermittently
  // failed to close (pooled-connection / backpressure fragility), which left
  // `actions` unresolved and FROZE the canvas while the spoken reply still
  // played. A plain request is reliable and, for a ~30-word reply, only ~300ms
  // slower to first audio. We THROW when every key fails (incl. 429) so the
  // caller's heuristic fallback can take over — no MiniMax in this path.
  const allowedImageIds = new Set(input.images.map((img) => img.id));
  const json = await cerebrasChatCompletion({
    model: process.env.CEREBRAS_DECISION_MODEL || process.env.CEREBRAS_MODEL || "gpt-oss-120b",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPayload }
    ],
    temperature: 0.3,
    reasoning_effort: "low",
    max_completion_tokens: 700,
    stream: false
  }, { timeoutMs: 20_000 });
  const full = json.choices?.[0]?.message?.content ?? "";

  // Split the spoken reply (before the marker) from the canvas JSON tail (after
  // it). The model is told to always emit the marker; if it doesn't, the whole
  // output is treated as spoken reply and actions resolve to [].
  const markerIdx = full.indexOf(CANVAS_MARKER);
  const replyText = flushReplyText((markerIdx === -1 ? full : full.slice(0, markerIdx)).trim());
  const canvasTail = markerIdx === -1 ? "" : full.slice(markerIdx + CANVAS_MARKER.length);
  const actions = canvasTail.trim()
    ? parseCanvasTail(canvasTail, allowedImageIds, input.images)
    : [];

  // Reply is returned as a single chunk; the agent tees it to TTS + chat. Actions
  // are already parsed, so the canvas updates as soon as the reply is ready.
  const replyStream = new ReadableStream<string>({
    start(streamController) {
      if (replyText) streamController.enqueue(replyText);
      streamController.close();
    }
  });

  return { reply: replyStream, actions: Promise.resolve(actions) };
}

/**
 * Parse the canvas tail (text after <<<CANVAS>>>) into validated CanvasAction[].
 * Resolves to [] on any parse or validation failure — a missing canvas is non-fatal.
 */
function parseCanvasTail(
  tail: string,
  allowedImageIds: Set<string>,
  images: CarImage[]
): CanvasAction[] {
  try {
    const raw = parseJsonObject(tail.trim());
    const envelope = DecideCanvasResponseSchema.safeParse(raw);
    if (!envelope.success) {
      console.warn(`streamDecideTurn: canvas tail parse failed — ${envelope.error.message}`);
      return [];
    }
    return validateCanvasActions(envelope.data.actions, allowedImageIds, images);
  } catch (error) {
    console.warn(`streamDecideTurn: canvas tail JSON error — ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
