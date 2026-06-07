/**
 * Re-runnable image enrichment pass for the BMW M4 image catalog.
 *
 * The trunk and center-console records carry hand-verified boxes. The rest of
 * the M4 images get deterministic semantic boxes/zoomTargets/questions derived
 * from the existing human-reviewed caption, role, and visibleFeatures. This
 * gives the canvas/Moss index the same useful shape across the full image set
 * without pretending every coordinate is pixel-perfect.
 *
 *   npx tsx scripts/apply-manual-annotations.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CarImageSchema, type BBox, type CarImage } from "@vox/core";

const root = process.cwd();
const imagesPath = path.join(root, "data", "images.json");

const TRUNK_ID = "bmw-m4-2018-bmw-m4-pic-7412672979869378728-1024x768";
const CONSOLE_ID = "bmw-m4-2018-bmw-m4-pic-27355374517953209-1024x768";

type Box = { label: string; box: BBox; polygon?: [number, number][] };
type Annotation = {
  boxes: Box[];
  zoomTargets: Record<string, BBox>;
  captionAppend?: string;
  addFeatures?: string[];
  addSearchTags?: string[];
  addLikelyQuestions?: string[];
};

const MANUAL_ANNOTATIONS: Record<string, Annotation> = {
  [TRUNK_ID]: {
    boxes: [
      {
        label: "Cargo space · 15.5 cu ft (440 L)",
        box: [0.14, 0.42, 0.76, 0.5],
        polygon: [
          [0.225, 0.53],
          [0.3, 0.475],
          [0.4, 0.45],
          [0.52, 0.445],
          [0.63, 0.45],
          [0.71, 0.48],
          [0.745, 0.55],
          [0.75, 0.63],
          [0.73, 0.72],
          [0.68, 0.8],
          [0.6, 0.85],
          [0.48, 0.865],
          [0.37, 0.85],
          [0.29, 0.81],
          [0.235, 0.71],
          [0.21, 0.61]
        ]
      },
      { label: "Load floor & cargo net", box: [0.2, 0.55, 0.56, 0.36] },
      { label: "Side storage trim", box: [0.82, 0.42, 0.17, 0.31] },
      { label: "Trunk lid (open)", box: [0.1, 0, 0.85, 0.34] }
    ],
    zoomTargets: {
      trunk: [0.14, 0.42, 0.76, 0.5],
      cargo: [0.14, 0.42, 0.76, 0.5],
      "cargo floor": [0.2, 0.55, 0.56, 0.36],
      "load floor": [0.2, 0.55, 0.56, 0.36]
    },
    captionAppend:
      " The coupe trunk holds 15.5 cubic feet (about 440 liters) of cargo, expandable via the split-folding rear seatbacks.",
    addFeatures: ["15.5 cu ft cargo capacity", "440-liter trunk", "split-folding rear seatbacks"],
    addSearchTags: ["trunk size", "trunk capacity", "cargo volume", "trunk dimensions", "15.5 cubic feet", "440 liters", "how big is the trunk"],
    addLikelyQuestions: ["How big is the trunk?", "What's the trunk capacity?", "Will my luggage fit?", "Do the rear seats fold down?"]
  },
  [CONSOLE_ID]: {
    boxes: [
      { label: "Gear selector (8-speed M Steptronic)", box: [0.3, 0.32, 0.13, 0.23] },
      { label: "Drive-mode & M buttons", box: [0.23, 0.55, 0.23, 0.11] },
      { label: "iDrive controller", box: [0.49, 0.45, 0.14, 0.18] },
      { label: "Cupholders", box: [0.17, 0.3, 0.16, 0.13] },
      { label: "Manual parking brake", box: [0.45, 0.7, 0.13, 0.16] }
    ],
    zoomTargets: {
      "center console": [0.2, 0.28, 0.5, 0.6],
      "gear selector": [0.3, 0.32, 0.13, 0.23],
      shifter: [0.3, 0.32, 0.13, 0.23],
      stick: [0.3, 0.32, 0.13, 0.23],
      "button cluster": [0.23, 0.55, 0.23, 0.11],
      "drive modes": [0.23, 0.55, 0.23, 0.11],
      iDrive: [0.49, 0.45, 0.14, 0.18],
      cupholder: [0.17, 0.3, 0.16, 0.13],
      "parking brake": [0.45, 0.7, 0.13, 0.16]
    }
  }
};

const ROLE_QUESTIONS: Partial<Record<CarImage["role"], string[]>> = {
  exterior_front: ["Can I see the front?", "Can I inspect the headlights and grille?", "Does it have front parking sensors?"],
  exterior_rear: ["Can I see the rear?", "Can I inspect the spoiler and taillights?", "Can I see the exhaust area?"],
  interior_front: ["Can I see the front cabin?", "Can I inspect the seats and console?", "Does it have carbon-fiber interior trim?"],
  interior_rear: ["Can I see the back seats?", "How much rear-seat room is there?", "Are the rear seats clean?"],
  dashboard: ["Can I see the dashboard?", "Does it have navigation?", "Can I see the screen and controls?"],
  wheel: ["Can I see the wheels?", "What tires are on it?", "What color are the brake calipers?"],
  detail: ["Can I see that detail closer?", "Can you zoom in on this part?"]
};

function unionUnique(existing: string[], additions: string[] = []): string[] {
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  const out = [...existing];
  for (const item of additions) {
    const clean = item.trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out;
}

function has(record: CarImage, ...terms: string[]): boolean {
  const text = [
    record.role,
    record.viewpoint,
    record.caption,
    ...record.visibleFeatures,
    ...record.searchTags,
    ...record.likelyQuestions
  ].join(" ").toLowerCase();
  return terms.some((term) => text.includes(term.toLowerCase()));
}

function addBox(boxes: Box[], zoomTargets: Record<string, BBox>, label: string, box: BBox, aliases: string[]) {
  if (!boxes.some((existing) => existing.label.toLowerCase() === label.toLowerCase())) {
    boxes.push({ label, box });
  }
  for (const alias of aliases) zoomTargets[alias] = box;
}

function roleBase(record: CarImage): Annotation {
  const boxes: Box[] = [];
  const zoomTargets: Record<string, BBox> = {};
  const addFeatures: string[] = [];
  const addSearchTags: string[] = [];
  const addLikelyQuestions = [...(ROLE_QUESTIONS[record.role] ?? [])];

  if (record.role === "wheel") {
    addBox(boxes, zoomTargets, "Wheel and tire", [0.1, 0.08, 0.78, 0.84], ["wheel", "rim", "tire", "tyre"]);
    addBox(boxes, zoomTargets, "Blue M brake caliper", [0.56, 0.25, 0.24, 0.35], ["brake caliper", "caliper", "blue caliper", "brakes"]);
    addBox(boxes, zoomTargets, "Drilled brake rotor", [0.34, 0.26, 0.34, 0.42], ["rotor", "drilled rotor", "brake rotor"]);
    addSearchTags.push("wheel close-up", "rim condition", "tire sidewall", "brake inspection", "blue brake caliper");
  }

  if (record.role === "dashboard") {
    addBox(boxes, zoomTargets, "Infotainment screen", [0.1, 0.05, 0.65, 0.45], ["screen", "infotainment", "navigation", "nav", "display"]);
    addBox(boxes, zoomTargets, "Center vents and controls", [0.3, 0.5, 0.42, 0.28], ["vents", "center vents", "climate controls", "radio controls"]);
    addSearchTags.push("navigation screen", "technology controls", "center stack", "dash controls");
  }

  if (record.role === "trunk") {
    addBox(boxes, zoomTargets, "Cargo area", [0.14, 0.42, 0.76, 0.5], ["trunk", "cargo", "storage", "luggage area"]);
  }

  if (record.role === "interior_rear") {
    addBox(boxes, zoomTargets, "Rear seats", [0.14, 0.18, 0.72, 0.58], ["rear seats", "back seats", "second row"]);
    addBox(boxes, zoomTargets, "Rear climate vents", [0.42, 0.58, 0.18, 0.18], ["rear vents", "rear climate", "back vents"]);
    addSearchTags.push("rear passenger space", "back seat room", "rear cabin");
  }

  if (record.role === "exterior_front") {
    addBox(boxes, zoomTargets, "Front fascia", [0.12, 0.25, 0.76, 0.48], ["front", "front fascia", "front bumper"]);
    if (has(record, "grille", "kidney")) addBox(boxes, zoomTargets, "Black kidney grille", [0.32, 0.36, 0.34, 0.24], ["grille", "kidney grille", "black grille"]);
    if (has(record, "headlight")) addBox(boxes, zoomTargets, "LED headlights", [0.16, 0.32, 0.68, 0.2], ["headlights", "LED headlights", "lights"]);
    if (has(record, "splitter", "front lip", "carbon lip")) addBox(boxes, zoomTargets, "Carbon-fiber front lip", [0.16, 0.66, 0.68, 0.18], ["front lip", "splitter", "carbon lip"]);
    addSearchTags.push("front fascia", "front-end condition", "front parking sensors");
  }

  if (record.role === "exterior_rear") {
    addBox(boxes, zoomTargets, "Rear fascia", [0.12, 0.28, 0.76, 0.5], ["rear", "back", "rear bumper"]);
    if (has(record, "spoiler")) addBox(boxes, zoomTargets, "Carbon-fiber rear spoiler", [0.28, 0.24, 0.44, 0.16], ["rear spoiler", "spoiler", "carbon spoiler"]);
    if (has(record, "taillight")) addBox(boxes, zoomTargets, "LED taillights", [0.15, 0.36, 0.7, 0.18], ["taillights", "tail lights", "rear lights"]);
    if (has(record, "exhaust")) addBox(boxes, zoomTargets, "Quad exhaust area", [0.25, 0.7, 0.5, 0.18], ["exhaust", "quad exhaust", "tailpipes"]);
    addSearchTags.push("rear fascia", "rear-end condition", "rear parking sensors");
  }

  if (record.role === "interior_front") {
    addBox(boxes, zoomTargets, "Front sport seats", [0.12, 0.2, 0.76, 0.62], ["front seats", "seats", "sport seats", "bucket seats"]);
    if (has(record, "steering wheel")) addBox(boxes, zoomTargets, "M steering wheel", [0.08, 0.18, 0.28, 0.32], ["steering wheel", "wheel controls", "M steering wheel"]);
    if (has(record, "center console", "gear selector", "shifter", "iDrive")) addBox(boxes, zoomTargets, "Center console controls", [0.3, 0.34, 0.34, 0.46], ["center console", "gear selector", "shifter", "iDrive"]);
    if (has(record, "door panel")) addBox(boxes, zoomTargets, "Door panel", [0.02, 0.18, 0.3, 0.62], ["door panel", "door trim", "window switches"]);
    addSearchTags.push("front cabin inspection", "seat condition", "console controls", "interior trim");
  }

  if (record.role === "detail") {
    addBox(boxes, zoomTargets, "Primary detail", [0.2, 0.2, 0.6, 0.58], ["detail", "close-up", "close up"]);
    if (has(record, "speaker", "Harman")) addBox(boxes, zoomTargets, "Harman Kardon speaker", [0.16, 0.16, 0.68, 0.58], ["speaker", "Harman Kardon", "audio"]);
    if (has(record, "key", "paperwork", "CARFAX")) addBox(boxes, zoomTargets, "Keys and paperwork", [0.12, 0.12, 0.76, 0.72], ["keys", "key fobs", "paperwork", "CARFAX"]);
    if (has(record, "engine", "hood open")) addBox(boxes, zoomTargets, "Engine bay", [0.12, 0.16, 0.76, 0.66], ["engine", "engine bay", "hood open"]);
    if (has(record, "roof")) addBox(boxes, zoomTargets, "Carbon-fiber roof", [0.12, 0.1, 0.76, 0.5], ["roof", "carbon roof", "carbon-fiber roof"]);
    if (has(record, "mirror")) addBox(boxes, zoomTargets, "Carbon-fiber mirror cap", [0.16, 0.12, 0.68, 0.58], ["mirror", "mirror cap", "carbon mirror"]);
    if (has(record, "button")) addBox(boxes, zoomTargets, "Control button", [0.32, 0.32, 0.36, 0.28], ["button", "control", "switch"]);
    if (has(record, "badge")) addBox(boxes, zoomTargets, "Badge", [0.26, 0.24, 0.48, 0.32], ["badge", "M4 badge", "BMW badge"]);
    addSearchTags.push("detail close-up", "condition close-up", "feature detail");
  }

  if (has(record, "carbon-fiber", "carbon fiber")) {
    addFeatures.push("carbon-fiber detail visible");
    addSearchTags.push("carbon fiber", "carbon weave", "carbon-fiber trim");
  }
  if (has(record, "parking sensor", "sensors")) addSearchTags.push("parking sensors", "park distance control");
  if (has(record, "M4 badge")) addSearchTags.push("M4 badge", "M branding");
  if (has(record, "Harman Kardon")) addSearchTags.push("Harman Kardon audio", "premium sound");
  if (has(record, "Continental")) addSearchTags.push("Continental ExtremeContact tires");

  return { boxes, zoomTargets, addFeatures, addSearchTags, addLikelyQuestions };
}

function mergeAnnotation(record: CarImage, annotation: Annotation): CarImage {
  const captionBase = annotation.captionAppend
    ? record.caption.replace(annotation.captionAppend.trim(), "").trimEnd()
    : record.caption;

  return CarImageSchema.parse({
    ...record,
    caption: annotation.captionAppend ? `${captionBase}${annotation.captionAppend}` : record.caption,
    visibleFeatures: unionUnique(record.visibleFeatures, annotation.addFeatures).slice(0, 32),
    searchTags: unionUnique(record.searchTags ?? [], annotation.addSearchTags).slice(0, 56),
    likelyQuestions: unionUnique(record.likelyQuestions ?? [], annotation.addLikelyQuestions).slice(0, 20),
    boxes: annotation.boxes.length > 0 ? annotation.boxes : record.boxes ?? [],
    zoomTargets: Object.keys(annotation.zoomTargets).length > 0 ? annotation.zoomTargets : record.zoomTargets ?? {},
    pairs: record.pairs ?? []
  });
}

async function main() {
  const records = JSON.parse(await readFile(imagesPath, "utf8")) as CarImage[];
  let enriched = 0;

  const next = records.map((record) => {
    if (record.vin !== "BMW-M4") return CarImageSchema.parse(record);

    const annotation = MANUAL_ANNOTATIONS[record.id] ?? roleBase(record);
    const merged = mergeAnnotation(record, annotation);
    if ((merged.boxes ?? []).length > 0 || Object.keys(merged.zoomTargets ?? {}).length > 0) enriched += 1;
    return merged;
  });

  await writeFile(imagesPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Enriched ${enriched} BMW-M4 image records.`);
  console.log(`Wrote ${next.length} records to ${imagesPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
