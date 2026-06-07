import { z } from "zod";

export const ImageRoleSchema = z.enum([
  "exterior_front",
  "exterior_rear",
  "interior_front",
  "interior_rear",
  "dashboard",
  "trunk",
  "wheel",
  "detail",
  "unknown"
]);

export const ImageStatusSchema = z.enum(["pending", "processed", "failed"]);

export const CarSpecsSchema = z.object({
  condition: z.string().min(1),
  vin: z.string().min(1),
  stockNumber: z.string().min(1),
  msrp: z.number().nonnegative(),
  exteriorColor: z.string().min(1),
  interiorColor: z.string().min(1),
  engine: z.string().min(1),
  horsepower: z.number().int().positive(),
  torque: z.string().min(1),
  transmission: z.string().min(1),
  zeroToSixtySeconds: z.number().positive(),
  topSpeedMph: z.number().int().positive(),
  fuelType: z.string().min(1),
  mpgCity: z.number().int().positive(),
  mpgHighway: z.number().int().positive(),
  mpgCombined: z.number().int().positive(),
  fuelTankGallons: z.number().positive(),
  seating: z.number().int().positive(),
  doors: z.number().int().positive(),
  warranty: z.string().min(1),
  packages: z.array(z.string()),
  options: z.array(z.string())
});

export const CarSchema = z.object({
  vin: z.string().min(1),
  year: z.number().int(),
  make: z.string().min(1),
  model: z.string().min(1),
  trim: z.string().min(1),
  body: z.string().min(1),
  drivetrain: z.string().min(1),
  fuel: z.string().min(1),
  price: z.number().nullable(),
  mileage: z.number().int().nonnegative(),
  color: z.string().min(1),
  features: z.array(z.string()),
  availability: z.enum(["available", "sold", "unknown"]),
  description: z.string(),
  specs: CarSpecsSchema.optional()
});

export const CarImageSchema = z.object({
  id: z.string().min(1),
  vin: z.string().min(1),
  url: z.string().min(1),
  role: ImageRoleSchema,
  viewpoint: z.string().optional().default(""),
  caption: z.string(),
  visibleFeatures: z.array(z.string()),
  conditionNotes: z.array(z.string()).optional().default([]),
  searchTags: z.array(z.string()).optional().default([]),
  likelyQuestions: z.array(z.string()).optional().default([]),
  confidence: z.number().min(0).max(1),
  status: ImageStatusSchema
});

export const ConversationTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string()
});

export const SpecialistMessageRequestSchema = z.object({
  vin: z.string().min(1),
  message: z.string().min(1),
  currentImageId: z.string().optional(),
  includeAudio: z.boolean().optional().default(false),
  deferImage: z.boolean().optional().default(false),
  history: z.array(ConversationTurnSchema).max(12).optional().default([])
});

export const SpecialistImageRequestSchema = z.object({
  vin: z.string().min(1),
  message: z.string().min(1),
  currentImageId: z.string().optional(),
  desiredVisualTarget: z.string().nullable().optional()
});

export const SpecialistActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("keep_current_image") }),
  z.object({ type: z.literal("show_overview") }),
  z.object({
    type: z.literal("show_image"),
    imageId: z.string(),
    reason: z.string()
  })
]);

export const SpecialistSourceSchema = z.object({
  type: z.enum(["catalog", "image", "moss", "fallback"]),
  id: z.string(),
  label: z.string()
});

export const SpecialistIntentSchema = z.enum([
  "greeting",
  "spec_fact",
  "visual",
  "clarify",
  "objection"
]);

export const SpecialistTurnSchema = z.object({
  reply: z.string(),
  selectedImageId: z.string().optional(),
  intent: SpecialistIntentSchema.optional(),
  askedClarifyingQuestion: z.boolean().optional(),
  action: SpecialistActionSchema,
  sources: z.array(SpecialistSourceSchema)
});

export const SpecialistStateSchema = z.object({
  car: CarSchema,
  images: z.array(CarImageSchema),
  selectedImageId: z.string().optional()
});

export const ModelProfileIdSchema = z.enum(["instant", "natural", "expressive"]);

export const LiveKitTokenRequestSchema = z.object({
  roomName: z.string().min(1).default("vox-specialist-demo"),
  identity: z.string().min(1).default("shopper"),
  profileId: ModelProfileIdSchema.optional()
});

