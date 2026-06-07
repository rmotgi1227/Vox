import type { Car, CarImage, ImageRole, SpecialistSource, SpecialistTurn } from "@vox/core";

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
