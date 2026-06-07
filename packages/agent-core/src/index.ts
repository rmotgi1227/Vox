import type {
  BBox,
  CanvasAction,
  CanvasItem,
  Car,
  CarImage,
  ImageRole,
  ItemFilter,
  ItemRef,
  Polygon,
  SpecialistSource,
  SpecialistTurn,
  ViewState
} from "@vox/core";

export type CatalogStore = {
  getCar(vin: string): Promise<Car | undefined>;
  listImages(vin: string): Promise<CarImage[]>;
};

export type MossSearchResult = {
  id: string;
  label: string;
  text: string;
  score?: number;
  docType?: "catalog" | "image" | "unknown";
  metadata?: Record<string, string>;
};

export type AiProvider = {
  searchMoss(query: string, vin: string): Promise<MossSearchResult[]>;
  planTurn?(input: {
    car: Car;
    images: CarImage[];
    message: string;
    currentImageId?: string;
    mossResults: MossSearchResult[];
  }): Promise<{
    reply: string;
    selectedImageId?: string | null;
    actionReason?: string;
  }>;
  generateReply(input: {
    car: Car;
    images: CarImage[];
    message: string;
    selectedImage?: CarImage;
    mossResults: MossSearchResult[];
  }): Promise<string>;
};

export type SpecialistDependencies = {
  catalog: CatalogStore;
  ai: AiProvider;
};

// Minimum rank score for the rule-7 generic "showImage top-ranked" fallback to
// fire. On-topic matches score high (navigation ~99, seats ~153, brakes ~76); a
// tangential one — a pricing/financing question grabbing a random speaker
// close-up — scores ~2. Below this, planCanvas returns [] so the canvas reverts
// to the overview hero instead of surfacing an irrelevant photo.
const MIN_DEFAULT_SHOW_SCORE = 3;

const ROLE_KEYWORDS: Array<{ role: ImageRole; terms: string[] }> = [
  { role: "trunk", terms: ["trunk", "cargo", "storage", "boot", "luggage"] },
  { role: "interior_front", terms: ["interior", "inside", "seat", "seats", "cabin", "front", "console"] },
  { role: "interior_rear", terms: ["rear seat", "back seat", "second row", "rear interior"] },
  { role: "dashboard", terms: ["dash", "dashboard", "screen", "display", "cockpit", "infotainment"] },
  { role: "wheel", terms: ["wheel", "wheels", "rim", "tire", "brake", "caliper"] },
  { role: "exterior_rear", terms: ["rear", "back", "taillight", "tail light"] },
  { role: "exterior_front", terms: ["front", "outside", "exterior", "headlight", "paint"] },
  { role: "detail", terms: ["button", "buttons", "control", "controls", "close up", "detail", "badge", "speaker", "keys", "paperwork", "engine", "hud", "head-up", "mirror", "roof"] }
];

const VEHICLE_QUERY_ALIASES: Array<{ triggers: string[]; aliases: string[] }> = [
  {
    triggers: ["entire car", "whole car", "full car", "entire vehicle", "whole vehicle", "full vehicle", "all of the car", "full exterior", "overview"],
    aliases: ["wide exterior", "front three quarter", "rear three quarter", "side profile", "coupe body", "full view", "exterior overview"]
  },
  {
    triggers: ["stick", "gear stick", "gearstick", "shifter", "shift lever", "gear selector", "gear lever", "transmission selector"],
    aliases: ["gear selector", "shifter", "center console", "console controls", "transmission selector", "iDrive controller"]
  },
  {
    triggers: ["screen", "nav", "navigation", "map", "infotainment"],
    aliases: ["infotainment screen", "navigation map", "iDrive screen", "dashboard display", "center display"]
  },
  {
    triggers: ["roof", "sunroof", "moonroof", "top"],
    aliases: ["carbon fiber roof", "fixed roof", "roof panel", "shark fin antenna", "no glass sunroof"]
  },
  {
    triggers: ["buttons", "controls", "switches"],
    aliases: ["button bank", "control button", "driver controls", "center console controls", "dashboard controls"]
  }
];

const STOP_WORDS = new Set([
  "about",
  "again",
  "are",
  "can",
  "car",
  "does",
  "for",
  "have",
  "here",
  "how",
  "is",
  "it",
  "look",
  "looks",
  "me",
  "of",
  "on",
  "show",
  "tell",
  "that",
  "the",
  "this",
  "to",
  "what",
  "with",
  "you"
]);

const SPATIAL_QUERY_TERMS = new Set([
  "below",
  "beneath",
  "driver",
  "drivers",
  "lower",
  "near",
  "under",
  "where"
]);

type RankedImage = {
  image: CarImage;
  score: number;
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phrasePresent(text: string, phrase: string): boolean {
  const normalizedText = ` ${normalize(text)} `;
  const normalizedPhrase = normalize(phrase);
  if (!normalizedPhrase) return false;
  return normalizedText.includes(` ${normalizedPhrase} `);
}

function expandVehicleQuery(message: string): string {
  const aliases = VEHICLE_QUERY_ALIASES
    .filter((entry) => entry.triggers.some((trigger) => phrasePresent(message, trigger)))
    .flatMap((entry) => entry.aliases);
  return [message, ...aliases].join(" ");
}

function terms(text: string): string[] {
  return normalize(text)
    .split(" ")
    .map((term) => {
      if (term.endsWith("ies") && term.length > 5) return `${term.slice(0, -3)}y`;
      if (term.endsWith("s") && term.length > 4) return term.slice(0, -1);
      return term;
    })
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term));
}

function ngrams(words: string[], size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i <= words.length - size; i += 1) {
    out.push(words.slice(i, i + size).join(" "));
  }
  return out;
}

function allTermsPresent(words: string[], text: string): boolean {
  return words.length > 0 && words.every((word) => text.includes(word));
}

function imageSearchText(image: CarImage): string {
  return normalize([
    image.role,
    image.viewpoint ?? "",
    image.caption,
    image.visibleFeatures.join(" "),
    (image.conditionNotes ?? []).join(" "),
    (image.searchTags ?? []).join(" "),
    (image.likelyQuestions ?? []).join(" "),
    image.url
  ].join(" "));
}

function label(text: string): string {
  return text.replaceAll("_", " ");
}

function shortList(items: string[], max = 4): string {
  return items.slice(0, max).join(", ");
}

function hasAnyTerm(message: string, words: string[]): boolean {
  return words.some((word) => phrasePresent(message, word));
}

function matchingNegativeEvidence(message: string, image: CarImage): string | undefined {
  const queryTerms = new Set(terms(message));
  const negativeItems = [
    ...image.visibleFeatures,
    ...(image.conditionNotes ?? []),
    ...(image.searchTags ?? [])
  ].filter((item) => /^no\b/i.test(item.trim()) || /\bnot\b/i.test(item));

  return negativeItems.find((item) => terms(item).some((term) => queryTerms.has(term)));
}

