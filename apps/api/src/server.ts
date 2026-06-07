import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { AccessToken } from "livekit-server-sdk";
import { RoomAgentDispatch } from "@livekit/protocol";
import { RoomConfiguration } from "@livekit/protocol";
import { rankImagesForQuestion, selectOverviewImage } from "@vox/agent-core";
import {
  DEFAULT_VIN,
  SpecialistImageRequestSchema,
  LiveKitTokenRequestSchema,
  SpecialistMessageRequestSchema
} from "@vox/core";
import {
  bookTestDriveAndNotify,
  bookingFollowupPrompt,
  chooseMiniMaxSpecialistImage,
  planSpecialistTurn,
  getCar,
  ingestImageObject,
  listImages,
  looksLikeBookingRequest,
  markCarSold,
  parseBookingDetails,
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
const liveKitAgentName = process.env.VOX_AGENT_NAME ?? process.env.LIVEKIT_AGENT_NAME ?? "vox-specialist";

app.use("*", cors({
  origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"]
}));

void warmMossIndexes().catch((error) => {
  console.warn(`Moss warmup failed: ${error instanceof Error ? error.message : String(error)}`);
});

app.get("/health", (c) => c.json({ ok: true, service: "vox-api" }));

app.get("/api/specialist/state", async (c) => {
  const vin = c.req.query("vin") ?? DEFAULT_VIN;
  const car = await getCar(vin);
  if (!car) return c.json({ error: "car not found" }, 404);
  const images = await listImages(vin);
  const overview = selectOverviewImage(images);
  return c.json({ car, images, selectedImageId: overview?.id ?? images[0]?.id });
});

app.post("/api/specialist/message", async (c) => {
  const parsed = SpecialistMessageRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
  const car = await getCar(parsed.data.vin);
  if (!car) return c.json({ error: "car not found" }, 404);
  const images = await listImages(parsed.data.vin);
  const normalized = parsed.data.message.toLowerCase().replace(/\s+/g, " ").trim();

  const historyLooksLikeBooking = parsed.data.history.slice(-4).some((turn) => looksLikeBookingRequest(turn.text.toLowerCase()));
  const looksLikeBookingFollowup = historyLooksLikeBooking && /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|today|tomorrow|next|sunday|monday|tuesday|wednesday|thursday|friday|saturday|my number)\b/i.test(parsed.data.message);

  if (looksLikeBookingRequest(normalized) || looksLikeBookingFollowup) {
    const bookingContext = looksLikeBookingRequest(normalized)
      ? parsed.data.message
      : [...parsed.data.history.slice(-4).map((turn) => turn.text), parsed.data.message].join(" ");
    const details = parseBookingDetails(bookingContext);
    const parsedBooking = details.parsedBooking;
    const phone = details.phone;
    let reply: string;
    let smsSid: string | undefined;
    let smsStatus: string | undefined;
    let bookingSlot: string | undefined;

    if (!parsedBooking || parsedBooking.hour24 < 11 || parsedBooking.hour24 > 15 || !phone) {
      reply = bookingFollowupPrompt(details);
    } else {
      const result = await bookTestDriveAndNotify({ car, phone, parsedBooking }).catch((error: unknown) => {
        console.warn(`Linq booking text failed: ${error instanceof Error ? error.message : String(error)}`);
        return {
          slot: parsedBooking.normalizedLabel,
          reply: `Perfect — I have you down for ${parsedBooking.normalizedLabel}, but I couldn't send the confirmation text just now.`,
          sms: undefined
        };
      });
      reply = result.reply;
      bookingSlot = result.slot;
      smsSid = result.sms?.sid;
      smsStatus = result.sms?.status;
    }

    const audio = parsed.data.includeAudio ? await synthesizeSpeech(reply).catch(() => ({})) : {};
    return c.json({
      reply,
      selectedImageId: parsed.data.currentImageId,
      intent: !parsedBooking ? "clarify" : undefined,
      askedClarifyingQuestion: !parsedBooking,
      action: { type: "keep_current_image" },
      sources: [{ type: "catalog", id: car.vin, label: `${car.year} ${car.make} ${car.model}` }],
      smsSid,
      smsStatus,
      bookingSlot,
      ...audio
    });
  }

  // The keyword heuristic ONLY narrows which images the planner gets to choose
  // from — it never forces the final selection. The planner's needsImage /
  // selectedImageId decision is authoritative.
  const ranked = rankImagesForQuestion(parsed.data.message, images);
  const candidates = ranked.length > 0
    ? ranked.slice(0, 8).map((item) => item.image)
    : images.filter((image) => image.status === "processed").slice(0, 10);

  let selectedImage: (typeof images)[number] | undefined;
  let reply: string;
  let intent: string | undefined;
  let askedClarifyingQuestion = false;

  try {
    const plan = await planSpecialistTurn({
      car,
      images: candidates,
      message: parsed.data.message,
      currentImageId: parsed.data.currentImageId,
      history: parsed.data.history
    });
    reply = plan.reply;
    intent = plan.intent;
    askedClarifyingQuestion = plan.askedClarifyingQuestion;
    // Authoritative: only show an image when the planner asked for one.
    if (plan.needsImage && plan.selectedImageId) {
      selectedImage = images.find((image) => image.id === plan.selectedImageId);
    }
  } catch (error) {
    console.warn(`Planner failed: ${error instanceof Error ? error.message : String(error)}`);
    reply = "Sorry, I lost my train of thought there — can you say that again?";
  }

  const audio = parsed.data.includeAudio ? await synthesizeSpeech(reply).catch(() => ({})) : {};
  const shouldShowImage = !!selectedImage && selectedImage.id !== parsed.data.currentImageId;

  return c.json({
    reply,
    selectedImageId: selectedImage?.id,
    intent,
    askedClarifyingQuestion,
    action: shouldShowImage
      ? { type: "show_image", imageId: selectedImage!.id, reason: selectedImage!.caption }
      : { type: "keep_current_image" },
    sources: [
      { type: "catalog", id: car.vin, label: `${car.year} ${car.make} ${car.model}` },
      ...(selectedImage ? [{ type: "image", id: selectedImage.id, label: selectedImage.caption }] : [])
    ],
    ...audio
  });
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

  const ranked = rankImagesForQuestion(parsed.data.message, images, mossResults);
  const heuristicWinner = ranked[0]?.image;
  const topScore = ranked[0]?.score ?? 0;
  const runnerUp = ranked[1]?.score ?? 0;
  const heuristicConfident = heuristicWinner && topScore >= 12 && topScore >= runnerUp + 6;

  let selectedImage: typeof heuristicWinner | undefined;
  let reply: string | undefined;
  let actionReason: string | undefined;

  if (heuristicConfident) {
    selectedImage = heuristicWinner;
    actionReason = "Heuristic match";
  } else {
    const candidates = ranked.length > 0
      ? ranked.slice(0, 8).map((item) => item.image)
      : images.filter((image) => image.status === "processed").slice(0, 12);
    try {
      const plan = await chooseMiniMaxSpecialistImage({
        car,
        images: candidates,
        message: parsed.data.message,
        currentImageId: parsed.data.currentImageId,
        desiredVisualTarget: parsed.data.desiredVisualTarget,
        mossResults
      });
      reply = plan.reply;
      actionReason = plan.actionReason;
      selectedImage = plan.selectedImageId
        ? images.find((image) => image.id === plan.selectedImageId)
        : undefined;
      if (!selectedImage) selectedImage = heuristicWinner;
    } catch (error) {
      console.warn(`MiniMax image planner failed: ${error instanceof Error ? error.message : String(error)}`);
      selectedImage = heuristicWinner;
    }
  }

  return c.json({
    reply,
    selectedImageId: selectedImage?.id,
    action: selectedImage && selectedImage.id !== parsed.data.currentImageId
      ? { type: "show_image", imageId: selectedImage.id, reason: actionReason || selectedImage.caption }
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
        // Must match the worker's agentName (apps/agent/src/agent.ts). Set
        // VOX_AGENT_NAME (in .env, same value both sides) + restart to isolate
        // from a stale/rogue "vox-specialist" worker.
        agentName: liveKitAgentName,
        metadata: JSON.stringify({ vin: DEFAULT_VIN, profileId: parsed.data.profileId, returning: parsed.data.returning ?? false, brainMode: parsed.data.brainMode })
      })

    ]
  });
  return c.json({ token: await token.toJwt(), url, roomName: parsed.data.roomName });
});

