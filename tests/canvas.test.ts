/**
 * Phase 0 canvas foundation tests.
 *
 * Covers:
 *  - applyAction for every op (showImage, showImages, zoom, annotate, compare,
 *    focusCar, generate, reset)
 *  - ItemRef resolution by carId+imageId and by index
 *  - selectItems filtering (carId, role, feature, tags)
 *  - planCanvas intent→action mapping
 *
 * Uses small fixtures; the M4 images.json is loaded for planCanvas tests so
 * the real scorer behaviour is exercised.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CarImageSchema, ViewStateSchema } from "@vox/core";
import type { CanvasAction, CanvasItem, CarImage, Car, ViewState } from "@vox/core";
import { applyAction, planCanvas, selectItems, resolveSpecRows } from "@vox/agent-core";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeImage(overrides: Partial<CarImage> & { id: string }): CarImage {
  return CarImageSchema.parse({
    id: overrides.id,
    vin: overrides.vin ?? "CAR-A",
    url: `/${overrides.id}.jpg`,
    role: overrides.role ?? "exterior_front",
    viewpoint: overrides.viewpoint ?? "front view",
    caption: overrides.caption ?? `${overrides.id} caption`,
    visibleFeatures: overrides.visibleFeatures ?? ["headlight", "bumper", "grille", "hood", "wheel arch", "paint"],
    conditionNotes: overrides.conditionNotes ?? [],
    searchTags: overrides.searchTags ?? ["exterior", "front", "paint", "bumper", "headlight", "grille", "hood", "fascia"],
    likelyQuestions: overrides.likelyQuestions ?? ["What does the front look like?", "Does it have LED headlights?", "Show me the front bumper", "What color is it?"],
    confidence: overrides.confidence ?? 1,
    status: overrides.status ?? "processed",
    boxes: overrides.boxes ?? [],
    zoomTargets: overrides.zoomTargets ?? {},
    pairs: overrides.pairs ?? []
  });
}

const imgFront = makeImage({ id: "img-front", vin: "CAR-A", role: "exterior_front" });
const imgRear = makeImage({ id: "img-rear", vin: "CAR-A", role: "exterior_rear",
  caption: "rear view", searchTags: ["rear", "taillight", "diffuser", "exhaust", "bumper", "paint", "spoiler", "trunk lid"],
  likelyQuestions: ["Show me the rear", "What does the back look like?", "Are there dual exhausts?", "Show the taillights"]
});
const imgInterior = makeImage({ id: "img-interior", vin: "CAR-A", role: "interior_front",
  caption: "interior front seats and cockpit",
  visibleFeatures: ["sport seats", "steering wheel", "dashboard", "center console", "carbon trim", "ambient lighting"],
  searchTags: ["interior", "cabin", "seats", "steering wheel", "dashboard", "carbon", "console", "ambient"],
  likelyQuestions: ["Show me the interior", "What do the seats look like?", "Is there carbon trim?", "Show me the cabin"]
});
const imgWheels = makeImage({ id: "img-wheels", vin: "CAR-A", role: "wheel",
  caption: "19 inch forged wheels with red brake calipers",
  visibleFeatures: ["forged wheels", "red calipers", "low-profile tires", "brake disc", "center cap", "spoke design"],
  searchTags: ["wheels", "rims", "calipers", "tires", "brake", "forged", "alloy", "19 inch"],
  likelyQuestions: ["Show me the wheels", "Do the brakes look good?", "What size wheels?", "Are there red calipers?"]
});
const imgCarB = makeImage({ id: "img-b-front", vin: "CAR-B", role: "exterior_front",
  caption: "second car exterior front" });
const imgPending = makeImage({ id: "img-pending", vin: "CAR-A", role: "exterior_front", status: "pending" });

const carA: Car = {
  vin: "CAR-A", year: 2024, make: "BMW", model: "M4", trim: "Competition",
  body: "Coupe", drivetrain: "RWD", fuel: "Gas", price: 95000, mileage: 1200,
  color: "Red", features: ["M Sport"], availability: "available", description: "demo"
};
const carB: Car = {
  vin: "CAR-B", year: 2023, make: "BMW", model: "M3", trim: "Base",
  body: "Sedan", drivetrain: "RWD", fuel: "Gas", price: 80000, mileage: 5000,
  color: "Blue", features: [], availability: "available", description: "demo B"
};

const catalog = {
  images: [imgFront, imgRear, imgInterior, imgWheels, imgCarB, imgPending],
  cars: [carA, carB]
};

const emptyState: ViewState = { layout: "single", items: [] };

const stateWithFront: ViewState = {
  layout: "single",
  items: [{ kind: "image", carId: "CAR-A", imageId: "img-front" }]
};

// ── applyAction: showImage ────────────────────────────────────────────────────

describe("applyAction: showImage", () => {
  it("produces layout=single with one image item", () => {
    const action: CanvasAction = { op: "showImage", carId: "CAR-A", imageId: "img-front" };
    const next = applyAction(emptyState, action, catalog);
    expect(next.layout).toBe("single");
    expect(next.items).toHaveLength(1);
    const item = next.items[0];
    expect(item?.kind).toBe("image");
    if (item?.kind === "image") {
      expect(item.carId).toBe("CAR-A");
      expect(item.imageId).toBe("img-front");
    }
  });

  it("drops zoom and marks from prior state", () => {
    const prior: ViewState = {
      layout: "single",
      items: [{ kind: "image", carId: "CAR-A", imageId: "img-front" }],
      zoom: { itemIndex: 0, region: [0, 0, 0.5, 0.5] },
      marks: [{ itemIndex: 0, box: [0, 0, 0.2, 0.2], label: "test" }]
    };
    const action: CanvasAction = { op: "showImage", carId: "CAR-A", imageId: "img-rear" };
    const next = applyAction(prior, action, catalog);
    expect(next.zoom).toBeUndefined();
    expect(next.marks).toBeUndefined();
  });
});

// ── applyAction: showImages ───────────────────────────────────────────────────

describe("applyAction: showImages", () => {
  it("uses explicit imageIds, produces layout=grid", () => {
    const action: CanvasAction = {
      op: "showImages",
      carId: "CAR-A",
      imageIds: ["img-front", "img-rear"]
    };
    const next = applyAction(emptyState, action, catalog);
    expect(next.layout).toBe("grid");
    expect(next.items).toHaveLength(2);
  });

  it("filters by role when no imageIds provided", () => {
    const action: CanvasAction = {
      op: "showImages",
      filter: { role: "exterior_rear" }
    };
    const next = applyAction(emptyState, action, catalog);
    expect(next.layout).toBe("grid");
    expect(next.items.every((it) => it.kind === "image")).toBe(true);
    // Only imgRear matches exterior_rear
    expect(next.items).toHaveLength(1);
    const item = next.items[0];
    if (item?.kind === "image") expect(item.imageId).toBe("img-rear");
  });

  it("respects limit field", () => {
    const action: CanvasAction = { op: "showImages", limit: 2 };
    const next = applyAction(emptyState, action, catalog);
    expect(next.items.length).toBeLessThanOrEqual(2);
  });

  it("skips pending images when using filter path", () => {
    const action: CanvasAction = { op: "showImages" };
    const next = applyAction(emptyState, action, catalog);
    const imageIds = next.items.flatMap((it) => it.kind === "image" ? [it.imageId] : []);
    expect(imageIds).not.toContain("img-pending");
  });

  it("returns empty items when no images match filter", () => {
    const action: CanvasAction = { op: "showImages", filter: { role: "trunk" } };
    const next = applyAction(emptyState, action, catalog);
    expect(next.layout).toBe("grid");
    expect(next.items).toHaveLength(0);
  });
});

// ── applyAction: zoom ─────────────────────────────────────────────────────────

describe("applyAction: zoom", () => {
  it("sets zoom with a BBox region resolved by carId+imageId ref", () => {
    const action: CanvasAction = {
      op: "zoom",
      itemRef: { carId: "CAR-A", imageId: "img-front" },
      region: [0.1, 0.2, 0.4, 0.3]
    };
    const next = applyAction(stateWithFront, action, catalog);
    expect(next.zoom).toBeDefined();
    expect(next.zoom?.region).toEqual([0.1, 0.2, 0.4, 0.3]);
  });

  it("sets zoom resolved by index ref", () => {
    const action: CanvasAction = {
      op: "zoom",
      itemRef: { index: 0 },
      region: [0, 0, 1, 1]
    };
    const next = applyAction(stateWithFront, action, catalog);
    expect(next.zoom).toBeDefined();
    expect(next.zoom?.region).toEqual([0, 0, 1, 1]);
  });

  it("resolves named zoomTarget from image metadata", () => {
    const imgWithTarget = makeImage({
      id: "img-badge",
      vin: "CAR-A",
      role: "detail",
      zoomTargets: { "m-badge": [0.7, 0.1, 0.15, 0.1] }
    });
    const catalogWithTarget = {
      ...catalog,
      images: [...catalog.images, imgWithTarget]
    };
    const stateWithBadge: ViewState = {
      layout: "single",
      items: [{ kind: "image", carId: "CAR-A", imageId: "img-badge" }]
    };
    const action: CanvasAction = {
      op: "zoom",
      itemRef: { carId: "CAR-A", imageId: "img-badge" },
      region: "m-badge"
    };
    const next = applyAction(stateWithBadge, action, catalogWithTarget);
    expect(next.zoom).toBeDefined();
    expect(next.zoom?.region).toEqual([0.7, 0.1, 0.15, 0.1]);
  });

  it("falls back to a center crop when named zoomTarget is absent", () => {
    const action: CanvasAction = {
      op: "zoom",
      itemRef: { carId: "CAR-A", imageId: "img-front" },
      region: "nonexistent-target"
    };
    const next = applyAction(stateWithFront, action, catalog);
    // Unresolved named target → tight center crop so "zoom in" is an obvious
    // close-up (no longer a silent no-op).
    expect(next.zoom).toBeDefined();
    expect(next.zoom?.region).toEqual([0.28, 0.3, 0.44, 0.44]);
  });

  it("is a no-op when ref cannot be resolved", () => {
    const action: CanvasAction = {
      op: "zoom",
      itemRef: { carId: "CAR-A", imageId: "unknown-id" },
      region: [0, 0, 0.5, 0.5]
    };
    const next = applyAction(stateWithFront, action, catalog);
    expect(next).toBe(stateWithFront);
  });
});

// ── applyAction: annotate ─────────────────────────────────────────────────────

describe("applyAction: annotate", () => {
  it("sets marks on the referenced item", () => {
    const action: CanvasAction = {
      op: "annotate",
      itemRef: { carId: "CAR-A", imageId: "img-front" },
      marks: [{ box: [0.1, 0.2, 0.3, 0.1], label: "headlight" }]
    };
    const next = applyAction(stateWithFront, action, catalog);
    expect(next.marks).toHaveLength(1);
    expect(next.marks?.[0]?.label).toBe("headlight");
    expect(next.marks?.[0]?.box).toEqual([0.1, 0.2, 0.3, 0.1]);
  });

  it("is a no-op when ref cannot be resolved", () => {
    const action: CanvasAction = {
      op: "annotate",
      itemRef: { carId: "CAR-A", imageId: "unknown" },
      marks: []
    };
    const next = applyAction(stateWithFront, action, catalog);
    expect(next).toBe(stateWithFront);
  });
});

// ── applyAction: compare ──────────────────────────────────────────────────────

describe("applyAction: compare", () => {
  it("produces layout=compare with two items resolved by carId+imageId", () => {
    const action: CanvasAction = {
      op: "compare",
      itemRefs: [
        { carId: "CAR-A", imageId: "img-front" },
        { carId: "CAR-A", imageId: "img-rear" }
      ]
    };
    const next = applyAction(emptyState, action, catalog);
    expect(next.layout).toBe("compare");
    expect(next.items).toHaveLength(2);
  });

  it("resolves refs by index", () => {
    const twoItemState: ViewState = {
      layout: "grid",
      items: [
        { kind: "image", carId: "CAR-A", imageId: "img-front" },
        { kind: "image", carId: "CAR-A", imageId: "img-rear" }
      ]
    };
    const action: CanvasAction = {
      op: "compare",
      itemRefs: [{ index: 0 }, { index: 1 }]
    };
    const next = applyAction(twoItemState, action, catalog);
    expect(next.layout).toBe("compare");
    expect(next.items).toHaveLength(2);
  });

  it("is a no-op when a ref cannot be resolved", () => {
    const action: CanvasAction = {
      op: "compare",
      itemRefs: [
        { carId: "CAR-A", imageId: "img-front" },
        { carId: "CAR-A", imageId: "no-such-image" }
      ]
    };
    const next = applyAction(stateWithFront, action, catalog);
    expect(next).toBe(stateWithFront);
  });
});

// ── applyAction: focusCar ─────────────────────────────────────────────────────

describe("applyAction: focusCar", () => {
  it("switches to the car's first processed image in single layout", () => {
    const action: CanvasAction = { op: "focusCar", carId: "CAR-A" };
    const next = applyAction(emptyState, action, catalog);
    expect(next.layout).toBe("single");
    expect(next.items).toHaveLength(1);
    const item = next.items[0];
    expect(item?.kind).toBe("image");
    if (item?.kind === "image") expect(item.carId).toBe("CAR-A");
  });

  it("shows a car card when no images are available for the car", () => {
    const catalogNoImages = { ...catalog, images: [] };
    const action: CanvasAction = { op: "focusCar", carId: "CAR-A" };
    const next = applyAction(emptyState, action, catalogNoImages);
    expect(next.layout).toBe("focus");
    expect(next.items[0]?.kind).toBe("car");
  });
});

// ── applyAction: generate ─────────────────────────────────────────────────────

describe("applyAction: generate", () => {
  it("appends a pending generated item without mutating state items", () => {
    const action: CanvasAction = {
      op: "generate",
      prompt: "M4 in Sao Paulo yellow"
    };
    const next = applyAction(stateWithFront, action, catalog);
    // Original item still present
    expect(next.items).toHaveLength(2);
    const gen = next.items[1];
    expect(gen?.kind).toBe("generated");
    if (gen?.kind === "generated") {
      expect(gen.status).toBe("pending");
      expect(gen.prompt).toBe("M4 in Sao Paulo yellow");
      expect(gen.url).toBeUndefined();
    }
  });

  it("generates a unique id each invocation", () => {
    const action: CanvasAction = { op: "generate", prompt: "test" };
    const a = applyAction(emptyState, action, catalog);
    const b = applyAction(emptyState, action, catalog);
    const idA = a.items[0]?.kind === "generated" ? a.items[0].id : null;
    const idB = b.items[0]?.kind === "generated" ? b.items[0].id : null;
    expect(idA).not.toBeNull();
    expect(idB).not.toBeNull();
    expect(idA).not.toBe(idB);
  });
});

// ── applyAction: reset ────────────────────────────────────────────────────────

describe("applyAction: reset", () => {
  it("returns single layout with the first processed image", () => {
    const prior: ViewState = {
      layout: "grid",
      items: [
        { kind: "image", carId: "CAR-A", imageId: "img-front" },
        { kind: "image", carId: "CAR-A", imageId: "img-rear" }
      ]
    };
    const action: CanvasAction = { op: "reset" };
    const next = applyAction(prior, action, catalog);
    expect(next.layout).toBe("single");
    expect(next.items).toHaveLength(1);
  });

  it("returns empty items when catalog has no processed images", () => {
    const emptyCatalog = { ...catalog, images: [imgPending] };
    const action: CanvasAction = { op: "reset" };
    const next = applyAction(emptyState, action, emptyCatalog);
    expect(next.layout).toBe("single");
    expect(next.items).toHaveLength(0);
  });
});

// ── applyAction: writeSpec ──────────────────────────────────────────────────────

const carWithSpecs: Car = {
  ...carA,
  vin: "CAR-S",
  mileage: 12400,
  price: 74900,
  specs: {
    condition: "Certified Pre-Owned",
    vin: "WBS-FULL-VIN-123",
    stockNumber: "M4-0420",
    msrp: 84500,
    exteriorColor: "São Paulo Yellow",
    interiorColor: "Black Merino",
    engine: "3.0L twin-turbo I6",
    horsepower: 503,
    torque: "479 lb-ft",
    transmission: "8-speed automatic",
    zeroToSixtySeconds: 3.4,
    topSpeedMph: 180,
    fuelType: "Premium",
    mpgCity: 16,
    mpgHighway: 23,
    mpgCombined: 19,
    fuelTankGallons: 15.6,
    seating: 4,
    doors: 2,
    warranty: "4yr / 50,000 mi",
    packages: ["Competition"],
    options: ["Carbon bucket seats"]
  },
  pricingGuidance: {
    incentiveRangeMin: 72000,
    incentiveRangeMax: 74900
  }
};

const specCatalog = { images: [imgFront], cars: [carWithSpecs] };
const specSeedState: ViewState = {
  layout: "single",
  items: [{ kind: "image", carId: "CAR-S", imageId: "img-front" }]
};

describe("applyAction: writeSpec", () => {
  it("writes a single grounded fact as a full-screen spec card", () => {
    const action: CanvasAction = { op: "writeSpec", fields: ["mileage"] };
    const next = applyAction(specSeedState, action, specCatalog);
    expect(next.layout).toBe("spec");
    expect(next.items).toHaveLength(1);
    const item = next.items[0];
    expect(item?.kind).toBe("spec");
    if (item?.kind === "spec") {
      expect(item.rows).toEqual([{ label: "Mileage", value: "12,400 mi" }]);
    }
  });

  it("resolves multiple fields in order with formatting and keeps the title", () => {
    const action: CanvasAction = {
      op: "writeSpec",
      fields: ["price", "horsepower", "zeroToSixty"],
      title: "Performance"
    };
    const next = applyAction(specSeedState, action, specCatalog);
    const item = next.items[0];
    if (item?.kind === "spec") {
      expect(item.title).toBe("Performance");
      expect(item.rows).toEqual([
        { label: "Price", value: "$74,900" },
        { label: "Horsepower", value: "503 hp" },
        { label: "0–60 mph", value: "3.4 s" }
      ]);
    }
  });

  it("resolves loose aliases (miles, hp, 0-60)", () => {
    const action: CanvasAction = { op: "writeSpec", fields: ["miles", "hp", "0-60"] };
    const next = applyAction(specSeedState, action, specCatalog);
    const item = next.items[0];
    if (item?.kind === "spec") {
      expect(item.rows.map((r) => r.label)).toEqual(["Mileage", "Horsepower", "0–60 mph"]);
    }
  });

  it("drops unknown fields and is a no-op when none resolve", () => {
    const action: CanvasAction = { op: "writeSpec", fields: ["banana", "nonsense"] };
    const next = applyAction(specSeedState, action, specCatalog);
    expect(next).toBe(specSeedState);
  });

  it("resolves the car from whatever image is currently on screen", () => {
    // Current view is CAR-B; writeSpec must read CAR-B's mileage, not CAR-A's.
    const stateB: ViewState = {
      layout: "single",
      items: [{ kind: "image", carId: "CAR-B", imageId: "img-b-front" }]
    };
    const action: CanvasAction = { op: "writeSpec", fields: ["mileage"] };
    const next = applyAction(stateB, action, catalog);
    const item = next.items[0];
    if (item?.kind === "spec") expect(item.rows[0]?.value).toBe("5,000 mi");
  });

  it("falls back to the first catalog car when nothing is on screen", () => {
    const action: CanvasAction = { op: "writeSpec", fields: ["price"] };
    const next = applyAction(emptyState, action, specCatalog);
    const item = next.items[0];
    if (item?.kind === "spec") expect(item.rows[0]?.value).toBe("$74,900");
  });
});

// ── resolveSpecRows (unit) ──────────────────────────────────────────────────────

describe("resolveSpecRows", () => {
  it("handles a missing price gracefully", () => {
    const noPrice: Car = { ...carWithSpecs, price: null };
    expect(resolveSpecRows(noPrice, ["price"])).toEqual([{ label: "Price", value: "Inquire for price" }]);
  });

  it("resolves incentive range from pricing guidance", () => {
    expect(resolveSpecRows(carWithSpecs, ["incentiveRange"])).toEqual([
      { label: "Incentive Range", value: "$72,000-$74,900" }
    ]);
  });

  it("resolves pricing math as a calculation-style row set", () => {
    expect(resolveSpecRows(carWithSpecs, ["pricingMath"])).toEqual([
      { label: "MSRP", value: "$84,500", emphasis: "muted" },
      { label: "Our Price", value: "$74,900" },
      { label: "Possible Range After Discounts", value: "$72,000-$74,900" },
      { label: "Total Possible Savings", value: "Up to $12,500", emphasis: "total", separatorBefore: true }
    ]);
  });

  it("de-duplicates fields that map to the same label", () => {
    // "color" and "paint" (alias → color) both resolve to the Exterior row.
    expect(resolveSpecRows(carWithSpecs, ["color", "paint"])).toHaveLength(1);
  });

  it("skips spec-only fields when the car has no specs block", () => {
    expect(resolveSpecRows(carA, ["horsepower"])).toEqual([]);
    // top-level fields still resolve
    expect(resolveSpecRows(carA, ["mileage"])).toEqual([{ label: "Mileage", value: "1,200 mi" }]);
  });
});

// ── selectItems ───────────────────────────────────────────────────────────────

describe("selectItems", () => {
  it("returns all processed images when filter is empty, capped at limit", () => {
    const items = selectItems(catalog, {}, 3);
    expect(items.length).toBeLessThanOrEqual(3);
    expect(items.every((it) => it.kind === "image")).toBe(true);
  });

  it("filters by carId", () => {
    const items = selectItems(catalog, { carId: "CAR-B" });
    expect(items.every((it) => it.kind === "image" && it.carId === "CAR-B")).toBe(true);
    expect(items.length).toBeGreaterThan(0);
  });

  it("filters by role", () => {
    const items = selectItems(catalog, { role: "interior_front" });
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item?.kind === "image") expect(item.imageId).toBe("img-interior");
  });

  it("filters by feature substring match across caption and tags", () => {
    const items = selectItems(catalog, { feature: "caliper" });
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item?.kind === "image") expect(item.imageId).toBe("img-wheels");
  });

  it("filters by tags (any-of semantics)", () => {
    const items = selectItems(catalog, { tags: ["rims"] });
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item?.kind === "image") expect(item.imageId).toBe("img-wheels");
  });

  it("excludes pending images", () => {
    const items = selectItems(catalog, {});
    const imageIds = items.flatMap((it) => it.kind === "image" ? [it.imageId] : []);
    expect(imageIds).not.toContain("img-pending");
  });

  it("returns empty when nothing matches", () => {
    const items = selectItems(catalog, { role: "trunk" });
    expect(items).toHaveLength(0);
  });

  it("maps items to CanvasItem kind=image", () => {
    const items = selectItems(catalog, { carId: "CAR-A", role: "exterior_front" });
    expect(items[0]?.kind).toBe("image");
  });
});

// ── planCanvas — intent→action mapping ───────────────────────────────────────

describe("planCanvas: intents (fixture images)", () => {
  const fixtureImages = [imgFront, imgRear, imgInterior, imgWheels];

  it("returns [] for a greeting", () => {
    expect(planCanvas("hey there", fixtureImages, emptyState)).toEqual([]);
    expect(planCanvas("hi", fixtureImages, emptyState)).toEqual([]);
  });

  it("returns [] for empty message", () => {
    expect(planCanvas("", fixtureImages, emptyState)).toEqual([]);
    expect(planCanvas("   ", fixtureImages, emptyState)).toEqual([]);
  });

  it("detects show-all intent → showImages (no filter)", () => {
    const actions = planCanvas("show all the photos", fixtureImages, emptyState);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.op).toBe("showImages");
    // No filter for show-all
    if (actions[0]?.op === "showImages") {
      expect(actions[0].filter).toBeUndefined();
    }
  });

  it("detects 'all pics' → showImages", () => {
    const actions = planCanvas("can I see all pics", fixtureImages, emptyState);
    expect(actions[0]?.op).toBe("showImages");
  });

  it("detects broad area intent → showImages with explicit imageIds (includes rear cabin)", () => {
    // "show me the interior" now routes via the AREA_INTENT_MAP branch which
    // merges interior_front + interior_rear and emits explicit imageIds so the
    // grid always shows the best-ranked cabin shots deterministically.
    const actions = planCanvas("show me the interior", fixtureImages, emptyState);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.op).toBe("showImages");
    if (actions[0]?.op === "showImages") {
      // Explicit imageIds replaces filter.role for the interior area case.
      expect(Array.isArray(actions[0].imageIds)).toBe(true);
      expect(actions[0].imageIds).toContain("img-interior");
      expect(actions[0].filter).toBeUndefined();
    }
  });

  it("detects compare intent → compare with top-2 ranked images", () => {
    const actions = planCanvas("compare the front and rear", fixtureImages, emptyState);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.op).toBe("compare");
    if (actions[0]?.op === "compare") {
      expect(actions[0].itemRefs).toHaveLength(2);
    }
  });

  it("detects zoom intent → zoom with named target string", () => {
    const actions = planCanvas("zoom in on the wheels", fixtureImages, emptyState);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.op).toBe("zoom");
    if (actions[0]?.op === "zoom") {
      expect(typeof actions[0].region).toBe("string");
    }
  });

  it("spec/number question → writeSpec (no photo)", () => {
    const actions = planCanvas("how many miles does it have", fixtureImages, emptyState);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.op).toBe("writeSpec");
    if (actions[0]?.op === "writeSpec") expect(actions[0].fields).toContain("mileage");
  });

  it("price question → writeSpec price", () => {
    const actions = planCanvas("what's the price", fixtureImages, emptyState);
    expect(actions[0]?.op).toBe("writeSpec");
    if (actions[0]?.op === "writeSpec") expect(actions[0].fields).toContain("pricingMath");
  });

  it("visual verb wins over spec terms: 'show me the price' does not writeSpec", () => {
    const actions = planCanvas("show me the price", fixtureImages, emptyState);
    expect(actions.every((a) => a.op !== "writeSpec")).toBe(true);
  });

  it("specific-part (caliper) → showImage + zoom pair", () => {
    // "caliper" is a specific small part, so planCanvas now routes to the
    // specific-part branch: showImage of the best wheel shot + a zoom action
    // targeting the caliper region.
    const actions = planCanvas("what color are the brake calipers?", fixtureImages, emptyState);
    expect(actions).toHaveLength(2);
    expect(actions[0]?.op).toBe("showImage");
    expect(actions[1]?.op).toBe("zoom");
    if (actions[0]?.op === "showImage") {
      expect(actions[0].imageId).toBe("img-wheels");
    }
    if (actions[1]?.op === "zoom") {
      expect(Array.isArray(actions[1].region)).toBe(true);
    }
  });
});

// ── planCanvas — real M4 data ─────────────────────────────────────────────────

describe("planCanvas: real M4 data", () => {
  const m4Images = CarImageSchema.array().parse(
    JSON.parse(readFileSync("data/images.json", "utf8"))
  );

  it("show all → showImages (no filter)", () => {
    const actions = planCanvas("show me all the photos", m4Images, emptyState);
    expect(actions[0]?.op).toBe("showImages");
  });

  it("interior ask → showImages with explicit imageIds (interior_front + interior_rear, limit 4)", () => {
    // Area intent now merges interior_front + interior_rear and emits imageIds
    // so the grid includes rear cabin shots and is ranked by confidence.
    const actions = planCanvas("show me the interior", m4Images, emptyState);
    expect(actions[0]?.op).toBe("showImages");
    if (actions[0]?.op === "showImages") {
      expect(Array.isArray(actions[0].imageIds)).toBe(true);
      expect((actions[0].imageIds ?? []).length).toBeGreaterThan(0);
      expect((actions[0].imageIds ?? []).length).toBeLessThanOrEqual(4);
      expect(actions[0].filter).toBeUndefined();
    }
  });

  it("specific visual question → showImage of top-ranked", () => {
    const actions = planCanvas("does it have navigation", m4Images, emptyState);
    expect(actions[0]?.op).toBe("showImage");
  });

  it("compare intent → compare action", () => {
    const actions = planCanvas("compare the front vs the rear", m4Images, emptyState);
    expect(actions[0]?.op).toBe("compare");
  });
});

// ── ViewStateSchema parses a valid state ──────────────────────────────────────

describe("ViewStateSchema", () => {
  it("parses a complete ViewState", () => {
    const raw = {
      layout: "single",
      items: [{ kind: "image", carId: "CAR-A", imageId: "img-front" }],
      zoom: { itemIndex: 0, region: [0.1, 0.2, 0.5, 0.4] },
      marks: [{ itemIndex: 0, box: [0.0, 0.0, 0.2, 0.1], label: "badge" }],
      caption: "Front of the car"
    };
    expect(() => ViewStateSchema.parse(raw)).not.toThrow();
  });

  it("parses a generated pending item", () => {
    const raw = {
      layout: "grid",
      items: [{ kind: "generated", id: "gen-1", prompt: "yellow M4", status: "pending" }]
    };
    expect(() => ViewStateSchema.parse(raw)).not.toThrow();
  });

  it("parses a car card item", () => {
    const raw = {
      layout: "focus",
      items: [{ kind: "car", carId: "CAR-A" }]
    };
    expect(() => ViewStateSchema.parse(raw)).not.toThrow();
  });

  it("parses a spec card item", () => {
    const raw = {
      layout: "spec",
      items: [{
        kind: "spec",
        title: "Pricing",
        rows: [{ label: "Total Possible Savings", value: "Up to $12,500", emphasis: "total", separatorBefore: true }]
      }]
    };
    expect(() => ViewStateSchema.parse(raw)).not.toThrow();
  });
});

// ── Existing CarImageSchema still parses images.json unchanged ────────────────

describe("backward compatibility: CarImageSchema", () => {
  it("parses existing images.json without changes", () => {
    const images = CarImageSchema.array().parse(
      JSON.parse(readFileSync("data/images.json", "utf8"))
    );
    expect(images.filter((img) => img.vin === "BMW-M4")).toHaveLength(46);
    // New optional fields default safely
    expect(images.every((img) => Array.isArray(img.boxes))).toBe(true);
    expect(images.every((img) => typeof img.zoomTargets === "object")).toBe(true);
    expect(images.every((img) => Array.isArray(img.pairs))).toBe(true);
  });
});
