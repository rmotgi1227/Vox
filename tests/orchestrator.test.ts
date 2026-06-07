import { describe, expect, it } from "vitest";
import { orchestrateSpecialistTurn } from "@vox/agent-core";
import type { Car, CarImage } from "@vox/core";

const car: Car = {
  vin: "v", year: 2026, make: "BMW", model: "M4", trim: "Demo", body: "Coupe",
  drivetrain: "RWD", fuel: "Gas", price: null, mileage: 0, color: "Demo",
  features: ["sport interior"], availability: "available", description: "demo"
};

const images: CarImage[] = [
  { id: "front", vin: "v", url: "/front.jpg", role: "exterior_front", caption: "front view", visibleFeatures: [], confidence: 1, status: "processed" },
  { id: "interior", vin: "v", url: "/int.jpg", role: "interior_front", caption: "interior view", visibleFeatures: ["seats"], confidence: 1, status: "processed" }
];

describe("specialist orchestration", () => {
  it("returns a typed image-change action", async () => {
    const turn = await orchestrateSpecialistTurn({
      catalog: { getCar: async () => car, listImages: async () => images },
      ai: {
        searchMoss: async () => [{ id: "v", label: "M4", text: "demo" }],
        generateReply: async () => "Here is the interior view."
      }
    }, { vin: "v", message: "show interior", currentImageId: "front" });
    expect(turn.selectedImageId).toBe("interior");
    expect(turn.action.type).toBe("show_image");
  });
});