function positiveFeatures(image: CarImage): string[] {
  return image.visibleFeatures.filter((item) => !/^no\b/i.test(item.trim()) && !/\bnot\b/i.test(item));
}

function isCasualGreeting(message: string): boolean {
  const normalized = normalize(message);
  const words = terms(message);
  if (words.length > 5) return false;
  return /^(hey|hi|hello|yo|sup|good morning|good afternoon|good evening)\b/.test(normalized) ||
    /^(how s it going|how are you|what s up|whats up)\b/.test(normalized);
}

export function composeImageEvidenceReply(input: {
  car: Car;
  message: string;
  selectedImage?: CarImage;
}): string | undefined {
  const image = input.selectedImage;
  if (!image) return undefined;

  const visualIntent = hasAnyTerm(input.message, [
    "show",
    "see",
    "look",
    "photo",
    "image",
    "picture",
    "view",
    "does",
    "is",
    "are",
    "condition",
    "wear",
    "big",
    "size",
    "space",
    "capacity",
    "fit",
    "inspect"
  ]);
  if (!visualIntent) return undefined;

  const negative = matchingNegativeEvidence(input.message, image);
  const detail = shortList(positiveFeatures(image), 4);
  const conditions = shortList(image.conditionNotes ?? [], 2);
  const imageText = imageSearchText(image);
  const missingQuestionTerms = terms(input.message).filter((term) => !SPATIAL_QUERY_TERMS.has(term) && !imageText.includes(term));
  const descriptiveQuestion = /^(what|where|which)\b/.test(normalize(input.message));

  if (hasAnyTerm(input.message, ["big", "size", "space", "capacity", "dimensions", "measurement", "fit"])) {
    return `I do not have the exact measurement yet; this ${label(image.role)} view shows ${detail}.`;
  }

  if (negative) {
    const noPhrase = negative.replace(/^no\s+/i, "");
    return `No ${noPhrase}; this ${label(image.role)} view shows ${detail}.`;
  }

  if (hasAnyTerm(input.message, ["condition", "wear", "clean", "damage", "scratch", "scuff", "dent", "chip"])) {
    return conditions
      ? `This ${label(image.role)} view shows ${conditions}.`
      : `This ${label(image.role)} view shows ${detail}.`;
  }

  if (!descriptiveQuestion && hasAnyTerm(input.message, ["does", "is", "are", "have", "has"])) {
    if (missingQuestionTerms.length > 0) {
      return `I do not see ${missingQuestionTerms.join(" ")} in this photo; this ${label(image.role)} view shows ${detail}.`;
    }
    return `Yes, this ${label(image.role)} view shows ${detail}.`;
  }

  return `Here is the ${label(image.role)} view: ${detail}.`;
}

function intendedRoles(message: string): ImageRole[] {
  const steeringWheel = phrasePresent(message, "steering wheel");
  const roles = ROLE_KEYWORDS
    .filter((candidate) => candidate.terms.some((term) => phrasePresent(message, term)))
    .map((candidate) => candidate.role);
  return roles.filter((role) => {
    if (role !== "wheel" || !steeringWheel) return true;
    return ["rim", "rims", "tire", "tires", "tyre", "tyres", "brake", "brakes", "caliper", "calipers", "alloy", "wheels"].some((term) => phrasePresent(message, term));
  });
}

export function scoreImageForQuestion(message: string, image: CarImage): number {
  if (image.status !== "processed") return 0;

  const expandedMessage = expandVehicleQuery(message);
  const query = normalize(expandedMessage);
  const originalQuery = normalize(message);
  const words = terms(expandedMessage);
  const compactQuery = words.join(" ");
  if (!query || words.length === 0) return 0;

  const text = imageSearchText(image);
  const textWords = new Set(text.split(" "));
  const asksForSteeringWheelArea = phrasePresent(message, "steering wheel");
  const asksForLowerDriverArea = /\b(under|below|beneath|lower|knee|footwell|pedal|pedals|column|stalk|button|buttons|control|controls)\b/.test(originalQuery);
  const asksForWholeVehicle = ["entire car", "whole car", "full car", "entire vehicle", "whole vehicle", "full vehicle", "all of the car", "full exterior", "overview"].some((term) => phrasePresent(message, term));
  const asksForGearSelector = ["stick", "gear stick", "gearstick", "shifter", "shift lever", "gear selector", "gear lever", "transmission selector"].some((term) => phrasePresent(message, term));
  let score = 0;

  for (const word of words) {
    if (textWords.has(word)) score += 1.2;
    else if (text.includes(word)) score += 0.4;
  }

  const roleIntent = intendedRoles(message);
  if (roleIntent.includes(image.role)) score += 9;
  else if (roleIntent.length > 0 && image.role === "detail") score -= 1.5;
  if (roleIntent.includes("wheel") && image.role === "detail" && !asksForSteeringWheelArea) score -= 18;

  if (asksForSteeringWheelArea && asksForLowerDriverArea) {
    if (image.role === "detail") score += 7;
    if (/\b(steering column|heated steering wheel|lower dashboard|lower dash|footwell|pedal|pedals|knee|stalk|control button|driver controls)\b/.test(text)) score += 12;
    if (/\b(steering column adjustment|heated steering wheel button|driver footwell|pedal area|knee panel)\b/.test(text)) score += 8;
    if (/\b(start stop|ignition button|auto start stop)\b/.test(text) && !/\b(start|ignition)\b/.test(query)) score -= 6;
    if (image.role === "wheel") score -= 12;
    if (image.role === "interior_front" && !/\b(footwell|lower|column|stalk|button|control)\b/.test(text)) score -= 4;
  } else if (asksForSteeringWheelArea && image.role === "wheel") {
    score -= 10;
  }

  if (asksForWholeVehicle) {
    if (image.role === "exterior_front" || image.role === "exterior_rear") score += 14;
    if (/\b(wide|three quarter|side profile|coupe body|exterior view|full view|front fascia|rear quarter)\b/.test(text)) score += 9;
    if (image.role === "wheel" || image.role === "detail" || image.role.startsWith("interior")) score -= 10;
  }

  if (asksForGearSelector) {
    if (/\b(gear selector|shifter|shift lever|transmission selector|center console|iDrive controller|console controls)\b/.test(text)) score += 18;
    if (image.role === "interior_front" || image.role === "detail") score += 4;
    if (image.role.startsWith("exterior") || image.role === "wheel" || image.role === "trunk") score -= 10;
  }

  for (const phrase of [...ngrams(words, 2), ...ngrams(words, 3)]) {
    if (text.includes(phrase)) score += phrase.split(" ").length * 2;
  }

  if (compactQuery && text.includes(compactQuery)) score += 5;

  for (const field of [image.caption, image.viewpoint ?? ""]) {
    const fieldText = normalize(field);
    if (fieldText.includes(compactQuery) || allTermsPresent(words, fieldText)) score += 5;
  }

  for (const question of image.likelyQuestions ?? []) {
    const normalizedQuestion = normalize(question);
    if (!normalizedQuestion) continue;
    if (normalizedQuestion === query) score += 18;
    else if (normalizedQuestion.includes(query) || query.includes(normalizedQuestion)) score += 8;
    else if (compactQuery && normalizedQuestion.includes(compactQuery)) score += 9;
    else if (allTermsPresent(words, normalizedQuestion)) score += 7;
  }

  for (const feature of image.visibleFeatures) {
    const featureText = normalize(feature);
    if (!featureText) continue;
    if (query.includes(featureText) || featureText.includes(query)) score += 7;
    else if (compactQuery && featureText.includes(compactQuery)) score += 8;
    else if (allTermsPresent(words, featureText)) score += 6;
  }

  for (const tag of image.searchTags ?? []) {
    const tagText = normalize(tag);
    if (!tagText) continue;
    if (query.includes(tagText) || tagText.includes(query)) score += 6;
    else if (compactQuery && tagText.includes(compactQuery)) score += 8;
    else if (allTermsPresent(words, tagText)) score += 6;
  }

  for (const note of image.conditionNotes ?? []) {
    const noteText = normalize(note);
    if (!noteText) continue;
    if (compactQuery && noteText.includes(compactQuery)) score += 4;
    else if (allTermsPresent(words, noteText)) score += 3;
  }

  if (score > 0 && image.role === "detail" && roleIntent.length === 0) score += 1.5;
  return score;
}

