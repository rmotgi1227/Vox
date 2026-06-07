import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CarImageSchema, CarSchema, carFactSheet } from "@vox/core";

type MossDoc = { id: string; text: string; metadata: Record<string, string> };

function carDoc(car: unknown): MossDoc {
  const c = CarSchema.parse(car);
  const s = c.specs;
  return {
    id: c.vin,
    text: carFactSheet(c),
    metadata: {
      doc_type: "car",
      car_id: c.vin,
      product_id: `${c.make}-${c.model}`.toLowerCase().replaceAll(" ", "-"),
      variant_id: c.vin,
      title: `${c.year} ${c.make} ${c.model}`,
      variant: `${c.trim} · ${c.drivetrain} · ${c.color}`,
      price: String(c.price ?? ""),
      available: c.availability === "available" ? "true" : "false",
      opt_body: c.body,
      opt_drivetrain: c.drivetrain,
      opt_fuel: c.fuel,
      opt_mileage: String(c.mileage),
      opt_color: c.color,
      ...(s
        ? {
            condition: s.condition,
            real_vin: s.vin,
            stock_number: s.stockNumber,
            msrp: String(s.msrp),
            engine: s.engine,
            horsepower: String(s.horsepower),
            torque: s.torque,
            transmission: s.transmission,
            zero_to_sixty_s: String(s.zeroToSixtySeconds),
            top_speed_mph: String(s.topSpeedMph),
            mpg_city: String(s.mpgCity),
            mpg_highway: String(s.mpgHighway),
            mpg_combined: String(s.mpgCombined),
            seating: String(s.seating),
            interior_color: s.interiorColor,
            warranty: s.warranty
          }
        : {})
    }
  };
}

function imageDoc(image: unknown): MossDoc {
  const img = CarImageSchema.parse(image);
  return {
    id: img.id,
    text: [
      img.caption,
      img.viewpoint ? `Viewpoint: ${img.viewpoint}.` : "",
      `Visible features: ${img.visibleFeatures.join(", ")}.`,
      img.conditionNotes.length ? `Condition and evidence notes: ${img.conditionNotes.join(", ")}.` : "",
      img.searchTags.length ? `Search tags and aliases: ${img.searchTags.join(", ")}.` : "",
      `Shopper questions this image can answer: ${(img.likelyQuestions ?? []).join(", ")}.`,
      `Role: ${img.role}.`
    ].filter(Boolean).join(" "),
    metadata: {
      doc_type: "image",
      car_id: img.vin,
      vin: img.vin,
      image_id: img.id,
      role: img.role,
      viewpoint: img.viewpoint,
      url: img.url,
      status: img.status,
      confidence: String(img.confidence),
      available: img.status === "failed" ? "false" : "true"
    }
  };
}

async function main() {
  const root = process.cwd();
  const catalog = JSON.parse(await readFile(path.join(root, "data", "catalog.json"), "utf8"));
  const images = JSON.parse(await readFile(path.join(root, "data", "images.json"), "utf8"));
  const catalogDocs = catalog.map(carDoc);
  const imageDocs = images.map(imageDoc);
  const combinedDocs = [...catalogDocs, ...imageDocs.map((doc) => ({ ...doc, id: `image:${doc.id}` }))];
  const catalogOutput = path.join(root, "data", "moss-catalog-documents.json");
  const imageOutput = path.join(root, "data", "moss-image-documents.json");
  const combinedOutput = path.join(root, "data", "moss-documents.json");
  await writeFile(catalogOutput, `${JSON.stringify(catalogDocs, null, 2)}\n`);
  await writeFile(imageOutput, `${JSON.stringify(imageDocs, null, 2)}\n`);
  await writeFile(combinedOutput, `${JSON.stringify(combinedDocs, null, 2)}\n`);
  console.log(`Wrote ${catalogDocs.length} catalog docs to ${catalogOutput}`);
  console.log(`Wrote ${imageDocs.length} image docs to ${imageOutput}`);
  console.log(`Wrote ${combinedDocs.length} combined docs to ${combinedOutput}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
