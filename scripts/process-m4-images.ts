import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { CarImageSchema, DEFAULT_VIN, type CarImage, type ImageRole } from "@vox/core";

const root = findRepoRoot(process.cwd());
const sourceDir = path.join(root, "car_m4_images");
const publicDir = path.join(root, "public", "cars", "BMW-M4");
const manualObjectsPath = path.join(root, "data", "m4-manual-image-objects.json");
const imagesPath = path.join(root, "data", "images.json");

type ManualImageObject = {
  role: ImageRole;
  viewpoint?: string;
  caption: string;
  visibleFeatures: string[];
  conditionNotes?: string[];
  searchTags?: string[];
  likelyQuestions?: string[];
  confidence: number;
  status?: CarImage["status"];
};

const roleTags: Record<ImageRole, string[]> = {
  exterior_front: ["front exterior", "front bumper", "headlights", "grille", "hood", "paint", "outside view"],
  exterior_rear: ["rear exterior", "taillights", "rear bumper", "exhaust", "decklid", "spoiler", "outside view"],
  interior_front: ["front cabin", "front seats", "cockpit", "interior", "center console", "dashboard", "upholstery"],
  interior_rear: ["rear seats", "back seats", "rear cabin", "second row", "rear passenger area", "interior"],
  dashboard: ["dashboard", "infotainment", "navigation", "screen", "climate controls", "driver display", "cockpit"],
  trunk: ["trunk", "cargo area", "boot", "luggage space", "storage", "cargo floor"],
  wheel: ["wheel", "rim", "tire", "tyre", "brake", "caliper", "rotor", "Continental tire"],
  detail: ["detail view", "close up", "specific feature", "trim", "condition detail"],
  unknown: []
};

function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "data", "catalog.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function slugBase(fileName: string): string {
  return path.basename(fileName, path.extname(fileName)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const clean = item.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

async function loadManualObjects(): Promise<Record<string, ManualImageObject>> {
  if (!existsSync(manualObjectsPath)) {
    throw new Error(`Missing ${manualObjectsPath}. Create manual image objects before running this processor.`);
  }
  return JSON.parse(await readFile(manualObjectsPath, "utf8")) as Record<string, ManualImageObject>;
}

async function main() {
  const files = (await readdir(sourceDir))
    .filter((file) => /\.(webp|png|jpe?g)$/i.test(file))
    .sort();
  if (files.length === 0) throw new Error(`No images found in ${sourceDir}`);

  await mkdir(publicDir, { recursive: true });
  const manualObjects = await loadManualObjects();
  const records: CarImage[] = [];
  const missing: string[] = [];

  for (const [index, fileName] of files.entries()) {
    const manual = manualObjects[fileName];
    if (!manual) {
      missing.push(fileName);
      continue;
    }

    const source = path.join(sourceDir, fileName);
    const publicName = `${slugBase(fileName)}${path.extname(fileName).toLowerCase()}`;
    await copyFile(source, path.join(publicDir, publicName));

    const record = CarImageSchema.parse({
      id: `bmw-m4-${slugBase(fileName)}`,
      vin: DEFAULT_VIN,
      url: `/cars/BMW-M4/${publicName}`,
      role: manual.role,
      viewpoint: manual.viewpoint ?? "",
      caption: manual.caption,
      visibleFeatures: unique(manual.visibleFeatures).slice(0, 24),
      conditionNotes: unique(manual.conditionNotes ?? []).slice(0, 16),
      searchTags: unique([...(manual.searchTags ?? []), ...roleTags[manual.role], manual.role.replaceAll("_", " ")]).slice(0, 40),
      likelyQuestions: unique(manual.likelyQuestions ?? []).slice(0, 16),
      confidence: manual.confidence,
      status: manual.status ?? "processed"
    });
    records.push(record);
    console.log(`[${index + 1}/${files.length}] ${fileName} -> ${record.role}`);
  }

  if (missing.length > 0) {
    throw new Error(`Missing manual objects for: ${missing.join(", ")}`);
  }

  await writeFile(imagesPath, `${JSON.stringify(records, null, 2)}\n`);
  console.log(`Wrote ${records.length} local image records to ${imagesPath}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", "export:moss"], { cwd: root, stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`export:moss exited ${code}`)));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
