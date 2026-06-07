import type {
  BBox,
  CanvasAction,
  CanvasItem,
  Car,
  CarImage,
  ImageRole,
  ItemFilter,
  ItemRef,
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
      if (!target) return state;
      const itemIndex = state.items.findIndex(
        (it) =>
          it.kind === "image" &&
          target.kind === "image" &&
          it.imageId === target.imageId &&
          it.carId === target.carId
      );
      const resolvedIndex = itemIndex >= 0 ? itemIndex : 0;
      const marks = action.marks.map((m) => ({
        itemIndex: resolvedIndex,
        box: m.box,
        label: m.label
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
    const region: BBox = PART_REGIONS[matchedPart] ?? DEFAULT_PART_REGION;
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

  // 7. Default: showImage of top-ranked
  const ranked = rankImagesForQuestion(message, images);
  const top = ranked[0];
  if (!top) return [];
  return [{ op: "showImage", carId: top.image.vin, imageId: top.image.id }];
}
