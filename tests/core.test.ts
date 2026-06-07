import { describe, expect, it } from "vitest";
import { CarImageSchema, CarSchema, carFactSheet } from "@vox/core";
import { rankImagesForQuestion, selectImageForQuestion } from "@vox/agent-core";

const images = [
  CarImageSchema.parse({ id: "front", vin: "v", url: "/front.jpg", role: "exterior_front", caption: "front", visibleFeatures: ["headlights"], conditionNotes: [], searchTags: ["front bumper"], confidence: 1, status: "processed" }),
  CarImageSchema.parse({ id: "interior", vin: "v", url: "/int.jpg", role: "interior_front", caption: "interior", visibleFeatures: ["seats"], conditionNotes: [], searchTags: ["front cabin"], confidence: 1, status: "processed" }),
  CarImageSchema.parse({ id: "wheel", vin: "v", url: "/wheel.jpg", role: "wheel", caption: "wheel", visibleFeatures: ["brake"], conditionNotes: [], searchTags: ["brake caliper"], confidence: 1, status: "processed" })
];

describe("core schemas", () => {
  it("validates car data", () => {
    expect(() => CarSchema.parse({
      vin: "x", year: 2026, make: "BMW", model: "M4", trim: "Demo", body: "Coupe",
      drivetrain: "RWD", fuel: "Gas", price: null, mileage: 0, color: "Demo",
      features: [], availability: "available", description: "demo"
    })).not.toThrow();
  });

  it("includes pricing guidance in the grounded fact sheet", () => {
    const car = CarSchema.parse({
      vin: "x", year: 2026, make: "BMW", model: "M4", trim: "Demo", body: "Coupe",
      drivetrain: "RWD", fuel: "Gas", price: 89900, mileage: 0, color: "Demo",
      features: [], availability: "available", description: "demo",
      specs: {
        condition: "New",
        vin: "WBS123",
        stockNumber: "M4-1",
        msrp: 92595,
        exteriorColor: "Demo",
        interiorColor: "Black",
        engine: "I6",
        horsepower: 503,
        torque: "479 lb-ft",
        transmission: "8-speed automatic",
        zeroToSixtySeconds: 3.8,
        topSpeedMph: 155,
        fuelType: "Premium",
        mpgCity: 16,
        mpgHighway: 23,
        mpgCombined: 19,
        fuelTankGallons: 15.6,
        seating: 4,
        doors: 2,
        warranty: "4-year / 50,000-mile",
        packages: [],
        options: []
      },
      pricingGuidance: {
        incentiveRangeMin: 87000,
        incentiveRangeMax: 89900
      }
    });

    expect(carFactSheet(car)).toContain("Pricing guidance: MSRP is $92,595; our price is $89,900.");
    expect(carFactSheet(car)).toContain("target discussion range is $87,000-$89,900");
  });
});

describe("image selection", () => {
  it("selects interior images from natural language", () => {
    expect(selectImageForQuestion("show me the seats inside", images)?.id).toBe("interior");
  });

  it("selects wheel images from feature language", () => {
    expect(selectImageForQuestion("can I inspect the brakes?", images)?.id).toBe("wheel");
  });

  it("ranks structured search tags above generic text", () => {
    expect(rankImagesForQuestion("show me the brake caliper", images)[0]?.image.id).toBe("wheel");
  });
});