export function rankImagesForQuestion(
  message: string,
  images: CarImage[],
  mossResults: MossSearchResult[] = []
): RankedImage[] {
  const mossBoosts = new Map<string, number>();
  mossResults.forEach((result, index) => {
    const imageId = result.metadata?.image_id ?? (result.docType === "image" ? result.id.replace(/^image:/, "") : undefined);
    if (!imageId) return;
    const boost = Math.max(1, 5 - index * 0.75);
    mossBoosts.set(imageId, Math.max(mossBoosts.get(imageId) ?? 0, boost));
  });

  return images
    .map((image) => ({
      image,
      score: scoreImageForQuestion(message, image) + (mossBoosts.get(image.id) ?? 0)
    }))
    .filter((item) => item.score > 0 && item.image.status === "processed")
    .sort((a, b) => b.score - a.score || b.image.confidence - a.image.confidence);
}

export function selectImageForQuestion(
  message: string,
  images: CarImage[],
  currentImageId?: string
): CarImage | undefined {
  const ranked = rankImagesForQuestion(message, images);
  if (ranked[0]) return ranked[0].image;

  const lower = message.toLowerCase();
  for (const candidate of ROLE_KEYWORDS) {
    if (!candidate.terms.some((term) => lower.includes(term))) continue;
    const image = images.find((item) => item.status === "processed" && item.role === candidate.role);
    if (image) return image;
  }

  const featureMatch = images.find((item) =>
    item.status === "processed" &&
    item.visibleFeatures.some((feature) => lower.includes(feature.toLowerCase()))
  );
  if (featureMatch) return featureMatch;

  return images.find((item) => item.id === currentImageId) ?? images[0];
}

// Tags/phrases that signal a wide, full-length "general car" exterior shot —
// the kind you'd lead a listing with — versus a tight close-up or detail crop.
const OVERVIEW_TERMS = [
  "whole car",
  "entire car",
  "full car",
  "full exterior",
  "wide exterior",
  "exterior overview",
  "dealership exterior",
  "three quarter",
  "three-quarter",
  "side profile",
  "coupe profile",
  "stance"
];
const CLOSEUP_TERMS = ["close-up", "close up", "closeup", "detail", "macro", "badge", "emblem"];

/**
 * Pick the best general, full-length exterior image to show first — a wide
 * three-quarter / profile "whole car" shot. Scores processed exterior photos by
 * overview vocabulary in their tags, viewpoint, and caption, penalizing tight
 * close-ups. Falls back to any exterior photo, then the first processed image.
 */
export function selectOverviewImage(images: CarImage[]): CarImage | undefined {
  const processed = images.filter((image) => image.status === "processed");
  const exteriors = processed.filter(
    (image) => image.role === "exterior_front" || image.role === "exterior_rear"
  );

  const scored = exteriors
    .map((image) => {
      const haystack = [
        image.viewpoint,
        image.caption,
        ...(image.searchTags ?? [])
      ]
        .join(" ")
        .toLowerCase();
      let score = OVERVIEW_TERMS.reduce((sum, term) => (haystack.includes(term) ? sum + 1 : sum), 0);
      if (CLOSEUP_TERMS.some((term) => haystack.includes(term))) score -= 3;
      if (image.role === "exterior_front") score += 0.5; // prefer a front-led hero over rear
      return { image, score };
    })
    .sort((a, b) => b.score - a.score || b.image.confidence - a.image.confidence);

  if (scored[0] && scored[0].score > 0) return scored[0].image;
  return exteriors[0] ?? processed[0] ?? images[0];
}

export async function orchestrateSpecialistTurn(
  deps: SpecialistDependencies,
  input: { vin: string; message: string; currentImageId?: string }
): Promise<SpecialistTurn> {
  const car = await deps.catalog.getCar(input.vin);
  if (!car) {
    return {
      reply: "I could not find that vehicle in the current catalog.",
      action: { type: "show_overview" },
      sources: [{ type: "fallback", id: input.vin, label: "Missing vehicle" }]
    };
  }

  const images = await deps.catalog.listImages(input.vin);
  const mossResults = await deps.ai.searchMoss(input.message, input.vin);

  if (deps.ai.planTurn) {
    const plan = await deps.ai.planTurn({
      car,
      images,
      message: input.message,
      currentImageId: input.currentImageId,
      mossResults
    });
    const selectedImage = plan.selectedImageId
      ? images.find((image) => image.id === plan.selectedImageId && image.status === "processed")
      : undefined;
    const sources: SpecialistSource[] = [
      { type: "catalog", id: car.vin, label: `${car.year} ${car.make} ${car.model}` },
      ...mossResults.slice(0, 3).map((result) => ({ type: "moss" as const, id: result.id, label: result.label }))
    ];
    if (selectedImage) sources.push({ type: "image", id: selectedImage.id, label: selectedImage.caption || selectedImage.role });
    const shouldChangeImage = selectedImage && selectedImage.id !== input.currentImageId;
    return {
      reply: plan.reply,
      selectedImageId: selectedImage?.id ?? input.currentImageId,
      action: shouldChangeImage
        ? { type: "show_image", imageId: selectedImage.id, reason: plan.actionReason || selectedImage.caption }
        : { type: "keep_current_image" },
      sources
    };
  }

  if (isCasualGreeting(input.message)) {
    return {
      reply: "Hey, I’m here. What do you want to see or know about this M4?",
      selectedImageId: input.currentImageId ?? images[0]?.id,
      action: { type: "keep_current_image" },
      sources: [{ type: "catalog", id: car.vin, label: `${car.year} ${car.make} ${car.model}` }]
    };
  }

  const selectedImage = rankImagesForQuestion(input.message, images, mossResults)[0]?.image ??
    selectImageForQuestion(input.message, images, input.currentImageId);
  const reply = composeImageEvidenceReply({ car, message: input.message, selectedImage }) ?? await deps.ai.generateReply({
    car,
    images,
    message: input.message,
    selectedImage,
    mossResults
  });
  const sources: SpecialistSource[] = [
    { type: "catalog", id: car.vin, label: `${car.year} ${car.make} ${car.model}` },
    ...mossResults.slice(0, 3).map((result) => ({ type: "moss" as const, id: result.id, label: result.label }))
  ];

  if (selectedImage) {
    sources.push({ type: "image", id: selectedImage.id, label: selectedImage.caption || selectedImage.role });
  }

  const hasImageIntent = selectedImage && selectedImage.id !== input.currentImageId;
  return {
    reply,
    selectedImageId: selectedImage?.id,
    action: hasImageIntent
      ? { type: "show_image", imageId: selectedImage.id, reason: selectedImage.caption }
      : { type: "keep_current_image" },
    sources
  };
}

