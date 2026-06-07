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
  description: z.string()
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

export const SpecialistMessageRequestSchema = z.object({
  vin: z.string().min(1),
  message: z.string().min(1),
  currentImageId: z.string().optional(),
  includeAudio: z.boolean().optional().default(false),
  deferImage: z.boolean().optional().default(false)
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

export const SpecialistTurnSchema = z.object({
  reply: z.string(),
  selectedImageId: z.string().optional(),
  action: SpecialistActionSchema,
  sources: z.array(SpecialistSourceSchema)
});

export const SpecialistStateSchema = z.object({
  car: CarSchema,
  images: z.array(CarImageSchema),
  selectedImageId: z.string().optional()
});

export const LiveKitTokenRequestSchema = z.object({
  roomName: z.string().min(1).default("vox-specialist-demo"),
  identity: z.string().min(1).default("shopper")
});

export type ImageRole = z.infer<typeof ImageRoleSchema>;
export type ImageStatus = z.infer<typeof ImageStatusSchema>;
export type Car = z.infer<typeof CarSchema>;
export type CarImage = z.infer<typeof CarImageSchema>;
export type SpecialistMessageRequest = z.infer<typeof SpecialistMessageRequestSchema>;
export type SpecialistImageRequest = z.infer<typeof SpecialistImageRequestSchema>;
export type SpecialistAction = z.infer<typeof SpecialistActionSchema>;
export type SpecialistSource = z.infer<typeof SpecialistSourceSchema>;
export type SpecialistTurn = z.infer<typeof SpecialistTurnSchema>;
export type SpecialistState = z.infer<typeof SpecialistStateSchema>;
export type LiveKitTokenRequest = z.infer<typeof LiveKitTokenRequestSchema>;

export const DEFAULT_VIN = "BMW-M4";