export type ImageRole = z.infer<typeof ImageRoleSchema>;
export type ImageStatus = z.infer<typeof ImageStatusSchema>;
export type CarSpecs = z.infer<typeof CarSpecsSchema>;
export type Car = z.infer<typeof CarSchema>;
export type CarImage = z.infer<typeof CarImageSchema>;
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
export type SpecialistMessageRequest = z.infer<typeof SpecialistMessageRequestSchema>;
export type SpecialistImageRequest = z.infer<typeof SpecialistImageRequestSchema>;
export type SpecialistIntent = z.infer<typeof SpecialistIntentSchema>;
export type SpecialistAction = z.infer<typeof SpecialistActionSchema>;
export type SpecialistSource = z.infer<typeof SpecialistSourceSchema>;
export type SpecialistTurn = z.infer<typeof SpecialistTurnSchema>;
export type SpecialistState = z.infer<typeof SpecialistStateSchema>;
export type LiveKitTokenRequest = z.infer<typeof LiveKitTokenRequestSchema>;
export type ModelProfileId = z.infer<typeof ModelProfileIdSchema>;

export const DEFAULT_VIN = "BMW-M4";

/**
 * Render the full dealership fact sheet for a car as a single plain-text block.
 * Used to give the voice agent, the web planner, and the Moss catalog document
 * the same complete set of grounded facts so spec/price/mileage questions can
 * be answered instead of refused.
 */
export function carFactSheet(car: Car): string {
  const priceLine = car.price != null ? `$${car.price.toLocaleString()}` : "Inquire for price";
  const lines: string[] = [
    `${car.year} ${car.make} ${car.model} ${car.trim} — ${car.body}, ${car.drivetrain}, ${car.fuel}.`,
    `Asking price: ${priceLine}. Mileage: ${car.mileage.toLocaleString()} mi. Availability: ${car.availability}. Exterior color: ${car.color}.`
  ];
  const s = car.specs;
  if (s) {
    lines.push(
      `Condition: ${s.condition}. VIN: ${s.vin}. Stock #: ${s.stockNumber}. MSRP: $${s.msrp.toLocaleString()}.`,
      `Exterior color: ${s.exteriorColor}. Interior: ${s.interiorColor}. Seats ${s.seating} across ${s.doors} doors.`,
      `Engine: ${s.engine} making ${s.horsepower} hp and ${s.torque}. Transmission: ${s.transmission}.`,
      `0-60 mph in ${s.zeroToSixtySeconds} seconds; top speed ${s.topSpeedMph} mph.`,
      `Fuel: ${s.fuelType}; ${s.mpgCity} city / ${s.mpgHighway} highway / ${s.mpgCombined} combined mpg; ${s.fuelTankGallons}-gallon tank.`,
      `Warranty: ${s.warranty}.`,
      s.packages.length ? `Packages: ${s.packages.join(", ")}.` : "",
      s.options.length ? `Options: ${s.options.join(", ")}.` : ""
    );
  }
  lines.push(
    car.features.length ? `Features: ${car.features.join(", ")}.` : "",
    car.description
  );
  return lines.filter(Boolean).join(" ");
}

/**
 * Model profiles drive which LLM + TTS model the live voice agent uses for a
 * session. The selector in the web UI picks one of these; the id is passed to
 * the agent via the LiveKit dispatch metadata at connect time.
 *
 * Today every profile uses MiniMax-Text-01 for the LLM (the only provider key
 * wired up) and varies the Cartesia voice model — that is the real
 * speed-vs-expressiveness knob we control. To add a faster LLM later, drop a
 * new provider key in and change `llmModel` here; nothing else needs to change.
 */
export interface ModelProfile {
  id: ModelProfileId;
  /** Shown on the selector bar. */
  label: string;
  /** Short subtitle shown in the dropdown. */
  description: string;
  /** MiniMax model id passed to streamMiniMaxChat. */
  llmModel: string;
  /** Cartesia model id used to build the LiveKit TTS string. */
  ttsModel: string;
}

export const MODEL_PROFILES: ModelProfile[] = [
  {
    id: "instant",
    label: "Instant",
    description: "Fastest replies · Sonic Turbo",
    llmModel: "MiniMax-Text-01",
    ttsModel: "sonic-turbo"
  },
  {
    id: "natural",
    label: "Natural",
    description: "Balanced speed & warmth · Sonic 3",
    llmModel: "MiniMax-Text-01",
    ttsModel: "sonic-3"
  },
  {
    id: "expressive",
    label: "Expressive",
    description: "Richest voice · Sonic 3.5",
    llmModel: "MiniMax-Text-01",
    ttsModel: "sonic-3.5"
  }
];

// Default to "instant" (Sonic Turbo) — confirmed available via LiveKit Inference
// (billed on LiveKit credits), so it's the fastest known-good voice model.
export const DEFAULT_MODEL_PROFILE_ID: ModelProfileId = "instant";

/** Resolve a profile by id, falling back to the default for unknown/missing ids. */
export function resolveModelProfile(id: string | undefined | null): ModelProfile {
  return (
    MODEL_PROFILES.find((profile) => profile.id === id) ??
    MODEL_PROFILES.find((profile) => profile.id === DEFAULT_MODEL_PROFILE_ID)!
  );
}
