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
  // Optional so existing catalog data parses unchanged. When present, the voice
  // lane can answer "how big is the trunk" with a grounded figure (the canvas
  // annotation overlays the same number visually).
  cargoCubicFeet: z.number().positive().optional(),
  warranty: z.string().min(1),
  packages: z.array(z.string()),
  options: z.array(z.string())
});

export const PricingGuidanceSchema = z.object({
  incentiveRangeMin: z.number().nonnegative(),
  incentiveRangeMax: z.number().nonnegative(),
  note: z.string().min(1).optional()
}).refine((value) => value.incentiveRangeMin <= value.incentiveRangeMax, {
  message: "incentiveRangeMin must be less than or equal to incentiveRangeMax"
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
  specs: CarSpecsSchema.optional(),
  pricingGuidance: PricingGuidanceSchema.optional()
});

// ── Canvas agent foundation (Phase 0) ────────────────────────────────────────
// Normalized bounding-box: [x, y, w, h] all in 0..1 relative to image dims.
export const BBoxSchema = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1)
]);

// A normalized contour point [x, y] in 0..1. A PolygonSchema is an ordered ring
// of these points tracing an object's actual shape — so an annotation can hug
// the trunk opening (an outline) instead of drawing a crude bounding rectangle.
export const NormPointSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
export const PolygonSchema = z.array(NormPointSchema).min(3);

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
  status: ImageStatusSchema,
  // Optional canvas metadata — seeded by ingest (Phase 6+). Safe defaults let
  // the existing 46-image data/images.json parse without any changes.
  boxes: z.array(z.object({ label: z.string(), box: BBoxSchema, polygon: PolygonSchema.optional() })).optional().default([]),
  zoomTargets: z.record(z.string(), BBoxSchema).optional().default({}),
  pairs: z.array(z.string()).optional().default([])
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
  sources: z.array(SpecialistSourceSchema),
  smsSid: z.string().optional(),
  smsStatus: z.string().optional(),
  bookingSlot: z.string().optional()
});

export const SpecialistStateSchema = z.object({
  car: CarSchema,
  images: z.array(CarImageSchema),
  selectedImageId: z.string().optional()
});

export const ModelProfileIdSchema = z.enum(["instant", "natural", "expressive"]);

// TEMP A/B toggle: "single" = one LLM call (reply + canvas together, coherent);
// "double" = two parallel calls (speech + canvas). Defaults to single.
export const BrainModeSchema = z.enum(["single", "double"]);

export const LiveKitTokenRequestSchema = z.object({
  roomName: z.string().min(1).default("vox-specialist-demo"),
  identity: z.string().min(1).default("shopper"),
  profileId: ModelProfileIdSchema.optional(),
  // True when the shopper has already connected once this page session, so the
  // agent gives a short "how can I help?" instead of the full first-time opener.
  returning: z.boolean().optional(),
  brainMode: BrainModeSchema.optional().default("single")
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
export type BrainMode = z.infer<typeof BrainModeSchema>;
export type ModelProfileId = z.infer<typeof ModelProfileIdSchema>;

// Canvas agent inferred types (Phase 0)
export type BBox = z.infer<typeof BBoxSchema>;
export type Polygon = z.infer<typeof PolygonSchema>;
export type CanvasItem = z.infer<typeof CanvasItemSchema>;
export type ItemRef = z.infer<typeof ItemRefSchema>;
export type ItemFilter = z.infer<typeof ItemFilterSchema>;
export type CanvasAction = z.infer<typeof CanvasActionSchema>;
export type ViewState = z.infer<typeof ViewStateSchema>;
export type ViewUpdateEvent = z.infer<typeof ViewUpdateEventSchema>;

// ── Canvas action types (Phase 0 continued) ───────────────────────────────────

// A reference to an item either by its ids or by its index in ViewState.items.
export const ItemRefSchema = z.union([
  z.object({ carId: z.string().min(1), imageId: z.string().min(1) }),
  z.object({ index: z.number().int().min(0) })
]);

// Filter for selecting images from the catalog.
export const ItemFilterSchema = z.object({
  carId: z.string().min(1).optional(),
  role: ImageRoleSchema.optional(),
  feature: z.string().optional(),
  tags: z.array(z.string()).optional()
});

// A single item the canvas is showing.
export const CanvasItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    carId: z.string().min(1),
    imageId: z.string().min(1)
  }),
  z.object({
    kind: z.literal("generated"),
    id: z.string().min(1),
    prompt: z.string().min(1),
    status: z.enum(["pending", "ready", "failed"]),
    url: z.string().optional()
  }),
  z.object({
    kind: z.literal("car"),
    carId: z.string().min(1)
  }),
  // A "notepad" of grounded facts the specialist writes out as text instead of
  // a photo — e.g. mileage, price, horsepower. `rows` are already resolved and
  // formatted by the reducer (the renderer never sees the Car), so the canvas
  // can only ever display numbers that match the catalog data.
  z.object({
    kind: z.literal("spec"),
    title: z.string().optional(),
    rows: z.array(z.object({
      label: z.string(),
      value: z.string(),
      emphasis: z.enum(["normal", "muted", "total"]).optional(),
      separatorBefore: z.boolean().optional()
    })).min(1)
  })
]);