// ── Canvas agent foundation (Phase 0) ────────────────────────────────────────

type Catalog = { images: CarImage[]; cars: Car[] };

/**
 * Resolve an ItemRef to a CanvasItem (image kind) using the catalog and the
 * current ViewState. Returns undefined when the ref cannot be resolved.
 */
function resolveItemRef(ref: ItemRef, catalog: Catalog, state: ViewState): CanvasItem | undefined {
  if ("index" in ref) {
    const item = state.items[ref.index];
    return item;
  }
  // Match by imageId ALONE — ids are globally unique, and the LLM frequently
  // emits the wrong carId (e.g. the 17-char VIN from the fact sheet instead of
  // the catalog key). Requiring carId to match was silently dropping every
  // zoom/compare. Use the image's real vin so downstream stays consistent.
  const image = catalog.images.find((img) => img.id === ref.imageId);
  if (!image) return undefined;
  return { kind: "image", carId: image.vin, imageId: image.id };
}

/**
 * Filter the catalog images by optional carId/role/feature/tags and map the
 * survivors to `{ kind: "image" }` CanvasItems, capped at `limit`.
 *
 * - `feature` is a case-insensitive substring search across caption,
 *   visibleFeatures, and searchTags.
 * - `tags` filters images that contain at least one of the given tags
 *   (case-insensitive substring match against searchTags).
 *
 * Candidates are sorted by `confidence` descending before slicing so the
 * strongest shots appear first in any grid — deterministically, regardless of
 * catalog insertion order.
 */
