import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";

type MossDoc = { id: string; text: string; metadata: Record<string, string> };

async function main() {
  const pid = process.env.MOSS_PROJECT_ID;
  const key = process.env.MOSS_PROJECT_KEY;
  if (!pid || !key) throw new Error("Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY");
  const catalogIndex = process.env.MOSS_CATALOG_INDEX;
  const imagesIndex = process.env.MOSS_IMAGES_INDEX;
  if (!catalogIndex || !imagesIndex) throw new Error("Set MOSS_CATALOG_INDEX and MOSS_IMAGES_INDEX");
  const { MossClient } = await import("@moss-dev/moss");
  const catalogDocs = JSON.parse(await readFile(path.join(process.cwd(), "data", "moss-catalog-documents.json"), "utf8")) as MossDoc[];
  const imageDocs = JSON.parse(await readFile(path.join(process.cwd(), "data", "moss-image-documents.json"), "utf8")) as MossDoc[];
  const client = new MossClient(pid, key);
  await client.createIndex(catalogIndex, catalogDocs, { modelId: "moss-minilm" });
  console.log(`Indexed ${catalogDocs.length} catalog docs into ${catalogIndex}`);
  await client.createIndex(imagesIndex, imageDocs, { modelId: "moss-minilm" });
  console.log(`Indexed ${imageDocs.length} image docs into ${imagesIndex}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
