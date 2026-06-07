/**
 * One-off MANUAL annotation pass for two images (trunk + center console).
 *
 * This is NOT the future ingestion pipeline — it's the mechanism for writing
 * hand-derived region boxes + the verified trunk measurement into the two image
 * objects safely (validated against CarImageSchema, formatted like the rest of
 * data/images.json). Regions are normalized [x, y, w, h] in 0..1, read visually
 * off the actual photos. Trunk capacity (15.5 cu ft / 440 L) is the real
 * published 2026 BMW M4 Coupe figure, not an estimate from pixels.
 *
 * Re-runnable: it merges (boxes/zoomTargets replaced wholesale; text fields
 * union-merged case-insensitively) so running twice is a no-op.
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

type Annotation = {
  boxes: { label: string; box: BBox; polygon?: [number, number][] }[];
  zoomTargets: Record<string, BBox>;
  captionAppend?: string;
  addFeatures?: string[];
  addSearchTags?: string[];
  addLikelyQuestions?: string[];
};

const ANNOTATIONS: Record<string, Annotation> = {
  // ── TRUNK ──────────────────────────────────────────────────────────────────
  // Open lid up top (with rear glass), carpeted cargo floor + black mesh net,
  // side storage trim on the right. Primary box carries the real measurement.
  [TRUNK_ID]: {
    boxes: [
      {
        label: "Cargo space · 15.5 cu ft (440 L)",
        box: [0.14, 0.42, 0.76, 0.5],
        // Contour tracing the trunk OPENING (the loadable cavity), so the
        // annotation outlines the real shape rather than a rectangle. Dense
        // ring (16 pts) that stays INSIDE the foam walls — clockwise from the
        // top-left, normalized [x,y].
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
      { label: "Trunk lid (open)", box: [0.1, 0.0, 0.85, 0.34] }
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
    addSearchTags: [
      "trunk size",
      "trunk capacity",
      "cargo capacity",
      "cargo volume",
      "trunk dimensions",
      "luggage space",
      "15.5 cubic feet",
      "440 liters",
      "how big is the trunk"
    ],
    addLikelyQuestions: [
      "How big is the trunk?",
      "What's the trunk capacity?",
      "How much cargo space does it have?",
      "Will my luggage fit?",
      "Do the rear seats fold down?"
    ]
  },

  // ── CENTER CONSOLE ───────────────────────────────────────────────────────────
  // Object identification (no measurement): gear selector center-left, drive-mode
  // button bank below it, iDrive rotary to its right, twin cupholders to the left,
  // manual handbrake lever at the bottom.
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

function unionUnique(existing: string[], additions: string[] = []): string[] {
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  const out = [...existing];
  for (const item of additions) {
    if (seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    out.push(item);
  }
  return out;
}

async function main() {
  const records = JSON.parse(await readFile(imagesPath, "utf8")) as CarImage[];
  let touched = 0;

  const next = records.map((record) => {
    const ann = ANNOTATIONS[record.id];
    if (!ann) return record;
    touched += 1;

    const captionBase = ann.captionAppend
      ? record.caption.replace(ann.captionAppend.trim(), "").trimEnd()
      : record.caption;

    const merged: CarImage = CarImageSchema.parse({
      ...record,
      caption: ann.captionAppend ? `${captionBase}${ann.captionAppend}` : record.caption,
      visibleFeatures: unionUnique(record.visibleFeatures, ann.addFeatures),
      searchTags: unionUnique(record.searchTags ?? [], ann.addSearchTags),
      likelyQuestions: unionUnique(record.likelyQuestions ?? [], ann.addLikelyQuestions),
      boxes: ann.boxes,
      zoomTargets: ann.zoomTargets
    });
    console.log(`annotated ${record.id}: ${ann.boxes.length} boxes, ${Object.keys(ann.zoomTargets).length} zoom targets`);
    return merged;
  });

  if (touched !== Object.keys(ANNOTATIONS).length) {
    throw new Error(`Expected to annotate ${Object.keys(ANNOTATIONS).length} images, but matched ${touched}. Check the ids.`);
  }

  await writeFile(imagesPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Wrote ${next.length} records to ${imagesPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
