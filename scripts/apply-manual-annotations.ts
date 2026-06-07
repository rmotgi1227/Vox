/**
 * Re-runnable image enrichment pass for the BMW M4 image catalog.
 *
 * Every BMW-M4 image in data/images.json has been visually reviewed from
 * role-based contact sheets. Close-up photos get object-specific boxes; wide
 * overview photos intentionally get only major, useful regions. The trunk and
 * center-console records keep their original hand-verified annotations.
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

function annotation(boxes: Box[], aliases: Record<string, string[]>, extras: Omit<Annotation, "boxes" | "zoomTargets"> = {}): Annotation {
  const zoomTargets: Record<string, BBox> = {};
  for (const box of boxes) {
    zoomTargets[box.label.toLowerCase()] = box.box;
    for (const alias of aliases[box.label] ?? []) zoomTargets[alias] = box.box;
  }
  return { boxes, zoomTargets, ...extras };
}

const REVIEWED_ANNOTATIONS: Record<string, Annotation> = {
  "bmw-m4-2018-bmw-m4-pic-1319146320583892681-1024x768": annotation([
    { label: "Infotainment navigation screen", box: [0.07, 0.08, 0.62, 0.35] },
    { label: "Carbon-fiber dashboard trim", box: [0, 0.38, 0.95, 0.18] },
    { label: "Center vents", box: [0.1, 0.52, 0.65, 0.28] },
    { label: "Hazard and lock buttons", box: [0.48, 0.48, 0.12, 0.25] },
    { label: "Radio preset row", box: [0.43, 0.75, 0.45, 0.12] }
  ], {
    "Infotainment navigation screen": ["screen", "infotainment", "navigation", "nav", "display"],
    "Carbon-fiber dashboard trim": ["carbon dash", "carbon trim", "dashboard trim"],
    "Center vents": ["vents", "center vents", "air vents"],
    "Hazard and lock buttons": ["hazard button", "lock button", "dash buttons"],
    "Radio preset row": ["radio buttons", "preset buttons", "climate controls"]
  }),
  "bmw-m4-2018-bmw-m4-pic-1461017558474954336-1024x768": annotation([
    { label: "Vehicle history paperwork", box: [0.08, 0.05, 0.55, 0.58] },
    { label: "Two BMW key fobs", box: [0.54, 0.43, 0.34, 0.28] },
    { label: "Dealer tags", box: [0.53, 0.48, 0.34, 0.34] }
  ], {
    "Vehicle history paperwork": ["paperwork", "documents", "CARFAX", "history report"],
    "Two BMW key fobs": ["keys", "key fobs", "spare key"],
    "Dealer tags": ["dealer tag", "yellow tag", "listing tag"]
  }),
  "bmw-m4-2018-bmw-m4-pic-1574830017944435581-1024x768": annotation([
    { label: "Driver M sport seat", box: [0.05, 0.08, 0.45, 0.79] },
    { label: "Illuminated M4 seat badge", box: [0.34, 0.17, 0.08, 0.06] },
    { label: "Center console controls", box: [0.48, 0.38, 0.37, 0.38] },
    { label: "Door sill trim", box: [0.07, 0.83, 0.33, 0.1] }
  ], {
    "Driver M sport seat": ["driver seat", "front seat", "sport seat", "bucket seat"],
    "Illuminated M4 seat badge": ["M4 badge", "seat badge"],
    "Center console controls": ["center console", "gear selector", "iDrive", "shifter"],
    "Door sill trim": ["door sill", "sill plate"]
  }),
  "bmw-m4-2018-bmw-m4-pic-1601741309887650709-1024x768": annotation([
    { label: "Wheel and tire", box: [0.17, 0.05, 0.68, 0.85] },
    { label: "Blue M brake caliper", box: [0.22, 0.44, 0.18, 0.22] },
    { label: "Drilled brake rotor", box: [0.43, 0.24, 0.25, 0.38] },
    { label: "Fender vent", box: [0.02, 0.2, 0.12, 0.12] },
    { label: "Side marker and parking sensors", box: [0.84, 0.25, 0.1, 0.38] }
  ], {
    "Wheel and tire": ["wheel", "rim", "tire", "tyre"],
    "Blue M brake caliper": ["caliper", "brake caliper", "blue caliper", "brakes"],
    "Drilled brake rotor": ["rotor", "brake rotor", "drilled rotor"],
    "Fender vent": ["side vent", "fender vent"],
    "Side marker and parking sensors": ["side marker", "parking sensor", "front sensor"]
  }),
  "bmw-m4-2018-bmw-m4-pic-1766761240484396677-1024x768": annotation([
    { label: "Black kidney grille", box: [0.08, 0.21, 0.25, 0.2] },
    { label: "Driver-side LED headlight", box: [0.3, 0.18, 0.52, 0.22] },
    { label: "Front parking sensor", box: [0.57, 0.48, 0.05, 0.06] },
    { label: "Lower mesh intake", box: [0.25, 0.62, 0.33, 0.26] },
    { label: "Carbon-fiber front splitter", box: [0.05, 0.82, 0.65, 0.12] }
  ], {
    "Black kidney grille": ["grille", "kidney grille"],
    "Driver-side LED headlight": ["headlight", "LED headlight", "headlights"],
    "Front parking sensor": ["parking sensor", "front sensor"],
    "Lower mesh intake": ["lower intake", "mesh intake", "front intake"],
    "Carbon-fiber front splitter": ["front lip", "splitter", "carbon lip"]
  }),
  "bmw-m4-2018-bmw-m4-pic-1837515697934941645-1024x768": annotation([
    { label: "Harman Kardon speaker grille", box: [0.08, 0.04, 0.75, 0.75] },
    { label: "Harman Kardon badge", box: [0.31, 0.59, 0.33, 0.1] }
  ], {
    "Harman Kardon speaker grille": ["speaker", "speaker grille", "audio", "tweeter"],
    "Harman Kardon badge": ["Harman Kardon", "Kardon badge", "audio badge"]
  }),
  "bmw-m4-2018-bmw-m4-pic-1898438960393315124-1024x768": annotation([
    { label: "Steering-column adjustment lever", box: [0.41, 0.4, 0.17, 0.19] },
    { label: "Heated steering wheel button", box: [0.39, 0.58, 0.15, 0.13] },
    { label: "Driver footwell", box: [0.21, 0.62, 0.46, 0.29] }
  ], {
    "Steering-column adjustment lever": ["steering column", "tilt wheel", "wheel adjustment"],
    "Heated steering wheel button": ["heated steering wheel", "heated wheel", "heat button"],
    "Driver footwell": ["footwell", "pedals", "floor mat"]
  }),
  "bmw-m4-2018-bmw-m4-pic-2086691802845276950-1024x768": annotation([
    { label: "Illuminated M4 seat badge", box: [0.52, 0.24, 0.14, 0.09] },
    { label: "Upper shoulder bolster", box: [0.26, 0.1, 0.65, 0.46] },
    { label: "Perforated leather insert", box: [0.36, 0.39, 0.48, 0.32] }
  ], {
    "Illuminated M4 seat badge": ["M4 badge", "seat badge"],
    "Upper shoulder bolster": ["bolster", "shoulder bolster", "sport seat"],
    "Perforated leather insert": ["perforated leather", "seat insert", "leather"]
  }),
  "bmw-m4-2018-bmw-m4-pic-2276727283337289750-1024x768": annotation([
    { label: "Driver sport seat", box: [0.1, 0.12, 0.48, 0.78] },
    { label: "Passenger sport seat", box: [0.54, 0.14, 0.25, 0.38] },
    { label: "Center console", box: [0.51, 0.47, 0.38, 0.33] },
    { label: "Dashboard stack", box: [0.68, 0.2, 0.28, 0.34] }
  ], {
    "Driver sport seat": ["driver seat", "front seat", "seat bolsters"],
    "Passenger sport seat": ["passenger seat", "front passenger seat"],
    "Center console": ["center console", "gear selector", "iDrive"],
    "Dashboard stack": ["dashboard", "climate controls", "center stack"]
  }),
  "bmw-m4-2018-bmw-m4-pic-2621075048170827325-1024x768": annotation([
    { label: "Front three-quarter body", box: [0.13, 0.17, 0.75, 0.62] },
    { label: "Black kidney grille", box: [0.62, 0.45, 0.15, 0.11] },
    { label: "LED headlights", box: [0.42, 0.42, 0.34, 0.12] },
    { label: "Carbon-fiber front lip", box: [0.45, 0.64, 0.32, 0.09] },
    { label: "Front wheel and blue caliper", box: [0.33, 0.56, 0.14, 0.18] },
    { label: "Carbon mirror cap", box: [0.41, 0.29, 0.08, 0.08] }
  ], {
    "Front three-quarter body": ["front view", "whole car", "front exterior"],
    "Black kidney grille": ["grille", "kidney grille"],
    "LED headlights": ["headlights", "lights"],
    "Carbon-fiber front lip": ["front lip", "splitter"],
    "Front wheel and blue caliper": ["wheel", "caliper", "brakes"],
    "Carbon mirror cap": ["mirror", "carbon mirror"]
  }),
  "bmw-m4-2018-bmw-m4-pic-2653171459232803209-1024x768": annotation([
    { label: "Start/stop ignition button", box: [0.35, 0.31, 0.3, 0.42] }
  ], { "Start/stop ignition button": ["start button", "ignition", "auto start stop"] }),
  "bmw-m4-2018-bmw-m4-pic-2726043006252105822-1024x768": annotation([
    { label: "Hood and roundel area", box: [0.1, 0.17, 0.82, 0.25] },
    { label: "Black kidney grille", box: [0.32, 0.42, 0.38, 0.18] },
    { label: "LED headlights", box: [0.1, 0.39, 0.78, 0.15] },
    { label: "Lower front intakes", box: [0.15, 0.63, 0.72, 0.2] },
    { label: "Carbon-fiber lower lip", box: [0.2, 0.78, 0.6, 0.1] }
  ], {
    "Hood and roundel area": ["hood", "BMW roundel", "front badge"],
    "Black kidney grille": ["grille", "kidney grille"],
    "LED headlights": ["headlights", "lights"],
    "Lower front intakes": ["front intakes", "lower intakes"],
    "Carbon-fiber lower lip": ["front lip", "splitter", "carbon lip"]
  }),
  [CONSOLE_ID]: MANUAL_ANNOTATIONS[CONSOLE_ID],
  "bmw-m4-2018-bmw-m4-pic-2789690467330177541-1024x768": annotation([
    { label: "M drive mode button bank", box: [0.08, 0.24, 0.23, 0.48] },
    { label: "Gear selector surround", box: [0.38, 0.03, 0.52, 0.5] },
    { label: "Auto hold and parking buttons", box: [0.44, 0.62, 0.3, 0.2] }
  ], {
    "M drive mode button bank": ["drive modes", "M buttons", "button cluster", "traction button"],
    "Gear selector surround": ["gear selector", "shifter surround"],
    "Auto hold and parking buttons": ["auto hold", "parking sensor button", "camera button"]
  }),
  "bmw-m4-2018-bmw-m4-pic-2844409574140034023-1024x768": annotation([
    { label: "Front door panel", box: [0.03, 0.18, 0.92, 0.61] },
    { label: "Metallic door handle", box: [0.32, 0.44, 0.18, 0.1] },
    { label: "Window and mirror switches", box: [0.54, 0.55, 0.2, 0.08] },
    { label: "Door speaker area", box: [0.81, 0.15, 0.13, 0.14] }
  ], {
    "Front door panel": ["door panel", "door trim"],
    "Metallic door handle": ["door handle", "handle"],
    "Window and mirror switches": ["window switches", "mirror controls"],
    "Door speaker area": ["speaker", "door speaker"]
  }),
  "bmw-m4-2018-bmw-m4-pic-3808784972398941726-1024x768": annotation([
    { label: "Driver-side profile", box: [0.04, 0.14, 0.9, 0.62] },
    { label: "Carbon mirror cap", box: [0.58, 0.33, 0.12, 0.12] },
    { label: "M side fender vent", box: [0.42, 0.55, 0.12, 0.13] },
    { label: "Carbon roofline", box: [0.23, 0.12, 0.55, 0.18] },
    { label: "Front wheel", box: [0.03, 0.6, 0.2, 0.26] }
  ], {
    "Driver-side profile": ["side profile", "driver side", "whole side"],
    "Carbon mirror cap": ["mirror", "carbon mirror"],
    "M side fender vent": ["side vent", "fender vent"],
    "Carbon roofline": ["roof", "carbon roof", "roofline"],
    "Front wheel": ["wheel", "front wheel"]
  }),
  "bmw-m4-2018-bmw-m4-pic-3945500231103837349-1024x768": annotation([
    { label: "Driver-side LED headlight", box: [0.11, 0.06, 0.76, 0.24] },
    { label: "Front parking sensor", box: [0.62, 0.46, 0.08, 0.08] },
    { label: "Lower mesh intake", box: [0.22, 0.61, 0.45, 0.28] },
    { label: "Carbon-fiber splitter trim", box: [0.15, 0.83, 0.57, 0.12] }
  ], {
    "Driver-side LED headlight": ["headlight", "LED headlight"],
    "Front parking sensor": ["parking sensor", "front sensor"],
    "Lower mesh intake": ["intake", "mesh intake"],
    "Carbon-fiber splitter trim": ["splitter", "front lip", "carbon trim"]
  }),
  "bmw-m4-2018-bmw-m4-pic-3986400956717864468-1024x768": annotation([
    { label: "Carbon-fiber mirror cap", box: [0.08, 0.05, 0.82, 0.72] }
  ], { "Carbon-fiber mirror cap": ["mirror", "mirror cap", "carbon mirror", "carbon weave"] }),
  "bmw-m4-2018-bmw-m4-pic-4040769667739339279-1024x768": annotation([
    { label: "Rear seats", box: [0.1, 0.18, 0.78, 0.58] },
    { label: "Center pass-through armrest", box: [0.4, 0.57, 0.2, 0.16] },
    { label: "Rear seat belts", box: [0.08, 0.24, 0.8, 0.45] },
    { label: "Side speaker", box: [0.75, 0.58, 0.14, 0.22] },
    { label: "Rear door panel", box: [0.03, 0.12, 0.22, 0.3] }
  ], {
    "Rear seats": ["rear seats", "back seats", "second row"],
    "Center pass-through armrest": ["armrest", "pass-through", "center armrest"],
    "Rear seat belts": ["seat belts", "rear belts"],
    "Side speaker": ["speaker", "rear speaker"],
    "Rear door panel": ["rear door panel", "side panel"]
  }),
  "bmw-m4-2018-bmw-m4-pic-4110894274945754678-1024x768": annotation([
    { label: "Front three-quarter body", box: [0.13, 0.16, 0.74, 0.67] },
    { label: "Black kidney grille", box: [0.59, 0.43, 0.18, 0.12] },
    { label: "LED headlights", box: [0.38, 0.39, 0.37, 0.13] },
    { label: "Carbon-fiber front splitter", box: [0.4, 0.64, 0.35, 0.09] },
    { label: "Front wheel and blue caliper", box: [0.16, 0.55, 0.2, 0.25] },
    { label: "M4 fender badge", box: [0.32, 0.53, 0.06, 0.07] }
  ], {
    "Front three-quarter body": ["front view", "whole car", "front exterior"],
    "Black kidney grille": ["grille", "kidney grille"],
    "LED headlights": ["headlights", "lights"],
    "Carbon-fiber front splitter": ["front splitter", "front lip"],
    "Front wheel and blue caliper": ["wheel", "caliper"],
    "M4 fender badge": ["M4 badge", "side badge"]
  }),
  "bmw-m4-2018-bmw-m4-pic-4214590209273371403-1024x768": annotation([
    { label: "Passenger-side front body", box: [0.1, 0.15, 0.78, 0.7] },
    { label: "Black kidney grille", box: [0.16, 0.44, 0.25, 0.14] },
    { label: "LED headlights", box: [0.24, 0.37, 0.38, 0.13] },
    { label: "Carbon-fiber front lip", box: [0.12, 0.66, 0.34, 0.11] },
    { label: "Front wheel and blue caliper", box: [0.67, 0.56, 0.22, 0.27] },
    { label: "Carbon mirror cap", box: [0.72, 0.32, 0.1, 0.08] }
  ], {
    "Passenger-side front body": ["front view", "passenger side", "whole car"],
    "Black kidney grille": ["grille", "kidney grille"],
    "LED headlights": ["headlights"],
    "Carbon-fiber front lip": ["front lip", "splitter"],
    "Front wheel and blue caliper": ["wheel", "caliper"],
    "Carbon mirror cap": ["mirror", "carbon mirror"]
  }),
  "bmw-m4-2018-bmw-m4-pic-4238769745495923074-1024x768": annotation([
    { label: "M steering wheel", box: [0.05, 0.2, 0.38, 0.42] },
    { label: "Analog gauge cluster", box: [0.29, 0.23, 0.24, 0.2] },
    { label: "Infotainment screen", box: [0.58, 0.2, 0.2, 0.13] },
    { label: "Center console", box: [0.53, 0.53, 0.3, 0.35] }
  ], {
    "M steering wheel": ["steering wheel", "M wheel"],
    "Analog gauge cluster": ["gauge cluster", "gauges", "instrument cluster"],
    "Infotainment screen": ["screen", "infotainment", "navigation"],
    "Center console": ["center console", "gear selector", "iDrive"]
  }),
  "bmw-m4-2018-bmw-m4-pic-4486786565089773980-1024x768": annotation([
    { label: "Fixed carbon-fiber roof", box: [0.08, 0.02, 0.78, 0.55] },
    { label: "Windshield sensor area", box: [0.52, 0.55, 0.24, 0.24] }
  ], {
    "Fixed carbon-fiber roof": ["roof", "carbon roof", "carbon-fiber roof"],
    "Windshield sensor area": ["windshield sensor", "rain sensor", "camera sensor"]
  }),
  "bmw-m4-2018-bmw-m4-pic-4488936319955355889-1024x768": annotation([
    { label: "Wheel and tire", box: [0.1, 0.08, 0.82, 0.82] },
    { label: "Blue M brake caliper", box: [0.62, 0.45, 0.13, 0.18] },
    { label: "Drilled brake rotor", box: [0.4, 0.25, 0.32, 0.38] }
  ], {
    "Wheel and tire": ["wheel", "rim", "tire"],
    "Blue M brake caliper": ["caliper", "brake caliper", "blue caliper"],
    "Drilled brake rotor": ["rotor", "brake rotor", "drilled rotor"]
  }),
  "bmw-m4-2018-bmw-m4-pic-451414797559271998-1024x768": annotation([
    { label: "Front three-quarter body", box: [0.1, 0.13, 0.78, 0.68] },
    { label: "Black kidney grille", box: [0.16, 0.44, 0.2, 0.12] },
    { label: "LED headlights", box: [0.24, 0.37, 0.32, 0.13] },
    { label: "Front wheel and blue caliper", box: [0.58, 0.55, 0.21, 0.25] },
    { label: "Carbon mirror cap", box: [0.73, 0.31, 0.1, 0.08] },
    { label: "Fixed carbon-fiber roof", box: [0.36, 0.17, 0.37, 0.11] }
  ], {
    "Front three-quarter body": ["front view", "whole car"],
    "Black kidney grille": ["grille", "kidney grille"],
    "LED headlights": ["headlights"],
    "Front wheel and blue caliper": ["wheel", "caliper"],
    "Carbon mirror cap": ["mirror", "carbon mirror"],
    "Fixed carbon-fiber roof": ["roof", "carbon roof"]
  }),
  "bmw-m4-2018-bmw-m4-pic-4721686708242508219-1024x768": annotation([
    { label: "Both front sport seats", box: [0.06, 0.42, 0.84, 0.44] },
    { label: "Dashboard and screen", box: [0.5, 0.2, 0.34, 0.2] },
    { label: "Center console", box: [0.35, 0.44, 0.36, 0.28] },
    { label: "M steering wheel", box: [0.13, 0.24, 0.22, 0.28] }
  ], {
    "Both front sport seats": ["front seats", "seats", "sport seats"],
    "Dashboard and screen": ["dashboard", "screen", "infotainment"],
    "Center console": ["center console", "gear selector", "iDrive"],
    "M steering wheel": ["steering wheel", "M wheel"]
  }),
  "bmw-m4-2018-bmw-m4-pic-4794197077752663538-1024x768": annotation([
    { label: "Driver seat cushion", box: [0.18, 0.27, 0.7, 0.52] },
    { label: "Seat adjustment controls", box: [0.66, 0.72, 0.2, 0.12] },
    { label: "Lower seat bolster", box: [0.22, 0.18, 0.32, 0.38] }
  ], {
    "Driver seat cushion": ["driver seat", "seat cushion", "leather"],
    "Seat adjustment controls": ["seat controls", "power seat controls"],
    "Lower seat bolster": ["seat bolster", "bolster"]
  }),
  "bmw-m4-2018-bmw-m4-pic-484760766590437126-1024x768": annotation([
    { label: "Wheel and tire", box: [0.08, 0.12, 0.86, 0.83] },
    { label: "Blue M brake caliper", box: [0.63, 0.45, 0.16, 0.21] },
    { label: "Drilled brake rotor", box: [0.39, 0.3, 0.33, 0.35] },
    { label: "Parking sensor", box: [0.07, 0.51, 0.07, 0.07] }
  ], {
    "Wheel and tire": ["wheel", "rim", "tire"],
    "Blue M brake caliper": ["caliper", "brake caliper"],
    "Drilled brake rotor": ["rotor", "brake rotor"],
    "Parking sensor": ["parking sensor", "front sensor"]
  }),
  "bmw-m4-2018-bmw-m4-pic-5049083477197904547-1024x768": annotation([
    { label: "M steering wheel", box: [0.06, 0.2, 0.28, 0.35] },
    { label: "Driver M sport seat", box: [0.4, 0.18, 0.48, 0.68] },
    { label: "M4 seat badge", box: [0.74, 0.31, 0.1, 0.06] },
    { label: "Center console", box: [0.3, 0.42, 0.3, 0.28] }
  ], {
    "M steering wheel": ["steering wheel", "M wheel"],
    "Driver M sport seat": ["driver seat", "sport seat"],
    "M4 seat badge": ["seat badge", "M4 badge"],
    "Center console": ["center console", "gear selector"]
  }),
  "bmw-m4-2018-bmw-m4-pic-5525810426135904896-1024x768": annotation([
    { label: "M steering wheel", box: [0.05, 0.17, 0.3, 0.35] },
    { label: "Gauge cluster", box: [0.18, 0.16, 0.22, 0.16] },
    { label: "Driver sport seat", box: [0.42, 0.16, 0.48, 0.67] },
    { label: "M4 seat badge", box: [0.78, 0.38, 0.09, 0.06] },
    { label: "Center console", box: [0.32, 0.44, 0.28, 0.3] }
  ], {
    "M steering wheel": ["steering wheel"],
    "Gauge cluster": ["gauges", "instrument cluster"],
    "Driver sport seat": ["driver seat", "sport seat"],
    "M4 seat badge": ["seat badge", "M4 badge"],
    "Center console": ["center console", "iDrive", "shifter"]
  }),
  "bmw-m4-2018-bmw-m4-pic-5623678729793805385-1024x768": annotation([
    { label: "Window switches", box: [0.1, 0.24, 0.48, 0.38] },
    { label: "Mirror adjustment controls", box: [0.55, 0.16, 0.32, 0.32] },
    { label: "Door trim strip", box: [0.04, 0.05, 0.8, 0.12] }
  ], {
    "Window switches": ["window switches", "power windows"],
    "Mirror adjustment controls": ["mirror controls", "mirror switch"],
    "Door trim strip": ["door trim", "chrome strip"]
  }),
  "bmw-m4-2018-bmw-m4-pic-5941831823260090686-1024x768": annotation([
    { label: "Carbon-fiber rear spoiler", box: [0.03, 0.09, 0.88, 0.29] },
    { label: "M4 decklid badge", box: [0.54, 0.46, 0.18, 0.12] },
    { label: "BMW roundel", box: [0.44, 0.48, 0.12, 0.12] },
    { label: "Taillight corner", box: [0.78, 0.42, 0.18, 0.25] }
  ], {
    "Carbon-fiber rear spoiler": ["rear spoiler", "spoiler", "carbon spoiler"],
    "M4 decklid badge": ["M4 badge", "rear badge"],
    "BMW roundel": ["BMW badge", "roundel"],
    "Taillight corner": ["taillight", "tail light"]
  }),
  "bmw-m4-2018-bmw-m4-pic-6067196514796051126-1024x768": annotation([
    { label: "Hood and roundel area", box: [0.17, 0.15, 0.66, 0.26] },
    { label: "Black kidney grille", box: [0.3, 0.41, 0.4, 0.2] },
    { label: "LED headlights", box: [0.15, 0.38, 0.7, 0.17] },
    { label: "Lower front intakes", box: [0.17, 0.65, 0.68, 0.18] },
    { label: "Carbon-fiber front lip", box: [0.2, 0.78, 0.6, 0.1] }
  ], {
    "Hood and roundel area": ["hood", "BMW roundel"],
    "Black kidney grille": ["grille", "kidney grille"],
    "LED headlights": ["headlights"],
    "Lower front intakes": ["intakes", "lower intakes"],
    "Carbon-fiber front lip": ["front lip", "splitter"]
  }),
  "bmw-m4-2018-bmw-m4-pic-6106354617978587640-1024x768": annotation([
    { label: "Trunk lid and spoiler", box: [0.14, 0.22, 0.72, 0.18] },
    { label: "LED taillights", box: [0.08, 0.36, 0.82, 0.2] },
    { label: "M4 badge and BMW roundel", box: [0.42, 0.34, 0.27, 0.12] },
    { label: "Rear parking sensors", box: [0.16, 0.65, 0.7, 0.06] },
    { label: "Quad exhaust area", box: [0.25, 0.77, 0.5, 0.1] }
  ], {
    "Trunk lid and spoiler": ["trunk lid", "rear spoiler", "spoiler"],
    "LED taillights": ["taillights", "tail lights"],
    "M4 badge and BMW roundel": ["M4 badge", "BMW roundel", "rear badge"],
    "Rear parking sensors": ["parking sensors", "rear sensors"],
    "Quad exhaust area": ["exhaust", "quad exhaust", "tailpipes"]
  }),
  "bmw-m4-2018-bmw-m4-pic-6552539966441152689-1024x768": annotation([
    { label: "Front three-quarter body", box: [0.1, 0.14, 0.78, 0.67] },
    { label: "Black kidney grille", box: [0.22, 0.43, 0.2, 0.12] },
    { label: "LED headlights", box: [0.32, 0.36, 0.3, 0.12] },
    { label: "Carbon-fiber front lip", box: [0.19, 0.63, 0.35, 0.11] },
    { label: "Front wheel and blue caliper", box: [0.58, 0.55, 0.2, 0.24] },
    { label: "Fixed carbon-fiber roof", box: [0.39, 0.16, 0.33, 0.11] },
    { label: "Carbon mirror cap", box: [0.66, 0.31, 0.09, 0.08] }
  ], {
    "Front three-quarter body": ["front view", "whole car"],
    "Black kidney grille": ["grille"],
    "LED headlights": ["headlights"],
    "Carbon-fiber front lip": ["front lip", "splitter"],
    "Front wheel and blue caliper": ["wheel", "caliper"],
    "Fixed carbon-fiber roof": ["roof", "carbon roof"],
    "Carbon mirror cap": ["mirror", "carbon mirror"]
  }),
  "bmw-m4-2018-bmw-m4-pic-7110463340821385256-1024x768": annotation([
    { label: "Front door panel", box: [0.03, 0.18, 0.92, 0.61] },
    { label: "Metallic door handle", box: [0.32, 0.44, 0.18, 0.1] },
    { label: "Lower door pocket", box: [0.36, 0.68, 0.45, 0.14] },
    { label: "Door speaker area", box: [0.81, 0.15, 0.13, 0.14] }
  ], {
    "Front door panel": ["door panel", "door trim"],
    "Metallic door handle": ["door handle"],
    "Lower door pocket": ["storage pocket", "door pocket"],
    "Door speaker area": ["speaker", "door speaker"]
  }),
  "bmw-m4-2018-bmw-m4-pic-7153278583895275358-1024x768": annotation([
    { label: "Head-up display projection area", box: [0.32, 0.37, 0.2, 0.2] },
    { label: "Stitched dashboard top", box: [0.05, 0.5, 0.85, 0.28] },
    { label: "Windshield glass", box: [0.02, 0.02, 0.9, 0.56] }
  ], {
    "Head-up display projection area": ["HUD", "head-up display", "projection area"],
    "Stitched dashboard top": ["stitched dash", "dashboard"],
    "Windshield glass": ["windshield", "glass"]
  }),
  "bmw-m4-2018-bmw-m4-pic-7187071185038959370-1024x768": annotation([
    { label: "Rear quarter body", box: [0.09, 0.23, 0.76, 0.5] },
    { label: "Carbon-fiber rear spoiler", box: [0.22, 0.38, 0.35, 0.08] },
    { label: "Passenger-side taillight", box: [0.25, 0.43, 0.35, 0.14] },
    { label: "Rear wheel", box: [0.56, 0.57, 0.2, 0.25] },
    { label: "Fuel door", box: [0.74, 0.35, 0.08, 0.08] },
    { label: "Carbon roofline", box: [0.43, 0.19, 0.33, 0.1] }
  ], {
    "Rear quarter body": ["rear quarter", "rear view", "side profile"],
    "Carbon-fiber rear spoiler": ["spoiler", "rear spoiler"],
    "Passenger-side taillight": ["taillight", "tail light"],
    "Rear wheel": ["wheel", "rear wheel"],
    "Fuel door": ["fuel door", "gas cap"],
    "Carbon roofline": ["roof", "carbon roof"]
  }),
  "bmw-m4-2018-bmw-m4-pic-7400799656167128024-1024x768": annotation([
    { label: "BMW M Power engine cover", box: [0.35, 0.33, 0.32, 0.3] },
    { label: "Carbon-fiber strut brace", box: [0.17, 0.26, 0.6, 0.18] },
    { label: "Fluid reservoir area", box: [0.08, 0.31, 0.17, 0.18] },
    { label: "Hood underside", box: [0.02, 0.02, 0.9, 0.23] }
  ], {
    "BMW M Power engine cover": ["engine", "engine cover", "M Power"],
    "Carbon-fiber strut brace": ["strut brace", "carbon brace"],
    "Fluid reservoir area": ["fluid reservoirs", "reservoir"],
    "Hood underside": ["hood open", "hood underside"]
  }),
  "bmw-m4-2018-bmw-m4-pic-7410222045381061820-1024x768": annotation([
    { label: "Driver-side body profile", box: [0.02, 0.18, 0.92, 0.62] },
    { label: "Fixed carbon-fiber roof", box: [0.2, 0.18, 0.45, 0.12] },
    { label: "Carbon mirror cap", box: [0.58, 0.35, 0.12, 0.11] },
    { label: "M side fender vent", box: [0.41, 0.57, 0.13, 0.14] },
    { label: "Front wheel and blue caliper", box: [0.79, 0.63, 0.18, 0.27] }
  ], {
    "Driver-side body profile": ["side profile", "driver side"],
    "Fixed carbon-fiber roof": ["roof", "carbon roof"],
    "Carbon mirror cap": ["mirror", "carbon mirror"],
    "M side fender vent": ["side vent", "fender vent"],
    "Front wheel and blue caliper": ["wheel", "caliper"]
  }),
  [TRUNK_ID]: MANUAL_ANNOTATIONS[TRUNK_ID],
  "bmw-m4-2018-bmw-m4-pic-7487615400679472699-1024x768": annotation([
    { label: "Wheel and tire", box: [0.13, 0.08, 0.8, 0.85] },
    { label: "Blue M brake caliper", box: [0.23, 0.54, 0.17, 0.19] },
    { label: "Drilled brake rotor", box: [0.43, 0.26, 0.29, 0.39] }
  ], {
    "Wheel and tire": ["wheel", "rim", "tire"],
    "Blue M brake caliper": ["caliper", "brake caliper"],
    "Drilled brake rotor": ["rotor", "brake rotor"]
  }),
  "bmw-m4-2018-bmw-m4-pic-8290056972928963492-1024x768": annotation([
    { label: "Rear quarter body", box: [0.08, 0.22, 0.76, 0.55] },
    { label: "Driver-side taillight", box: [0.58, 0.42, 0.22, 0.15] },
    { label: "Carbon-fiber rear spoiler", box: [0.62, 0.32, 0.21, 0.08] },
    { label: "Rear wheel", box: [0.2, 0.57, 0.18, 0.24] },
    { label: "M side fender vent", box: [0.11, 0.44, 0.08, 0.1] }
  ], {
    "Rear quarter body": ["rear quarter", "rear view", "side profile"],
    "Driver-side taillight": ["taillight", "tail light"],
    "Carbon-fiber rear spoiler": ["spoiler", "rear spoiler"],
    "Rear wheel": ["wheel", "rear wheel"],
    "M side fender vent": ["side vent", "fender vent"]
  }),
  "bmw-m4-2018-bmw-m4-pic-8353526881053628670-1024x768": annotation([
    { label: "Lower dash control button", box: [0.36, 0.2, 0.34, 0.22] },
    { label: "Driver footwell", box: [0.26, 0.52, 0.52, 0.42] }
  ], {
    "Lower dash control button": ["button", "control button", "green indicator"],
    "Driver footwell": ["footwell", "pedals", "floor mat"]
  }),
  "bmw-m4-2018-bmw-m4-pic-8359900914109193764-1024x768": annotation([
    { label: "BMW hood roundel", box: [0.4, 0.23, 0.12, 0.12] },
    { label: "Black kidney grille", box: [0.18, 0.56, 0.7, 0.36] },
    { label: "White hood edge", box: [0.02, 0.02, 0.9, 0.43] }
  ], {
    "BMW hood roundel": ["BMW roundel", "front badge"],
    "Black kidney grille": ["grille", "kidney grille"],
    "White hood edge": ["hood", "hood edge"]
  }),
  "bmw-m4-2018-bmw-m4-pic-8814846783763534499-1024x768": annotation([
    { label: "Center armrest", box: [0.34, 0.41, 0.43, 0.25] },
    { label: "Manual parking brake", box: [0.18, 0.49, 0.2, 0.15] },
    { label: "iDrive controller", box: [0.12, 0.28, 0.16, 0.16] },
    { label: "Passenger sport seat", box: [0.55, 0.16, 0.3, 0.52] },
    { label: "Rear seat edge", box: [0.78, 0.45, 0.16, 0.2] }
  ], {
    "Center armrest": ["armrest", "center armrest"],
    "Manual parking brake": ["parking brake", "handbrake"],
    "iDrive controller": ["iDrive", "controller"],
    "Passenger sport seat": ["passenger seat", "front seat"],
    "Rear seat edge": ["rear seat", "back seat"]
  })
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

    const annotation = REVIEWED_ANNOTATIONS[record.id];
    if (!annotation) {
      throw new Error(`Missing manual-reviewed annotation for ${record.id}. Inspect it before enriching the M4 index.`);
    }
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