export function selectItems(
  catalog: Catalog,
  filter: ItemFilter,
  limit = 4
): CanvasItem[] {
  const featureLower = filter.feature ? normalize(filter.feature) : undefined;
  const tagLowers = filter.tags?.map((t) => normalize(t)) ?? [];

  return catalog.images
    .filter((img) => img.status === "processed")
    .filter((img) => !filter.carId || img.vin === filter.carId)
    .filter((img) => !filter.role || img.role === filter.role)
    .filter((img) => {
      if (!featureLower) return true;
      const haystack = normalize([
        img.caption,
        img.visibleFeatures.join(" "),
        (img.searchTags ?? []).join(" ")
      ].join(" "));
      return haystack.includes(featureLower);
    })
    .filter((img) => {
      if (tagLowers.length === 0) return true;
      const imgTags = (img.searchTags ?? []).map((t) => normalize(t));
      return tagLowers.some((tl) => imgTags.some((it) => it.includes(tl)));
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit)
    .map((img): CanvasItem => ({ kind: "image", carId: img.vin, imageId: img.id }));
}

// ── Spec writing (the salesman's notepad) ─────────────────────────────────────
//
// A writeSpec action names WHICH facts to surface; this registry resolves each
// field key to a formatted { label, value } row straight from the grounded Car
// record. The model never types the number — it only picks the field — so the
// canvas can never show a figure that disagrees with the catalog.

export type SpecRow = {
  label: string;
  value: string;
  emphasis?: "normal" | "muted" | "total";
  separatorBefore?: boolean;
};

const formatMoney = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

type SpecResolver = (car: Car) => SpecRow | SpecRow[] | undefined;

function resolvePricingMathRows(car: Car): SpecRow[] | undefined {
  if (!car.specs && car.price == null) return undefined;

  const msrp = car.specs?.msrp;
  const ourPrice = car.price;
  const pricing = car.pricingGuidance;
  const bestPossiblePrice = pricing?.incentiveRangeMin ?? ourPrice;
  const savings = msrp != null && bestPossiblePrice != null ? Math.max(0, msrp - bestPossiblePrice) : undefined;

  const rows: SpecRow[] = [];
  if (msrp != null) rows.push({ label: "MSRP", value: formatMoney(msrp), emphasis: "muted" });
  if (ourPrice != null) rows.push({ label: "Our Price", value: formatMoney(ourPrice) });
  if (pricing) {
    rows.push({
      label: "Possible Range After Discounts",
      value: `${formatMoney(pricing.incentiveRangeMin)}-${formatMoney(pricing.incentiveRangeMax)}`
    });
  }
  if (savings != null) {
    rows.push({
      label: "Total Possible Savings",
      value: `Up to ${formatMoney(savings)}`,
      emphasis: "total",
      separatorBefore: true
    });
  }
  return rows.length > 0 ? rows : undefined;
}

const SPEC_FIELDS: Record<string, SpecResolver> = {
  mileage: (c) => ({ label: "Mileage", value: `${c.mileage.toLocaleString("en-US")} mi` }),
  pricingMath: resolvePricingMathRows,
  price: (c) => ({ label: "Price", value: c.price != null ? formatMoney(c.price) : "Inquire for price" }),
  msrp: (c) => (c.specs ? { label: "MSRP", value: formatMoney(c.specs.msrp) } : undefined),
  incentiveRange: (c) => (c.pricingGuidance ? {
    label: "Incentive Range",
    value: `${formatMoney(c.pricingGuidance.incentiveRangeMin)}-${formatMoney(c.pricingGuidance.incentiveRangeMax)}`
  } : undefined),
  year: (c) => ({ label: "Year", value: String(c.year) }),
  color: (c) => ({ label: "Exterior", value: c.specs?.exteriorColor ?? c.color }),
  interiorColor: (c) => (c.specs ? { label: "Interior", value: c.specs.interiorColor } : undefined),
  drivetrain: (c) => ({ label: "Drivetrain", value: c.drivetrain }),
  fuel: (c) => ({ label: "Fuel", value: c.specs?.fuelType ?? c.fuel }),
  condition: (c) => (c.specs ? { label: "Condition", value: c.specs.condition } : undefined),
  vin: (c) => ({ label: "VIN", value: c.specs?.vin ?? c.vin }),
  stockNumber: (c) => (c.specs ? { label: "Stock #", value: c.specs.stockNumber } : undefined),
  engine: (c) => (c.specs ? { label: "Engine", value: c.specs.engine } : undefined),
  horsepower: (c) => (c.specs ? { label: "Horsepower", value: `${c.specs.horsepower} hp` } : undefined),
  torque: (c) => (c.specs ? { label: "Torque", value: c.specs.torque } : undefined),
  transmission: (c) => (c.specs ? { label: "Transmission", value: c.specs.transmission } : undefined),
  zeroToSixty: (c) => (c.specs ? { label: "0–60 mph", value: `${c.specs.zeroToSixtySeconds} s` } : undefined),
  topSpeed: (c) => (c.specs ? { label: "Top speed", value: `${c.specs.topSpeedMph} mph` } : undefined),
  mpg: (c) => (c.specs ? { label: "Fuel economy", value: `${c.specs.mpgCity}/${c.specs.mpgHighway} mpg` } : undefined),
  seating: (c) => (c.specs ? { label: "Seating", value: `${c.specs.seating} seats` } : undefined),
  doors: (c) => (c.specs ? { label: "Doors", value: String(c.specs.doors) } : undefined),
  warranty: (c) => (c.specs ? { label: "Warranty", value: c.specs.warranty } : undefined)
};

// Loose natural-language aliases → canonical field key, so the model/heuristic
// can pass names like "0-60", "hp", or "miles" and still resolve.
const SPEC_ALIASES: Record<string, string> = {
  miles: "mileage",
  odometer: "mileage",
  cost: "price",
  asking: "price",
  hp: "horsepower",
  power: "horsepower",
  bhp: "horsepower",
  "0-60": "zeroToSixty",
  "zero-to-sixty": "zeroToSixty",
  acceleration: "zeroToSixty",
  topspeed: "topSpeed",
  "fuel-economy": "mpg",
  "gas-mileage": "mpg",
  economy: "mpg",
  seats: "seating",
  exteriorcolor: "color",
  paint: "color",
  interior: "interiorColor",
  gearbox: "transmission",
  motor: "engine",
  stock: "stockNumber"
};

/** Canonical writeSpec field keys, exported so deciders can advertise them. */
export const SPEC_FIELD_KEYS = Object.keys(SPEC_FIELDS);

function resolveSpecRow(car: Car, field: string): SpecRow | undefined {
  const key = field.trim();
  const canonical = SPEC_FIELDS[key] ? key : (SPEC_ALIASES[key.toLowerCase()] ?? key);
  const resolved = SPEC_FIELDS[canonical]?.(car);
  return Array.isArray(resolved) ? undefined : resolved;
}

/**
 * Resolve a list of field keys to formatted rows, dropping unknown/missing
 * fields and de-duplicating by label. Pure and total.
 */
export function resolveSpecRows(car: Car, fields: string[]): SpecRow[] {
  const rows: SpecRow[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    const key = field.trim();
    const canonical = SPEC_FIELDS[key] ? key : (SPEC_ALIASES[key.toLowerCase()] ?? key);
    const resolved = SPEC_FIELDS[canonical]?.(car);
    const nextRows = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
    for (const row of nextRows) {
      if (!seen.has(row.label)) {
        seen.add(row.label);
        rows.push(row);
      }
    }
  }
  return rows;
}

/**
 * Pure, synchronous, total reducer. Returns the new ViewState for a given
 * CanvasAction. Never throws on valid-typed input; unresolvable refs produce
 * a no-op (returns `state` unchanged).
 *
 * Tier 2 ops (annotate, compare, focusCar) are schema-complete but their full
 * behavior ships in Phase 5–6. They do update state here so the contract is
 * exercisable from tests and the LLM decider today.
 *
 * Tier 3 ops (generate, reset) insert a pending item / reset to overview.
 */
export function applyAction(state: ViewState, action: CanvasAction, catalog: Catalog): ViewState {
  switch (action.op) {
    case "showImage": {
      // Normalize carId to the image's real vin (the LLM often sends the wrong
      // carId); resolve by imageId. Unknown imageId → no-op.
      const image = catalog.images.find((img) => img.id === action.imageId);
      if (!image) return state;
      const item: CanvasItem = { kind: "image", carId: image.vin, imageId: image.id };
      return { layout: "single", items: [item] };
    }

    case "showImages": {
      let items: CanvasItem[];
      if (action.imageIds && action.imageIds.length > 0) {
        // Explicit list of imageIds — resolve against catalog; drop unknowns.
        const carId = action.carId;
        items = action.imageIds.flatMap((imageId): CanvasItem[] => {
          const img = catalog.images.find(
            (i) => i.id === imageId && (!carId || i.vin === carId)
          );
          if (!img) return [];
          return [{ kind: "image", carId: img.vin, imageId: img.id }];
        });
      } else {
        const filter: ItemFilter = {
          carId: action.carId,
          role: action.filter?.role,
          feature: action.filter?.feature,
          tags: action.filter?.tags
        };
        items = selectItems(catalog, filter, action.limit ?? 4);
      }
      const limited = items.slice(0, action.limit ?? 4);
      return { layout: "grid", items: limited };
    }

    case "zoom": {
      const target = resolveItemRef(action.itemRef, catalog, state);
      if (!target || target.kind !== "image") return state;

      // Is the target already on screen? Zoom it in place. Otherwise "zoom
      // implies show": focus it as a single image first, so we never zoom the
      // wrong photo (previously this fell back to item index 0).
      const existingIndex = state.items.findIndex(
        (it) => it.kind === "image" && it.imageId === target.imageId && it.carId === target.carId
      );
      const onScreen = existingIndex >= 0;
      const items = onScreen ? state.items : [target];
      const layout = onScreen ? state.layout : "single";
      const itemIndex = onScreen ? existingIndex : 0;

      let region: BBox;
      if (typeof action.region === "string") {
        const image = catalog.images.find((i) => i.id === target.imageId && i.vin === target.carId);
        // Named zoomTarget if seeded (Phase 6); otherwise a tight center crop so
        // "zoom in" is an obvious close-up, not a barely-noticeable nudge.
        region = image?.zoomTargets?.[action.region] ?? [0.28, 0.3, 0.44, 0.44];
      } else {
        region = action.region;
      }
      return { ...state, layout, items, zoom: { itemIndex, region } };
    }

    case "annotate": {
      const target = resolveItemRef(action.itemRef, catalog, state);
      if (!target || target.kind !== "image") return state;
      const itemIndex = state.items.findIndex(
        (it) =>
          it.kind === "image" &&
          it.imageId === target.imageId &&
          it.carId === target.carId
      );
      const resolvedIndex = itemIndex >= 0 ? itemIndex : 0;

      // Marks come from the action when the caller supplied them; otherwise we
      // backfill from the target image's PRECOMPUTED `boxes` — measurement-
      // labeled boxes (label contains a digit, e.g. "Cargo space · 15.5 cu ft")
      // first, else every box. This is the key move: a text-only decider can
      // ask to annotate an image without ever inventing pixel coordinates.
      type MarkSource = { box: BBox; label: string; polygon?: Polygon };
      let source: MarkSource[] | undefined =
        action.marks && action.marks.length > 0 ? action.marks : undefined;
      if (!source) {
        const image = catalog.images.find((i) => i.id === target.imageId);
        const boxes = image?.boxes ?? [];
        const measurement = boxes.filter((b) => /\d/.test(b.label));
        source = (measurement.length > 0 ? measurement : boxes).map((b) => ({ box: b.box, label: b.label, polygon: b.polygon }));
      }
      if (source.length === 0) return state; // nothing to annotate → no-op
      const marks = source.map((m) => ({
        itemIndex: resolvedIndex,
        box: m.box,
        label: m.label,
        // Carry the contour through when present so the renderer can outline the
        // real shape instead of a rectangle.
        ...(m.polygon ? { polygon: m.polygon } : {})
      }));
      return { ...state, marks };
    }

    case "compare": {
      const [refA, refB] = action.itemRefs;
      const itemA = resolveItemRef(refA, catalog, state);
      const itemB = resolveItemRef(refB, catalog, state);
      if (!itemA || !itemB) return state;
      return { layout: "compare", items: [itemA, itemB] };
    }

    case "focusCar": {
      // Switch focus to the given car. Default view = that car's first image.
      const firstImage = catalog.images.find(
        (img) => img.vin === action.carId && img.status === "processed"
      );
      if (!firstImage) {
        // Car exists in catalog.cars but has no images — show a car card.
        const carItem: CanvasItem = { kind: "car", carId: action.carId };
        return { layout: "focus", items: [carItem] };
      }
      const item: CanvasItem = { kind: "image", carId: firstImage.vin, imageId: firstImage.id };
      return { layout: "single", items: [item] };
    }

    case "writeSpec": {
      // Resolve the car from whatever is currently on screen (else the first
      // catalog car), then fill each requested field with its grounded value.
      const currentCarId = state.items
        .map((it) => (it.kind === "image" || it.kind === "car" ? it.carId : undefined))
        .find((id): id is string => Boolean(id));
      const car = catalog.cars.find((c) => c.vin === currentCarId) ?? catalog.cars[0];
      if (!car) return state;
      const rows = resolveSpecRows(car, action.fields);
      if (rows.length === 0) return state; // no resolvable fields → no-op
      const item: CanvasItem = { kind: "spec", title: action.title, rows };
      return { layout: "spec", items: [item] };
    }

    case "generate": {
      // Insert a pending generated item; the heavy lane resolves it later.
      const generated: CanvasItem = {
        kind: "generated",
        id: `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        prompt: action.prompt,
        status: "pending"
      };
      return { ...state, items: [...state.items, generated] };
    }

    case "reset": {
      // Default overview: first processed image as single.
      const firstImage = catalog.images.find((img) => img.status === "processed");
      if (!firstImage) return { layout: "single", items: [] };
      const item: CanvasItem = { kind: "image", carId: firstImage.vin, imageId: firstImage.id };
      return { layout: "single", items: [item] };
    }
  }
}

// ── Intent detection constants for planCanvas ─────────────────────────────────

const SHOW_ALL_PHRASES = [
  "show all", "all pics", "all pictures", "all photos", "all angles",
  "all images", "every photo", "everything", "all of them", "all the photos",
  "show everything", "see all", "see everything"
];

// Bare count/quantity phrases that mean "show me several images" with no role filter.
const BARE_COUNT_PHRASES = [
  "four images", "four photos", "four pictures", "four pics",
  "a few images", "a few photos", "a few pictures", "a few pics",
  "some images", "some photos", "some pictures", "some pics",
  "several images", "several photos", "several pictures",
  "more images", "more photos", "more pictures"
];

// Broad AREA terms → role(s). These trigger a showImages grid (not a single image).
// Interior is special: includes both interior_front and interior_rear.
type AreaEntry = { roles: ImageRole[]; terms: string[] };
const AREA_INTENT_MAP: AreaEntry[] = [
  { roles: ["interior_front", "interior_rear"], terms: ["interior", "inside", "cabin", "seats", "seat"] },
  { roles: ["dashboard"], terms: ["dashboard", "dash", "cockpit"] },
  { roles: ["exterior_front"], terms: ["exterior", "outside", "front"] },
  { roles: ["exterior_rear"], terms: ["rear", "back"] },
  { roles: ["wheel"], terms: ["wheel", "wheels", "rim", "rims", "tire", "tires"] },
  { roles: ["trunk"], terms: ["trunk", "cargo", "boot"] }
];

const COMPARE_PHRASES = ["compare", " vs ", " versus ", "difference", "both", "other side", "side by side", "side-by-side"];
const ZOOM_PHRASES = ["closer", "zoom in", "zoom into", "up close", "close up on", "detail of", "zoom", "close-up", "zoomed"];

// Specific small-part phrases that trigger showImage + zoom pair rather than a grid.
// Ordered longest-first so multi-word phrases are matched before their substrings.
const SPECIFIC_PARTS: string[] = [
  "gear selector",
  "gear shifter",
  "gear stick",
  "shift lever",
  "gear lever",
  "infotainment screen",
  "center console",
  "button cluster",
  "brake caliper",
  "shifter",
  "gearstick",
  "infotainment",
  "stitching",
  "caliper",
  "vent",
  "badge",
  "mirror",
  "button",
  "screen",
  "stick"
];

/**
 * Per-part zoom regions [x, y, w, h] in 0..1 relative image coordinates.
 * Used by the specific-part branch of planCanvas so the heuristic fallback
 * auto-zooms to the right area without an LLM call.
 */
const PART_REGIONS: Record<string, BBox> = {
  "gear selector": [0.26, 0.45, 0.42, 0.45],
  "gear shifter":  [0.26, 0.45, 0.42, 0.45],
  "gear stick":    [0.26, 0.45, 0.42, 0.45],
  "shift lever":   [0.26, 0.45, 0.42, 0.45],
  "gear lever":    [0.26, 0.45, 0.42, 0.45],
  "shifter":       [0.26, 0.45, 0.42, 0.45],
  "gearstick":     [0.26, 0.45, 0.42, 0.45],
  "badge":         [0.30, 0.30, 0.30, 0.30],
  "button":        [0.30, 0.55, 0.40, 0.35],
  "button cluster":[0.30, 0.55, 0.40, 0.35],
  "vent":          [0.25, 0.20, 0.50, 0.35],
  "screen":        [0.20, 0.10, 0.60, 0.50],
  "infotainment":  [0.20, 0.10, 0.60, 0.50],
  "infotainment screen": [0.20, 0.10, 0.60, 0.50],
  "center console":[0.30, 0.40, 0.40, 0.50],
  "caliper":       [0.20, 0.30, 0.50, 0.50],
  "brake caliper": [0.20, 0.30, 0.50, 0.50],
  "mirror":        [0.60, 0.20, 0.30, 0.40],
  "stitching":     [0.25, 0.50, 0.50, 0.40],
  "stick":         [0.26, 0.45, 0.42, 0.45]
};

/** Default per-part zoom region when the specific part has no explicit entry. */
const DEFAULT_PART_REGION: BBox = [0.28, 0.3, 0.44, 0.44];

/**
 * Find an image's PRECOMPUTED zoom region for a named part, matching a
 * `zoomTargets` key to the requested part by substring either direction
 * (e.g. part "gear shifter" matches the seeded "shifter" key). Returns the
 * grounded box when found so the close-up lands exactly on the object, instead
 * of the generic guessed `PART_REGIONS` fallback.
 */
function zoomTargetFor(image: CarImage, part: string): BBox | undefined {
  const targets = image.zoomTargets ?? {};
  if (targets[part]) return targets[part];
  for (const [key, box] of Object.entries(targets)) {
    if (part.includes(key) || key.includes(part)) return box;
  }
  return undefined;
}

// Size / measurement questions ("how big is it", "how much room") → draw the
// precomputed measurement annotation on the relevant image rather than writing a
// spec card. Only fires when a target image actually carries measurement boxes,
// so non-measurable asks fall through harmlessly.
const MEASUREMENT_INTENT = [
  "how big", "how large", "how much space", "how much room", "how spacious",
  "how roomy", "dimensions", "cargo capacity", "cargo space", "cargo volume",
  "trunk space", "trunk size", "trunk capacity", "how many cubic", "cubic feet",
  "how much can it hold", "how much fits", "luggage space", "storage space",
  "will my luggage fit", "fit my luggage", "fit luggage"
];

// Spec/number questions → writeSpec (the salesman writes the fact on the canvas).
// Each entry maps trigger phrases → the field key(s) to surface. Multi-field
// entries (e.g. "the specs") write a small fact sheet.
const SPEC_INTENT_MAP: Array<{ fields: string[]; terms: string[] }> = [
  { fields: ["mileage"], terms: ["how many miles", "how many kms", "mileage", "odometer", "miles on it", "miles on the clock"] },
  { fields: ["pricingMath"], terms: ["how much is it", "how much does it cost", "how much for", "what's the price", "what is the price", "asking price", "the price", "out the door"] },
  { fields: ["msrp"], terms: ["msrp", "sticker price"] },
  { fields: ["horsepower"], terms: ["horsepower", "how much power", "how many hp", "how much hp", "bhp"] },
  { fields: ["torque"], terms: ["torque", "lb-ft", "pound feet", "pound-feet"] },
  { fields: ["zeroToSixty"], terms: ["0-60", "0 to 60", "zero to sixty", "how fast is it", "how quick", "acceleration"] },
  { fields: ["topSpeed"], terms: ["top speed", "how fast can it go", "max speed", "fastest"] },
  { fields: ["mpg"], terms: ["mpg", "gas mileage", "fuel economy", "miles per gallon"] },
  // NOTE: engine is intentionally NOT here — it's a photographable part, so an
  // engine question should SHOW the engine-bay photo (the ranked default below),
  // not a text card. writeSpec is for abstract numbers with no meaningful photo.
  { fields: ["transmission"], terms: ["transmission", "gearbox", "manual or automatic", "how many gears", "automatic or manual"] },
  { fields: ["seating"], terms: ["how many seats", "how many people", "seating capacity"] },
  { fields: ["warranty"], terms: ["warranty", "is it covered", "coverage left"] },
  { fields: ["vin"], terms: ["vin number", "what's the vin", "vehicle identification"] },
  { fields: ["stockNumber"], terms: ["stock number", "stock #"] },
  { fields: ["year"], terms: ["what year", "model year"] },
  { fields: ["horsepower", "torque", "zeroToSixty", "topSpeed"], terms: ["performance specs", "performance numbers", "how does it perform", "power numbers"] },
  { fields: ["price", "mileage", "horsepower", "zeroToSixty"], terms: ["the specs", "full specs", "spec sheet", "the numbers", "key numbers", "the rundown"] }
];

// If the shopper is clearly asking to SEE something, a photo wins over a written
// fact — so spec detection bails when any of these visual cues are present.
const VISUAL_VERBS = ["show", "see ", "look at", "pull up", "let me see", "picture", "photo", "pic ", " pics", "image", "view of", "zoom"];

// Verbal-only intents — handled entirely by the spoken reply, never the canvas.
// Discounts are steered to an in-person visit (no figures, no card); financing /
// lease / payment / scheduling have no photo either. planCanvas returns [] for
// these so the rule-7 fallback can't surface a tangential image — the canvas
// reverts to the overview hero.
const VERBAL_ONLY_TERMS = [
  "discount", "discounts", "rebate", "rebates", "incentive", "incentives",
  "how low can you go", "best price", "best you can do", "come down on the price",
  "knock off", "deal on it", "financing", "finance", "lease", "monthly payment",
  "trade in", "trade-in", "test drive", "book a", "appointment", "come in"
];

/**
 * Gather images matching any of the given roles, sorted by confidence desc,
 * limited to `limit`. Used to build the interior grid that spans both
 * interior_front and interior_rear.
 */
function mergeRoleImages(images: CarImage[], roles: ImageRole[], limit: number): CarImage[] {
  return images
    .filter((img) => img.status === "processed" && roles.includes(img.role))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

/**
 * Fast heuristic decider: maps a user utterance to a list of CanvasActions
 * using the existing `rankImagesForQuestion` scorer. Pure, synchronous, O(n
 * images) — designed to run in < 5ms. Returns [] for greetings / empty input
 * so the canvas stays unchanged.
 *
 * Intent priority (first match wins):
 *  1. Greeting / empty          → []
 *  2. "show all"                → showImages({})
 *  3. Bare count triggers       → showImages({}, limit 4)
 *  4. Specific small part       → [showImage top-ranked, zoom with PART_REGIONS BBox]
 *  5. Compare intent            → compare top-2 ranked
 *  6. Zoom intent               → zoom top-ranked (named-target string)
 *  7. Broad area / category     → showImages({ imageIds: merged roles, limit 4 })
 *  8. Default                   → showImage top-ranked
 *
 * Compare and zoom run before area so "compare the front and rear" / "zoom in
 * on the wheels" are not swallowed by the area branch.
 */
export function planCanvas(message: string, images: CarImage[], state: ViewState): CanvasAction[] {
  if (!message.trim() || isCasualGreeting(message)) return [];

  const lower = message.toLowerCase();

  // 0a. Verbal-only intents (discounts, financing, scheduling) → no canvas. Return
  //     [] so the caller reverts to the overview hero instead of the rule-7
  //     fallback pulling a tangential image (e.g. "how low can you go").
  if (VERBAL_ONLY_TERMS.some((term) => lower.includes(term))) return [];

  // 0. Spec / number question → write the grounded fact onto the canvas, UNLESS
  //    the shopper is clearly asking to SEE something (visual verbs win). This
  //    runs first so "how many miles" types the number instead of pulling a
  //    photo; "show me the engine" still routes to the image branches below.
  if (!VISUAL_VERBS.some((verb) => lower.includes(verb))) {
    const specHit = SPEC_INTENT_MAP.find((entry) => entry.terms.some((term) => lower.includes(term)));
    if (specHit) return [{ op: "writeSpec", fields: specHit.fields }];
  }

  // 0b. Measurement / size question → draw the precomputed measurement
  //     annotation on the relevant image. Prefers the image already on screen
  //     (resolves "how big is IT"); else the top-ranked image that actually
  //     carries measurement boxes. Marks are backfilled by the reducer from
  //     image.boxes — no coordinates are guessed here.
  if (MEASUREMENT_INTENT.some((term) => lower.includes(term))) {
    const hasMeasure = (img: CarImage | undefined): img is CarImage =>
      !!img && (img.boxes ?? []).some((b) => /\d/.test(b.label));
    const current = state.items[0];
    const currentImg =
      current?.kind === "image" ? images.find((i) => i.id === current.imageId) : undefined;
    const target = hasMeasure(currentImg)
      ? currentImg
      : rankImagesForQuestion(message, images).map((r) => r.image).find(hasMeasure);
    if (target) {
      if (currentImg && currentImg.id === target.id) {
        return [{ op: "annotate", itemRef: { index: 0 } }];
      }
      return [
        { op: "showImage", carId: target.vin, imageId: target.id },
        { op: "annotate", itemRef: { carId: target.vin, imageId: target.id } }
      ];
    }
    // No image carries measurement data → fall through to area/default below.
  }

  // 1. "show all / everything / all pics / all angles"
  if (SHOW_ALL_PHRASES.some((phrase) => lower.includes(phrase))) {
    return [{ op: "showImages" }];
  }

  // 2. Bare count triggers ("a few photos", "some pictures", "four images")
  if (BARE_COUNT_PHRASES.some((phrase) => lower.includes(phrase))) {
    return [{ op: "showImages", limit: 4 }];
  }

  // 3. Specific small-part recognizer — runs before area so "gear shifter"
  //    doesn't get swallowed by the broad "interior/cabin" area branch.
  //    SPECIFIC_PARTS is ordered longest-first to avoid partial matches.
  const matchedPart = SPECIFIC_PARTS.find((part) => lower.includes(part));
  if (matchedPart) {
    const ranked = rankImagesForQuestion(message, images);
    const top = ranked[0];
    if (!top) return [];
    // Prefer the image's PRECOMPUTED zoom region for this part (seeded by the
    // annotation pass — e.g. the console's exact gear-selector box) over the
    // generic guessed box, so the close-up lands right on the object.
    const region: BBox =
      zoomTargetFor(top.image, matchedPart) ?? PART_REGIONS[matchedPart] ?? DEFAULT_PART_REGION;
    const itemRef: ItemRef = { carId: top.image.vin, imageId: top.image.id };
    return [
      { op: "showImage", carId: top.image.vin, imageId: top.image.id },
      { op: "zoom", itemRef, region }
    ];
  }

  // 4. Compare intent — runs before area so "compare the front and rear" is not
  //    captured by the area branch ("front"/"rear" terms).
  const hasCompareIntent = COMPARE_PHRASES.some((phrase) => lower.includes(phrase));
  if (hasCompareIntent) {
    const ranked = rankImagesForQuestion(message, images);
    const first = ranked[0];
    const second = ranked[1];
    if (first && second) {
      const refA: ItemRef = { carId: first.image.vin, imageId: first.image.id };
      const refB: ItemRef = { carId: second.image.vin, imageId: second.image.id };
      return [{ op: "compare", itemRefs: [refA, refB] }];
    }
    if (first) {
      return [{ op: "showImage", carId: first.image.vin, imageId: first.image.id }];
    }
    return [];
  }

  // 5. Zoom intent — runs before area so "zoom in on the wheels" is not
  //    captured by the area branch ("wheels" term).
  const matchedZoomPhrase = ZOOM_PHRASES.find((phrase) => lower.includes(phrase));
  if (matchedZoomPhrase) {
    const ranked = rankImagesForQuestion(message, images);
    const top = ranked[0];
    if (top) {
      // Use the matched zoom phrase as the named target (normalized, no spaces).
      const namedTarget = matchedZoomPhrase.trim().replace(/\s+/g, "-");
      return [{ op: "zoom", itemRef: { carId: top.image.vin, imageId: top.image.id }, region: namedTarget }];
    }
    // Bare "zoom in" with no rankable target → zoom whatever is CURRENTLY on
    // screen (don't return [] — that left the canvas idle while the reply said
    // "here's a closer look", a voice/canvas mismatch).
    const current = state.items[0];
    if (current?.kind === "image") {
      return [{ op: "zoom", itemRef: { index: 0 }, region: [0.28, 0.3, 0.44, 0.44] }];
    }
    return [];
  }

  // 6. Broad AREA intent → showImages grid (includes interior_rear for interior).
  //    Triggered by area terms alone OR when paired with a MULTI_IMAGE_PHRASE.
  const areaMatch = AREA_INTENT_MAP.find(
    (entry) => entry.terms.some((term) => lower.includes(term))
  );
  if (areaMatch) {
    const merged = mergeRoleImages(images, areaMatch.roles, 4);
    if (merged.length > 0) {
      const imageIds = merged.map((img) => img.id);
      const carId = merged[0]!.vin;
      return [{ op: "showImages", carId, imageIds, limit: 4 }];
    }
    // No matching images — fall through to ranked default below.
  }

  // 7. Default: showImage of top-ranked — ONLY when the match is strong. A weak
  //    top score means the message isn't really about anything in a photo (e.g.
  //    a pricing / financing / "is it worth it" / objection turn). Surfacing a
  //    tangential image there is the bug where "justifying the pricing" pulled a
  //    random speaker close-up (score ~2). Below the threshold we return [] and
  //    let the caller revert the canvas to the overview hero instead.
  const ranked = rankImagesForQuestion(message, images);
  const top = ranked[0];
  if (!top || top.score < MIN_DEFAULT_SHOW_SCORE) return [];
  return [{ op: "showImage", carId: top.image.vin, imageId: top.image.id }];
}