app.get("/api/catalog", async (c) => c.json({ cars: await readCatalog() }));

// Resolve the repo's public/cars dir and list a car's photos for the inventory UI.
function repoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(path.join(dir, "public", "cars"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
const PUBLIC_CARS = path.join(repoRoot(process.cwd()), "public", "cars");

async function listCarPhotos(vin: string): Promise<string[]> {
  const dir = path.join(PUBLIC_CARS, vin);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  return files.map((f) => `/cars/${vin}/${f}`);
}

// Full lot for the inventory browse page: every car + its photos.
app.get("/api/inventory", async (c) => {
  const cars = await readCatalog();
  const items = await Promise.all(cars.map(async (car) => ({ ...car, photos: await listCarPhotos(car.vin) })));
  return c.json({ cars: items });
});

// One vehicle's detail (photos + specs) for the detail page.
app.get("/api/inventory/:vin", async (c) => {
  const vin = c.req.param("vin");
  const car = await getCar(vin);
  if (!car) return c.json({ error: "car not found" }, 404);
  return c.json({ car, photos: await listCarPhotos(vin) });
});

// Moss browser config — credentials + index names so the @moss-dev/moss SDK can
// run loadIndex()/query() in-browser (client-first).
app.get("/api/moss/config", (c) => {
  const projectId = process.env.MOSS_PROJECT_ID;
  const projectKey = process.env.MOSS_PROJECT_KEY;
  if (!projectId || !projectKey) {
    return c.json({ error: "MOSS_PROJECT_ID / MOSS_PROJECT_KEY not set" }, 503);
  }
  return c.json({
    projectId,
    projectKey,
    catalogIndex: process.env.MOSS_CATALOG_INDEX ?? null,
    imagesIndex: process.env.MOSS_IMAGES_INDEX ?? null
  });
});

// Mark a car sold. Persists availability=sold (the voice agent picks this up on
// its next turn via the mtime-aware catalog read) and returns a best-effort
// alternative for cross-sell. The sub-10ms "Moss found your next car" latency is
// shown client-side via the in-browser index; this server alternative is a fallback.
app.post("/api/specialist/sold", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const vin = typeof body?.vin === "string" ? body.vin : DEFAULT_VIN;
  const car = await markCarSold(vin);
  if (!car) return c.json({ error: "car not found" }, 404);
  const cars = await readCatalog();
  const alt = cars.find((x) => x.vin !== vin && x.availability === "available" && x.body === car.body)
    ?? cars.find((x) => x.vin !== vin && x.availability === "available");
  const alternative = alt
    ? { vin: alt.vin, title: `${alt.year} ${alt.make} ${alt.model}`, price: alt.price != null ? String(alt.price) : undefined, body: alt.body }
    : null;
  return c.json({ car, alternative });
});

// Mint a short-lived Simli session token so the browser can render the talking-head
// avatar directly (simli-client), without ever seeing SIMLI_API_KEY.
app.post("/api/avatar/token", async (c) => {
  const apiKey = process.env.SIMLI_API_KEY;
  const faceId = process.env.SIMLI_FACE_ID;
  if (!apiKey || !faceId) return c.json({ error: "Simli env not configured" }, 503);
  try {
    const resp = await fetch("https://api.simli.ai/compose/token", {
      method: "POST",
      headers: { "x-simli-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ faceId, handleSilence: true, maxSessionLength: 600, maxIdleTime: 30 })
    });
    const tokenBody = await resp.json().catch(() => ({}));
    if (!resp.ok) return c.json({ error: "Simli token failed", status: resp.status, body: tokenBody }, 502);
    let iceServers: unknown[] = [];
    try {
      const iceResp = await fetch("https://api.simli.ai/compose/ice", {
        headers: { "x-simli-api-key": apiKey, "Content-Type": "application/json" }
      });
      if (iceResp.ok) iceServers = await iceResp.json();
    } catch {
      // fall through; browser will fall back to a public STUN server
    }
    return c.json({ sessionToken: (tokenBody as { session_token?: string }).session_token, faceId, iceServers });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`Vox API listening on http://localhost:${port}`);
});

export default app;