// What the screen is showing right now. The renderer is a pure function of this.
export const ViewStateSchema = z.object({
  layout: z.enum(["single", "grid", "compare", "focus", "spec"]),
  items: z.array(CanvasItemSchema),
  zoom: z.object({
    itemIndex: z.number().int().min(0),
    region: BBoxSchema
  }).optional(),
  marks: z.array(z.object({
    itemIndex: z.number().int().min(0),
    box: BBoxSchema,
    label: z.string(),
    // Optional contour: when present the renderer outlines this shape instead of
    // drawing the rectangular box (box stays as the label anchor + fallback).
    polygon: PolygonSchema.optional()
  })).optional(),
  caption: z.string().optional()
});

// Canonical agent → web event for the canvas. Published on the LiveKit data
// channel topic "vox.specialist.turn" alongside the existing specialist_turn /
// agent_status events. The web replaces its local ViewState with `view`.
export const ViewUpdateEventSchema = z.object({
  type: z.literal("view_update"),
  view: ViewStateSchema
});

// The tool-call contract. Every change to the screen must go through one of these.
// Region for zoom: either a BBox tuple or a named zoomTarget string.
export const CanvasActionSchema = z.discriminatedUnion("op", [
  // ── Tier 1: full behavior ──────────────────────────────────────────────────
  z.object({
    op: z.literal("showImage"),
    carId: z.string().min(1),
    imageId: z.string().min(1)
  }),
  z.object({
    op: z.literal("showImages"),
    carId: z.string().min(1).optional(),
    imageIds: z.array(z.string().min(1)).optional(),
    filter: ItemFilterSchema.optional(),
    limit: z.number().int().min(1).max(4).optional()
  }),
  z.object({
    op: z.literal("zoom"),
    itemRef: ItemRefSchema,
    region: z.union([BBoxSchema, z.string()])
  }),
  // ── Tier 2: schema now, behavior in Phase 5–6 ─────────────────────────────
  // marks is OPTIONAL: when omitted, the reducer backfills the marks from the
  // target image's precomputed `boxes` (so a text-only LLM never has to invent
  // pixel coordinates it cannot see — it just points at the image to annotate).
  z.object({
    op: z.literal("annotate"),
    itemRef: ItemRefSchema,
    marks: z.array(z.object({ box: BBoxSchema, label: z.string(), polygon: PolygonSchema.optional() })).optional()
  }),
  z.object({
    op: z.literal("compare"),
    itemRefs: z.tuple([ItemRefSchema, ItemRefSchema])
  }),
  // Compare TWO DIFFERENT cars side by side (e.g. the M4 next to a Kia Telluride).
  // carIds are vins; the reducer resolves each car's hero image into a 2-up view.
  z.object({
    op: z.literal("compareCars"),
    carIds: z.tuple([z.string().min(1), z.string().min(1)])
  }),
  z.object({
    op: z.literal("focusCar"),
    carId: z.string().min(1)
  }),
  // ── Text: write grounded facts onto the canvas (the salesman's notepad) ──────
  // The model names WHICH facts to surface (e.g. ["mileage","price"]); the
  // reducer resolves each field to a formatted value from the Car record. The
  // model never types the number itself, so the figure on screen can't drift
  // from the catalog. `title` is an optional short heading ("Performance").
  z.object({
    op: z.literal("writeSpec"),
    fields: z.array(z.string().min(1)).min(1).max(6),
    title: z.string().optional()
  }),
  // ── Tier 3: stub, no behavior yet (Phase 7) ───────────────────────────────
  z.object({
    op: z.literal("generate"),
    prompt: z.string().min(1),
    baseRef: ItemRefSchema.optional()
  }),
  z.object({
    op: z.literal("reset")
  })
]);

export const DEFAULT_VIN = "BMW-M4";

/**
 * Render the full dealership fact sheet for a car as a single plain-text block.
 * Used to give the voice agent, the web planner, and the Moss catalog document
 * the same complete set of grounded facts so spec/price/mileage questions can
 * be answered instead of refused.
 */
export function carFactSheet(car: Car): string {
  const priceLine = car.price != null ? `$${car.price.toLocaleString()}` : "Inquire for price";
  const pricing = car.pricingGuidance;
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
      s.cargoCubicFeet ? `Trunk / cargo volume: ${s.cargoCubicFeet} cu ft (about ${Math.round(s.cargoCubicFeet * 28.3)} liters), expandable via the split-folding rear seatbacks.` : "",
      `Warranty: ${s.warranty}.`,
      s.packages.length ? `Packages: ${s.packages.join(", ")}.` : "",
      s.options.length ? `Options: ${s.options.join(", ")}.` : ""
    );
  }
  if (pricing) {
    lines.push(
      `Pricing guidance: MSRP is ${s ? `$${s.msrp.toLocaleString()}` : "not listed"}; our price is ${priceLine}. After applicable discounts, rebates, and incentives, target discussion range is $${pricing.incentiveRangeMin.toLocaleString()}-$${pricing.incentiveRangeMax.toLocaleString()}.${pricing.note ? ` ${pricing.note}` : ""}`
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
