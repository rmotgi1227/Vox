import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CarImageSchema } from "@vox/core";
import { rankImagesForQuestion } from "@vox/agent-core";

const MossDocSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  metadata: z.record(z.string(), z.string())
});

describe("BMW M4 processed image data", () => {
  it("contains a complete processed source batch", () => {
    const images = CarImageSchema.array().parse(JSON.parse(readFileSync("data/images.json", "utf8")));
    expect(images).toHaveLength(46);
    expect(images.filter((image) => image.status !== "processed")).toHaveLength(0);
    expect(images.filter((image) => image.role === "unknown")).toHaveLength(0);
    expect(new Set(images.map((image) => image.url)).size).toBe(46);
    expect(images.filter((image) => !image.viewpoint)).toHaveLength(0);
    expect(images.filter((image) => image.visibleFeatures.length < 6)).toHaveLength(0);
    expect(images.filter((image) => image.searchTags.length < 8)).toHaveLength(0);
    expect(images.filter((image) => image.likelyQuestions.length < 4)).toHaveLength(0);
  });

  it("exports Moss image documents with linked metadata", () => {
    const docs = MossDocSchema.array().parse(JSON.parse(readFileSync("data/moss-image-documents.json", "utf8")));
    expect(docs).toHaveLength(46);
    for (const doc of docs) {
      expect(doc.metadata.car_id).toBe("BMW-M4");
      expect(doc.metadata.image_id).toBeTruthy();
      expect(doc.metadata.doc_type).toBe("image");
    }
  });

  it("selects specific M4 photos from natural-language shopper questions", () => {
    const images = CarImageSchema.array().parse(JSON.parse(readFileSync("data/images.json", "utf8")));
    const cases: Record<string, string> = {
      "does it have a sunroof": "4486786565089773980",
      "show me the trunk": "7412672979869378728",
      "show me the wheels": "1601741309887650709",
      "show the engine": "7400799656167128024",
      "does it have navigation": "1319146320583892681",
      "show me the keys": "1461017558474954336",
      "show me the rear seats": "4040769667739339279",
      "show me the head up display": "7153278583895275358",
      "show the center console controls": "2789690467330177541"
    };

    for (const [question, idPart] of Object.entries(cases)) {
      expect(rankImagesForQuestion(question, images)[0]?.image.id).toContain(idPart);
    }
  });
});
