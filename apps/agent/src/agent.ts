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
  resolveModelProfile,
  type Car,
  type CarImage,
  type ViewState,
  type ItemRef
} from "@vox/core";
import { applyAction, planCanvas, selectOverviewImage } from "@vox/agent-core";
import {
  bookTestDriveAndNotify,
  bookingFollowupPrompt,
  decideCanvas,
  decideTurn,
  extractPhoneNumber,
  generateSpokenReply,
  generateVisualization,
  getCar,
  listImages,
  looksLikeBookingRequest,
  parseBookingDetails
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

// ---------------------------------------------------------------------------
// M4 domain keyterms for Deepgram nova-3 keyterm prompting.
// Curated against the actual catalog (data/catalog.json) plus the words a
// shopper actually says out loud — model/trim, performance, colors, packages,
// and buying-process terms that generic STT mangles. nova-3 handles ~100
// keyterms; this stays curated (~45) so boosts don't smear.
// Passed through LiveKit Inference (no Deepgram API key required).
// ---------------------------------------------------------------------------
const M4_KEYTERMS: string[] = [
  // Model & trim
  "BMW M4",
  "M4",
  "M4 Competition",
  "Competition",
  "xDrive",
  "M xDrive",
  // Engine & performance
  "S58",
  "TwinPower Turbo",
  "twin-turbo",
  "inline-six",
  "horsepower",
  "torque",
  "zero to sixty",
  "top speed",
  "M Steptronic",
  "paddle shifters",
  "M Sport differential",
  "Adaptive M suspension",
  "M Sport brakes",
  "quad exhaust",
  // Drivetrain
  "rear-wheel drive",
  "drivetrain",
  // Interior & tech
  "M Carbon bucket seats",
  "Merino leather",
  "carbon-fiber roof",
  "carbon fiber trim",
  "Harman Kardon",
  "head-up display",
  "Laserlight",
  "iDrive",
  "Apple CarPlay",
  "Parking Assistant Plus",
  "surround-view cameras",
  // Colors
  "Brooklyn Grey Metallic",
  "Frozen Brilliant White",
  "Isle of Man Green",
  // Packages
  "Executive Package",
  "M Driver's Package",
  "Driving Assistance Professional",
  // Interior — target scenario words + synonyms (gear shifter, center console area)
  "interior",
  "gear shifter",
  "shifter",
  "gear selector",
  "center console",
  // Visual commands — "pictures", "show me", "zoom in"
  "pictures",
  "show me",
  "zoom in",
  // Buying process
  "MSRP",
  "warranty",
  "test drive",
  "financing",
  "lease",
  "trade-in",
];

const encoder = new TextEncoder();
const FALLBACK_REPLY = "One sec, let me bring that up for you.";
const CARTESIA_VOICE = process.env.CARTESIA_VOICE_ID || "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";
const AGENT_NAME = process.env.VOX_AGENT_NAME ?? process.env.LIVEKIT_AGENT_NAME ?? "vox-specialist";

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

/**
 * Resolve a generate action's baseRef to the public URL of the real photo to
 * edit. {imageId} → that catalog image; {index} (or missing) → the item at that
 * index currently on screen. Returns undefined → pure text-to-image.
 */
function resolveBaseImageUrl(
  baseRef: ItemRef | undefined,
  view: ViewState,
  images: CarImage[]
): string | undefined {
  const urlById = (id: string) => images.find((img) => img.id === id)?.url;
  if (baseRef && "imageId" in baseRef) return urlById(baseRef.imageId);
  const idx = baseRef && "index" in baseRef ? baseRef.index : 0;
  const item = view.items[idx] ?? view.items[0];
  if (item?.kind === "image") return urlById(item.imageId);
  if (item?.kind === "generated") return item.url;
  return undefined;
}

function looksLikeBookingFragment(message: string, hasPhone: boolean): boolean {
  return hasPhone ||
    looksLikeBookingRequest(message) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|today|tomorrow|weekend|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.test(message) ||
    /\b(\d{1,2}\/\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(am|pm)\b/.test(message) ||
    /\bzero\s+(one|two|three|four|five|six|seven|eight|nine|zero)\b/.test(message);
}

function isAffirmation(message: string): boolean {
  return /^(yes|yeah|yep|correct|confirm|that's right|that is right|sounds good|do it|book it)\.?$/i.test(message.trim());
}

class VoxSpecialistVoiceAgent extends voice.Agent {
  // ViewState tracks what the canvas is currently showing. Seeded in entry()
  // from the first processed image; updated exclusively via applyAction so the
  // canvas lane and voice narration always see a coherent view.
  private viewState: ViewState = { layout: "single", items: [] };
  // The "home" view — the overview hero (OG first image). When a turn needs no
  // image or text, the canvas reverts here instead of lingering on a stale or
  // weakly-matched photo.
  private overviewView: ViewState = { layout: "single", items: [] };
  private customerPhone: string | undefined;
  private bookingDraft = "";
  private lastHandled = "";
  private lastHandledAt = 0;
  private turnCounter = 0;
  // True while Vox is speaking — used to gate out short echo / cross-talk turns.
  private speaking = false;
  // Short rolling conversation history fed to the single-brain decider so
  // follow-ups ("show me the other one") resolve against context.
  private history: { role: string; text: string }[] = [];

  constructor(
    private readonly ctx: JobContext,
    private readonly llmModel: string,
    // True on a reconnect within the same page session — skip the full opener.
    private readonly returning: boolean = false,
    // TEMP A/B: "single" = one LLM call (reply + canvas together), "double" =
    // two parallel calls (speech + canvas). Default single.
    private readonly brainMode: "single" | "double" = "single"
  ) {
    super({
      instructions: "You are Vox, a voice-first BMW M4 sales specialist. Test-drive booking and texting are handled by app code; never promise phone calls or manual team confirmation."
    });
  }

  /** Seed the initial ViewState from the overview image chosen in entry(). */
  setInitialViewState(state: ViewState) {
    this.viewState = state;
    this.overviewView = state; // remember the OG hero so we can revert to it
  }

  /**
   * Revert the canvas to the overview hero (the OG first image) when a turn
   * produced no image/text. No-op if we're already there or have no overview.
   */
  private revertToOverview(turnId: number, tag: string): void {
    if (this.overviewView.items.length === 0) return;
    if (JSON.stringify(this.viewState) === JSON.stringify(this.overviewView)) {
      console.log(`Vox turn #${turnId} ${tag} canvas: no actions (already overview)`);
      return;
    }
    this.viewState = this.overviewView;
    this.publishViewUpdate(this.overviewView);
    console.log(`Vox turn #${turnId} ${tag} canvas: reverted to overview`);
  }

  /** Track whether Vox is currently speaking (driven by AgentStateChanged). */
  setSpeaking(value: boolean) {
    this.speaking = value;
  }

  /**
   * Publish a full ViewState replacement to the web client.
   * The web side replaces its local ViewState on receipt (not patch — full replace).
   */
  private publishViewUpdate(view: ViewState): void {
    publishSpecialistDataAsync(this.ctx, { type: "view_update", view });
  }

  /**
   * Run a Nano Banana generative visualization on a non-blocking lane: show a
   * shimmer placeholder immediately, call Gemini (slow, ~10–30s), then swap in
   * the result — or a "failed" tile if it errors (e.g. out of image quota). The
   * spoken reply ("generating that now…") has already gone out by the time this
   * runs, so the voice never waits on it.
   */
  private async runGeneration(prompt: string, baseImageUrl: string | undefined, vin: string, turnId: number): Promise<void> {
    const placeholderId = `gen_${this.turnCounter}_${Date.now()}`;
    const pending: ViewState = {
      layout: "single",
      items: [{ kind: "generated", id: placeholderId, prompt, status: "pending" }]
    };
    this.viewState = pending;
    this.publishViewUpdate(pending);
    console.log(`Vox turn #${turnId} [generate] start (base=${baseImageUrl ?? "none"}): ${prompt.slice(0, 90)}`);
    try {
      const { id, url } = await generateVisualization({ prompt, baseImageUrl, vin });
      const ready: ViewState = {
        layout: "single",
        items: [{ kind: "generated", id, prompt, status: "ready", url }]
      };
      this.viewState = ready;
      this.publishViewUpdate(ready);
      console.log(`Vox turn #${turnId} [generate] ready → ${url}`);
    } catch (err) {
      console.warn(`Vox turn #${turnId} [generate] failed: ${err instanceof Error ? err.message : String(err)}`);
      const failed: ViewState = {
        layout: "single",
        items: [{ kind: "generated", id: placeholderId, prompt, status: "failed" }]
      };
      this.viewState = failed;
      this.publishViewUpdate(failed);
    }
  }

  // Speak a deterministic, voice-first opener once when the conversation
  // starts — so the first thing the shopper hears is a real greeting, not a
  // phantom turn that ends up describing whatever photo happens to be loaded.
  override async onEnter(): Promise<void> {
    try {
      // Reconnect within the same session → a quick re-prompt, not the full
      // intro. First connect → a short, warm opener (interruptible either way).
      const car = await getCar(DEFAULT_VIN);
      const model = car ? `${car.make} ${car.model}` : "M4";
      const greeting = this.returning
        ? "How can I help you?"
        : `Hey, welcome — I'm Vox. What would you like to know about this ${model}?`;
      // Use the same reply_done protocol every other turn uses, so the greeting
      // reliably renders in the chat log (the legacy specialist_turn.reply field
      // is no longer read by the web).
      publishSpecialistDataAsync(this.ctx, { type: "reply_done", reply: greeting });
      this.session.say(greeting, { allowInterruptions: true });
    } catch (error) {
      console.warn(`greeting failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  override async llmNode(chatCtx: llm.ChatContext): Promise<ReadableStream<string> | null> {
    const message = latestUserText(chatCtx);
    // Empty/unintelligible turn — stay silent rather than nagging "didn't catch that".
    if (!message) return textStream("");

    const detectedPhone = extractPhoneNumber(message);
    if (detectedPhone) this.customerPhone = detectedPhone;
    const normalized = message.toLowerCase().replace(/\s+/g, " ").trim();
    const draftNormalized = this.bookingDraft.toLowerCase().replace(/\s+/g, " ").trim();
    const draftHasBookingIntent = looksLikeBookingRequest(draftNormalized);
    const shouldUseDraft = draftHasBookingIntent && isAffirmation(normalized);
    const shouldTrackBooking = looksLikeBookingFragment(normalized, !!detectedPhone);
    const bookingCandidate = shouldTrackBooking || shouldUseDraft ? `${this.bookingDraft} ${message}`.trim() : message;
    if (shouldTrackBooking) {
      this.bookingDraft = bookingCandidate.slice(-1_200);
      const draftPhone = extractPhoneNumber(this.bookingDraft);
      if (draftPhone) this.customerPhone = draftPhone;
    }

    const wordCount = normalized.split(" ").filter(Boolean).length;
    const now = Date.now();
    // Dedupe identical back-to-back finals (rapid STT re-submissions of the same text).
    if (normalized === this.lastHandled && now - this.lastHandledAt < 1_200) {
      return textStream("");
    }
    // Turn-gate: while Vox is speaking, ignore short fragments — these are
    // almost always self-echo or bystander cross-talk picked up by the
    // always-on mic. A real interruption needs >= 3 words (matching the
    // session's interruption.minWords), so deliberate barge-in still lands.
    if (this.speaking && wordCount < 3) {
      return textStream("");
    }
    this.lastHandled = normalized;
    this.lastHandledAt = now;
    const turnId = ++this.turnCounter;
    console.log(`Vox turn #${turnId}: ${message}`);

    let car: Car | undefined;
    let images: CarImage[] = [];
    try {
      [car, images] = await Promise.all([getCar(DEFAULT_VIN), listImages(DEFAULT_VIN)]);
      if (!car) return textStream("I can't find this vehicle right now.");

      // Publish the transcript for the chat HUD.
      publishSpecialistDataAsync(this.ctx, { type: "specialist_turn", vin: DEFAULT_VIN, transcript: message });

      if (looksLikeBookingRequest(normalized) || draftHasBookingIntent) {
        const details = parseBookingDetails(bookingCandidate);
        const parsedBooking = details.parsedBooking;
        if (details.phone) this.customerPhone = details.phone;
        if (!parsedBooking || parsedBooking.hour24 < 11 || parsedBooking.hour24 > 15 || !this.customerPhone) {
          this.bookingDraft = bookingCandidate.slice(-1_200);
          publishSpecialistDataAsync(this.ctx, { type: "booking_pending" });
          const reply = bookingFollowupPrompt({ ...details, phone: this.customerPhone });
          publishSpecialistDataAsync(this.ctx, { type: "reply_done", reply });
          return textStream(reply);
        }

        console.log(`Booking tool matched: ${parsedBooking.normalizedLabel} ${this.customerPhone ?? "no phone"}`);
        publishSpecialistDataAsync(this.ctx, {
          type: "agent_status",
          status: "booking",
          transcript: message
        });
        const booking = await bookTestDriveAndNotify({ car, phone: this.customerPhone, parsedBooking });
        this.bookingDraft = "";
        publishSpecialistDataAsync(this.ctx, {
          type: "booking_confirmed",
          slot: booking.slot,
          carLabel: `${car.year} ${car.make} ${car.model}`,
          phone: this.customerPhone,
          smsStatus: booking.sms?.status
        });
        if (booking.sms) {
          publishSpecialistDataAsync(this.ctx, {
            type: "specialist_turn",
            vin: DEFAULT_VIN,
            transcript: message,
            smsSid: booking.sms.sid,
            smsStatus: booking.sms.status,
            smsProvider: booking.sms.provider
          });
        }
        publishSpecialistDataAsync(this.ctx, { type: "reply_done", reply: booking.reply });
        return textStream(booking.reply);
      }

      const resolvedCar = car;
      const resolvedImages = images;
      const recentTurns = this.history.slice(-6);

      // ── SINGLE BRAIN (default) ───────────────────────────────────────────
      // ONE Cerebras call decides the spoken reply AND the canvas actions
      // together, so the words and the picture come from the same decision and
      // can never disagree. Returns early; the two-call path below only runs in
      // "double" mode.
      if (this.brainMode === "single") {
        const { reply, actions } = await decideTurn({
          message,
          viewState: this.viewState,
          car: resolvedCar,
          images: resolvedImages,
          recentTurns
        });
        let finalActs = actions;
        if (finalActs.length === 0) {
          const hinted = planCanvas(message, resolvedImages, this.viewState);
          if (hinted.length > 0) finalActs = hinted;
        }
        // `generate` (Nano Banana) is async + slow — split it out and run it on a
        // non-blocking lane (shows a shimmer placeholder, then the result). The
        // rest of the actions apply synchronously as usual.
        const genActs = finalActs.filter((a) => a.op === "generate");
        const syncActs = finalActs.filter((a) => a.op !== "generate");
        if (syncActs.length > 0) {
          let nextView = this.viewState;
          const catalog = { images: resolvedImages, cars: [resolvedCar] };
          for (const act of syncActs) nextView = applyAction(nextView, act, catalog);
          this.viewState = nextView;
          this.publishViewUpdate(nextView);
          console.log(`Vox turn #${turnId} [single] canvas: layout=${nextView.layout} items=${nextView.items.length} ops=[${syncActs.map((a) => a.op).join(",")}]`);
        } else if (genActs.length === 0) {
          // Nothing to show this turn → return to the overview hero.
          this.revertToOverview(turnId, "[single]");
        }
        for (const g of genActs) {
          if (g.op !== "generate") continue;
          const baseUrl = resolveBaseImageUrl(g.baseRef, this.viewState, resolvedImages);
          void this.runGeneration(g.prompt, baseUrl, resolvedCar.vin, turnId);
        }
        const spoken = reply.trim() || FALLBACK_REPLY;
        publishSpecialistDataAsync(this.ctx, { type: "reply_delta", text: spoken });
        publishSpecialistDataAsync(this.ctx, { type: "reply_done", reply: spoken });
        this.recordTurn(message, spoken);
        console.log(`Vox turn #${turnId} [single] reply: ${spoken}`);
        return textStream(spoken);
      }

      // ── TWO INDEPENDENT CEREBRAS CALLS (brainMode === "double") ──────────
      // One call speaks, one call drives the canvas. They run in parallel, each
      // on its own key via the revolver, fully decoupled: the canvas call never
      // blocks voice, and decideCanvas returns [] on any failure so a canvas
      // problem can't break speech (and vice-versa).

      // CANVAS LANE — fire-and-forget; resolves on its own, publishes view_update.
      void decideCanvas({ message, viewState: this.viewState, car: resolvedCar, images: resolvedImages, recentTurns })
        .then((actions) => {
          // Safety net: model narrated a visual but emitted no actions → backfill
          // from the instant heuristic so the canvas never lies.
          let finalActs = actions;
          if (finalActs.length === 0) {
            const hinted = planCanvas(message, resolvedImages, this.viewState);
            if (hinted.length > 0) finalActs = hinted;
          }
          if (finalActs.length > 0) {
            let nextView = this.viewState;
            const catalog = { images: resolvedImages, cars: [resolvedCar] };
            for (const act of finalActs) nextView = applyAction(nextView, act, catalog);
            this.viewState = nextView;
            this.publishViewUpdate(nextView);
            console.log(`Vox turn #${turnId} canvas: published view_update layout=${nextView.layout} items=${nextView.items.length} ops=[${finalActs.map((a) => a.op).join(",")}]`);
          } else {
            // Nothing to show this turn → return to the overview hero.
            this.revertToOverview(turnId, "[double]");
          }
        })
        .catch((err) => {
          console.warn(`Vox turn #${turnId} canvas lane error: ${err instanceof Error ? err.message : String(err)}`);
        });

      // VOICE LANE — Cerebras spoken reply (~1s), separate from the canvas call so
      // voice never waits on it. TTS turns this into the agent's audio track,
      // which the browser pipes into Simli for lip-sync.
      const replyText = await generateSpokenReply({ message, car: resolvedCar, recentTurns });
      const spoken = replyText.trim() || FALLBACK_REPLY;
      publishSpecialistDataAsync(this.ctx, { type: "reply_delta", text: spoken });
      publishSpecialistDataAsync(this.ctx, { type: "reply_done", reply: spoken });
      this.recordTurn(message, spoken);
      console.log(`Vox turn #${turnId} reply: ${spoken}`);
      return textStream(spoken);
    } catch (error) {
      // ── SPEECH-CALL FAILURE FALLBACK (e.g. all keys 429) ─────────────────
      // Run the instant heuristic for the canvas and speak a short templated
      // line. The canvas lane above is independent and may already have fired.
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`generateSpokenReply failed (${detail}), using heuristic fallback`);

      let fallbackLine = FALLBACK_REPLY;
      try {
        if (car) {
          const fallbackActions = planCanvas(message, images, this.viewState);
          if (fallbackActions.length > 0) {
            // Derive a short templated line from the first action op.
            const firstOp = fallbackActions[0]?.op;
            if (firstOp === "showImages") {
              fallbackLine = "Here are a few angles for you.";
            } else if (firstOp === "zoom") {
              fallbackLine = "Here's a closer look.";
            } else if (firstOp === "showImage") {
              fallbackLine = "Here you go.";
            }
            let nextView = this.viewState;
            const catalog = { images, cars: [car] };
            for (const act of fallbackActions) nextView = applyAction(nextView, act, catalog);
            this.viewState = nextView;
            this.publishViewUpdate(nextView);
          }
        }
      } catch {
        // ignore fallback canvas errors — voice still answers
      }

      this.recordTurn(message, fallbackLine);
      publishSpecialistDataAsync(this.ctx, { type: "reply_done", reply: fallbackLine });
      return textStream(fallbackLine);
    }
  }

  /** Append a turn to the rolling history fed to the decider (capped at 12). */
  private recordTurn(userText: string, assistantText: string): void {
    this.history.push({ role: "user", text: userText }, { role: "assistant", text: assistantText });
    if (this.history.length > 12) this.history = this.history.slice(-12);
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
    let isReturning = false;
    let brainMode: "single" | "double" = "single";
    try {
      const raw = ctx.job.metadata;
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed.profileId === "string") {
          profileId = parsed.profileId;
        }
        if (parsed.returning === true) isReturning = true;
        if (parsed.brainMode === "double") brainMode = "double";
      }
    } catch {
      // malformed metadata — use default
    }
    console.log(`Vox brain mode: ${brainMode}`);
    const profile = resolveModelProfile(profileId ?? DEFAULT_MODEL_PROFILE_ID);
    console.log(`Vox profile: ${profile.id} (llm=${profile.llmModel}, tts=${profile.ttsModel})`);

    // Cartesia TTS via LiveKit Inference — copied verbatim from the avatar branch
    // (hackathon-snapshot) where the Simli lip-sync flow worked cleanly. Uses the
    // plain "cartesia/<model>:<voiceId>" string form with NO modelOptions: the
    // earlier `modelOptions: { speed: "fast" }` produced audio that came out
    // garbled once piped through Simli's resampler. Default Cartesia pacing is
    // what Simli expects.
    const ttsString = `cartesia/${profile.ttsModel}:${CARTESIA_VOICE}`;

    const specialist = new VoxSpecialistVoiceAgent(ctx, profile.llmModel, isReturning, brainMode);

    // Seed the initial ViewState from the overview image so the canvas shows
    // something meaningful the moment the session connects.
    void listImages(DEFAULT_VIN)
      .then((images) => {
        const overview = selectOverviewImage(images) ?? images[0];
        if (overview) {
          specialist.setInitialViewState({
            layout: "single",
            items: [{ kind: "image", carId: overview.vin, imageId: overview.id }]
          });
        }
      })
      .catch((error) => console.warn(`Could not seed initial ViewState: ${error instanceof Error ? error.message : String(error)}`));

    // -----------------------------------------------------------------------
    // Deepgram nova-3 STT via LiveKit Inference — billed on LiveKit credits,
    // no Deepgram API key required. modelOptions.keyterms boosts recognition
    // of the M4 domain vocabulary (our Wispr-Flow accuracy goal).
    // -----------------------------------------------------------------------
    const sttOption = new inference.STT<"deepgram/nova-3">({
      model: "deepgram/nova-3",
      language: "en",
      // keyterms only — known-good.
      // smart_format and numerals were reverted: an unsupported modelOption on
      // the LiveKit nova-3 Inference gateway can silently drop the entire STT
      // stream, killing transcription for the session. Re-add ONLY after
      // verifying in a live Inference session (not locally) that these flags
      // are accepted by the gateway version deployed in production.
      modelOptions: { keyterms: M4_KEYTERMS }
    });

    const session = new voice.AgentSession({
      stt: sttOption,
      llm: new voice.testing.FakeLLM(),
      tts: ttsString,
      userAwayTimeout: null,
      turnHandling: {
        // "stt" uses Deepgram's end-of-speech signal then applies our minDelay.
        // No silero VAD or EOU-model plugin is installed in this repo, so "vad"
        // and the dynamic EOU predictor are both unavailable — "stt" + fixed
        // endpointing is the correct mode. "dynamic" mode ONLY helps when an
        // EOU confidence model is present; without one it silently falls back to
        // flat behaviour identical to "fixed", so the "dynamic" label was
        // misleading. Using "fixed" explicitly so intent is clear.
        turnDetection: "stt",
        // minDelay 1300ms: Deepgram nova-3 fires its end-of-speech signal
        // before the speaker is actually done on short pauses ("show me the,
        // uh, gear shifter"). 800ms clipped the tail of slower utterances;
        // 1300ms holds the turn open through typical within-sentence pauses
        // without feeling laggy. App-layer dedup (lastHandled + 1200ms guard)
        // catches any duplicate finals that still slip through.
        endpointing: {
          mode: "fixed",
          minDelay: 1300,
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
      // Gate short echo/cross-talk turns while Vox is mid-sentence.
      specialist.setSpeaking(event.newState === "speaking");
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

const AGENT_PORT = Number(process.env.LIVEKIT_AGENT_PORT ?? 8081);
console.log(
  `🚗 Vox agent — two-call brain (separate speech + canvas Cerebras calls) — registering as "${AGENT_NAME}" on port ${AGENT_PORT}`
);
cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName: AGENT_NAME,
  logLevel: "info",
  port: AGENT_PORT
}));
