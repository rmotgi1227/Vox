import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AccessToken } from "livekit-server-sdk";
import { RoomAgentDispatch } from "@livekit/protocol";
import { RoomConfiguration } from "@livekit/protocol";
import { orchestrateSpecialistTurn } from "@vox/agent-core";
import type { AiProvider, CatalogStore } from "@vox/agent-core";
import {
  DEFAULT_VIN,
  SpecialistImageRequestSchema,
  LiveKitTokenRequestSchema,
  SpecialistMessageRequestSchema,
  SpecialistTurnSchema
} from "@vox/core";
import {
  chooseMiniMaxSpecialistImage,
  generateMiniMaxFastTurn,
  generateMiniMaxReply,
  generateMiniMaxSpecialistPlan,
  getCar,
  ingestImageObject,
  listImages,
  readCatalog,
  saveUploadedImage,
  searchMoss as searchMossProvider,
  synthesizeSpeech,
  warmMossIndexes
} from "@vox/ai";

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

const app = new Hono();
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 8787);

app.use("*", cors({
  origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"]
}));

const catalog: CatalogStore = {
  getCar,
  listImages
};

const ai: AiProvider = {
  async searchMoss(query, vin) {
    return searchMossProvider(query, vin);
  },
  async planTurn(input) {
    return generateMiniMaxSpecialistPlan(input);
  },
  async generateReply(input) {
    const selected = input.selectedImage
      ? [
          `Selected image: ${input.selectedImage.role}; ${input.selectedImage.caption}`,
          input.selectedImage.viewpoint ? `Viewpoint: ${input.selectedImage.viewpoint}` : "",
          `Features visible: ${input.selectedImage.visibleFeatures.join(", ")}`,
          input.selectedImage.conditionNotes.length ? `Evidence notes: ${input.selectedImage.conditionNotes.join(", ")}` : "",
          input.selectedImage.searchTags.length ? `Search tags: ${input.selectedImage.searchTags.join(", ")}` : ""
        ].filter(Boolean).join(". ")
      : "No selected image.";
    const context = [
      `${input.car.year} ${input.car.make} ${input.car.model} ${input.car.trim}`,
      `Features: ${input.car.features.join(", ")}`,
      `Description: ${input.car.description}`,
      selected,
      `Retrieved context: ${input.mossResults.map((r) => `${r.label}: ${r.text}`).join(" | ")}`
    ].join("\n");
    return generateMiniMaxReply({
      system: "You are Vox, a direct BMW sales specialist. Answer in one short sentence, max 22 words. Use only provided catalog and image context. If the selected image answers the visual question, describe what it shows. Do not mention retrieval or sources.",
      user: `CONTEXT:\n${context}\n\nSHOPPER: ${input.message}`
    });
  }
};

void warmMossIndexes().catch((error) => {
  console.warn(`Moss warmup failed: ${error instanceof Error ? error.message : String(error)}`);
});

app.get("/health", (c) => c.json({ ok: true, service: "vox-api" }));

app.get("/api/specialist/state", async (c) => {
  const vin = c.req.query("vin") ?? DEFAULT_VIN;
  const car = await getCar(vin);
  if (!car) return c.json({ error: "car not found" }, 404);
  const images = await listImages(vin);
  return c.json({ car, images, selectedImageId: images[0]?.id });
});

app.post("/api/specialist/message", async (c) => {
  const parsed = SpecialistMessageRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
  if (parsed.data.deferImage) {
    const car = await getCar(parsed.data.vin);
    if (!car) return c.json({ error: "car not found" }, 404);
    const images = await listImages(parsed.data.vin);
    const currentImage = images.find((image) => image.id === parsed.data.currentImageId);
    const fast = await generateMiniMaxFastTurn({ car, message: parsed.data.message, currentImage });
    const audio = parsed.data.includeAudio ? await synthesizeSpeech(fast.reply).catch(() => ({})) : {};
    return c.json({
      reply: fast.reply,
      needsImage: fast.needsImage,
      desiredVisualTarget: fast.desiredVisualTarget ?? null,
      action: { type: "keep_current_image" },
      sources: [{ type: "catalog", id: car.vin, label: `${car.year} ${car.make} ${car.model}` }],
      ...audio
    });
  }
  const turn = await orchestrateSpecialistTurn({ catalog, ai }, parsed.data);
  const audio = parsed.data.includeAudio ? await synthesizeSpeech(turn.reply).catch(() => ({})) : {};
  SpecialistTurnSchema.parse(turn);
  return c.json({ ...turn, ...audio });
});

app.post("/api/specialist/image", async (c) => {
  const parsed = SpecialistImageRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
  const car = await getCar(parsed.data.vin);
  if (!car) return c.json({ error: "car not found" }, 404);
  const [images, mossResults] = await Promise.all([
    listImages(parsed.data.vin),
    searchMossProvider(parsed.data.desiredVisualTarget || parsed.data.message, parsed.data.vin)
  ]);
  const plan = await chooseMiniMaxSpecialistImage({
    car,
    images,
    message: parsed.data.message,
    currentImageId: parsed.data.currentImageId,
    desiredVisualTarget: parsed.data.desiredVisualTarget,
    mossResults
  });
  const selectedImage = plan.selectedImageId ? images.find((image) => image.id === plan.selectedImageId) : undefined;
  return c.json({
    reply: plan.reply,
    selectedImageId: selectedImage?.id,
    action: selectedImage && selectedImage.id !== parsed.data.currentImageId
      ? { type: "show_image", imageId: selectedImage.id, reason: plan.actionReason || selectedImage.caption }
      : { type: "keep_current_image" },
    sources: [
      { type: "catalog", id: car.vin, label: `${car.year} ${car.make} ${car.model}` },
      ...mossResults.slice(0, 3).map((result) => ({ type: "moss", id: result.id, label: result.label })),
      ...(selectedImage ? [{ type: "image", id: selectedImage.id, label: selectedImage.caption }] : [])
    ]
  });
});

app.get("/api/admin/images", async (c) => {
  const vin = c.req.query("vin") ?? DEFAULT_VIN;
  return c.json({ images: await listImages(vin) });
});

app.post("/api/admin/images/upload", async (c) => {
  const body = await c.req.parseBody();
  const vin = String(body.vin ?? DEFAULT_VIN);
  const entries = Object.entries(body).filter(([, value]) => value instanceof File) as Array<[string, File]>;
  const saved = [];
  for (const [, file] of entries) {
    saved.push(await saveUploadedImage({ vin, fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }));
  }
  return c.json({ images: saved });
});

app.post("/api/admin/images/:id/ingest", async (c) => {
  const image = await ingestImageObject(c.req.param("id"));
  if (!image) return c.json({ error: "image not found" }, 404);
  return c.json({ image });
});

app.post("/api/livekit/token", async (c) => {
  const parsed = LiveKitTokenRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;
  if (!key || !secret || !url) return c.json({ error: "LiveKit env not configured" }, 503);
  const token = new AccessToken(key, secret, {
    identity: parsed.data.identity,
    ttl: "30m"
  });
  token.addGrant({ room: parsed.data.roomName, roomJoin: true, canPublish: true, canSubscribe: true });
  token.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName: "vox-specialist",
        metadata: JSON.stringify({ vin: DEFAULT_VIN })
      })
    ]
  });
  return c.json({ token: await token.toJwt(), url, roomName: parsed.data.roomName });
});

app.get("/api/catalog", async (c) => c.json({ cars: await readCatalog() }));

serve({ fetch: app.fetch, port }, () => {
  console.log(`Vox API listening on http://localhost:${port}`);
});

export default app;
