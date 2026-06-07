/**
 * Surgically upsert specific image docs into the live MOSS images index.
 *
 * Unlike ingest-moss.ts (which calls createIndex and THROWS if the index already
 * exists), this uses addDocs({ upsert: true }) to add-or-update just the docs we
 * changed — leaving the other 44 image docs untouched.
 *
 *   npx tsx scripts/upsert-moss-images.ts <docId> [<docId> ...]
 *
 * With no args it defaults to the trunk + center-console docs.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";

type MossDoc = { id: string; text: string; metadata: Record<string, string> };

const DEFAULT_IDS = [
  "bmw-m4-2018-bmw-m4-pic-7412672979869378728-1024x768",
  "bmw-m4-2018-bmw-m4-pic-27355374517953209-1024x768"
];

async function main() {
  const pid = process.env.MOSS_PROJECT_ID;
  const key = process.env.MOSS_PROJECT_KEY;
  const imagesIndex = process.env.MOSS_IMAGES_INDEX;
  if (!pid || !key) throw new Error("Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY");
  if (!imagesIndex) throw new Error("Set MOSS_IMAGES_INDEX");

  const ids = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_IDS;
  const allDocs = JSON.parse(
    await readFile(path.join(process.cwd(), "data", "moss-image-documents.json"), "utf8")
  ) as MossDoc[];

  const docs = allDocs.filter((doc) => ids.includes(doc.id));
  const missing = ids.filter((id) => !docs.some((doc) => doc.id === id));
  if (missing.length > 0) throw new Error(`Doc ids not found in export: ${missing.join(", ")}`);

  console.log(`Upserting ${docs.length} doc(s) into "${imagesIndex}":`);
  for (const doc of docs) console.log(`  - ${doc.id} (${doc.text.length} chars)`);

  const { MossClient } = await import("@moss-dev/moss");
  const client = new MossClient(pid, key);
  const result = await client.addDocs(imagesIndex, docs, {
    upsert: true,
    onProgress: (p: { status: string; progress: number }) => console.log(`  ${p.status} ${p.progress}%`)
  });
  console.log(`Done. Job ${result.jobId ?? "(n/a)"} complete.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
