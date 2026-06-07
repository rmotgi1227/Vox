# Vox — Canvas & Tool-Call Architecture Plan

**Status:** Draft for review → approve → build
**Branch:** `specialist-agent`
**Author:** generated for Krish (review before approval)
**Last updated:** 2026-06-06

---

## 0. The one-paragraph thesis

The canvas is the product. Today it can do exactly one thing — swap the whole photo — and it's driven by a fast-but-literal keyword matcher while the LLM only narrates. We are turning the canvas into a **multi-modal agent surface** that can zoom, annotate, compare, grid, switch cars, and show generated images — *without* slowing down the real-time voice. The unlock is a **fan-out, multi-lane architecture**: one user utterance fans out to independent responders, each with its own latency budget. Voice stays instant; the canvas gets a real brain on a parallel 1–3s lane; heavy work (image generation) trickles in async. Everything the canvas can do is expressed as a single typed contract (`CanvasAction` → `ViewState`) that both a fast heuristic and a slower LLM can speak — so deciders are swappable forever.

---

## 1. Goals, non-goals, constraints

### Goals
- Voice + live text feel **real-time** (≤ ~500ms to first word, streaming).
- Canvas can take **1–3s** and still feel great → it can use an LLM tool-caller.
- A **foundation** where new canvas powers are "add one tool," not "rewrite the UI."
- First-class support for: multi-image grids, filtered views ("show me the interior"), multiple cars, image annotation, image generation.
- Scales to **any dealer's car** via a one-time offline ingest pass (no hand-authoring).

### Non-goals (explicitly deferred)
- Booking / test-drive / lead-capture / financing actions. (Deferred per Krish — focus is the tool-call foundation first.)
- Replacing the voice stack (LiveKit + Deepgram + MiniMax + Cartesia stays).
- Real-time pixel analysis at speak-time (all vision work happens at ingest).

### Hard constraints (the rules we never break)
1. **The voice lane never `await`s the canvas lane.** They are independent async tracks.
2. **One contract.** The only way to change the screen is to emit a `CanvasAction`. The renderer is dumb; it draws `f(ViewState)`.
3. **All heavy intelligence is pre-computed at ingest**, not at runtime, except the canvas decider which is allowed its 1–3s budget.

### Latency budget (the three lanes)
| Lane | Budget | Backed by |
|---|---|---|
| **Voice + live text** | ≤ ~500ms first token, streaming | Deepgram STT → MiniMax streaming → Cartesia TTS (unchanged) |
| **Canvas** | 1–3s | LLM tool-caller (structured JSON) + optional instant heuristic first-paint |
| **Heavy / generated** | async, arrives whenever | image-gen provider; surfaces as `pending → ready` items |

---

## 2. Architecture overview

```
                ┌──────────────────────────────────────────────┐
   You speak ──▶│  Deepgram STT  →  finalized user utterance     │
                └───────────────┬──────────────────────────────-┘
                                │  fan-out (no serialization)
        ┌───────────────────────┼───────────────────────────────┐
        ▼                       ▼                                 ▼
  VOICE LANE              CANVAS LANE                        HEAVY LANE
  (instant)              (1–3s)                              (async)
  MiniMax stream         heuristic first-paint (optional)    image generation
  → Cartesia TTS         → LLM tool-caller emits             → pending item
  → speaks the answer       CanvasAction[]                      resolves to ready
                          → reducer → ViewState                 → patches ViewState
                          → publish over data channel           → publish patch

                All lanes publish over the existing
                LiveKit data channel topic: "vox.specialist.turn"
                The web client applies ViewState and renders f(ViewState).
```

**Two deciders, one protocol.** The heuristic (instant) and the LLM (1–3s) both emit the *same* `CanvasAction[]`. The canvas doesn't care who produced them. This is what makes the system future-proof: you can add a third decider, swap the LLM, or pre-bake actions at ingest — the renderer never changes.

---

## 3. Core abstractions (the foundation)

These four types/functions are the whole foundation. Everything in Section 7 is built on them.

### 3.1 `ViewState` — what the screen is showing (replaces `selectedImageId`)

```ts
// @vox/core
export type CanvasItem =
  | { kind: "image";     carId: string; imageId: string }
  | { kind: "generated"; id: string; prompt: string; status: "pending" | "ready" | "failed"; url?: string }
  | { kind: "car";       carId: string };   // a car "card" (for multi-car browsing)

export type BBox = [x: number, y: number, w: number, h: number]; // normalized 0..1

export type ViewState = {
  layout: "single" | "grid" | "compare" | "focus";
  items: CanvasItem[];                       // 1 for single/focus, ≤4 for grid, 2 for compare
  zoom?:  { itemIndex: number; region: BBox };
  marks?: { itemIndex: number; box: BBox; label: string }[];
  caption?: string;
};
```

The renderer is a pure function of this. New capability = new `CanvasItem.kind` or new `layout`, nothing else.

### 3.2 `CanvasAction` — the tool-call contract (extends existing `SpecialistActionSchema`)

```ts
// @vox/core — replaces/extends SpecialistActionSchema
export type CanvasAction =
  // ── Tier 1: BUILD NOW (full functionality) ─────────────────────────
  | { op: "showImage";  carId: string; imageId: string }
  | { op: "showImages"; carId?: string; imageIds?: string[]; filter?: ItemFilter; limit?: number /* ≤4 */ }
  | { op: "zoom";       itemRef: ItemRef; region: BBox | string /* named zoomTarget */ }
  // ── Tier 2: SCHEMA NOW, behavior in later phases ───────────────────
  | { op: "annotate";   itemRef: ItemRef; marks: { box: BBox; label: string }[] }   // Phase 6
  | { op: "compare";    itemRefs: [ItemRef, ItemRef] }                              // Phase 6 (fast-follow to grid)
  | { op: "focusCar";   carId: string }                                            // Phase 5
  // ── Tier 3: STUBS (in the contract, no behavior yet) ───────────────
  | { op: "generate";   prompt: string; baseRef?: ItemRef }                        // Phase 7
  | { op: "reset" };

export type ItemRef    = { carId: string; imageId: string } | { index: number }; // index = into current ViewState.items
export type ItemFilter = { carId?: string; role?: ImageRole; feature?: string; tags?: string[] };
```

- A turn may emit a **list** of actions (`CanvasAction[]`), applied in order.
- Backed by a Zod discriminated union so both the LLM (JSON output) and the heuristic produce validated actions; invalid actions are dropped, never crash the canvas.
- **The full vocabulary ships from day one; behavior fills in by phase.** The Zod union validates *all* ops immediately, but `applyAction` only fully implements Tier 1. Tier 2/3 ops are accepted, logged, and render a graceful "coming soon" placeholder (or no-op) until their phase. This keeps the **LLM decider's tool definitions stable forever** — later phases add behavior, never change the contract.

#### Tool catalog

| Tool | Does | Status | Phase |
|---|---|---|---|
| `showImage` | One image, fit to canvas (today's behavior) | **Build now** | 2 |
| `showImages` | Up to 4 at once (grid); `imageIds` now, `filter` resolution in P3 | **Build now** | 2–3 |
| `zoom` | Close-up on a region (bbox or named target) | **Build now** | 1–2, regions in 6 |
| `annotate` | Draw labeled boxes on an image ("right here") | Schema now | 6 |
| `compare` | Two images side-by-side as an intentional pairing | Schema now | 6 |
| `focusCar` | Switch/add a car (multi-car) | Schema now | 5 |
| `generate` | Image generation → `pending` item resolves to `ready` | Stub | 7 |
| `reset` | Back to default / overview | Stub | 2 |

`compare` is technically `showImages` with 2 items, but kept distinct: different intent for the agent, and a different render (aligned, labeled 2-up vs contact-sheet grid).

### 3.3 `selectItems` — the queryable catalog ("show me X" is a query)

```ts
// @vox/agent-core
export function selectItems(
  catalog: { images: CarImage[]; cars: Car[] },
  filter: ItemFilter,
  limit = 4
): CanvasItem[];
```

Generalizes `rankImagesForQuestion` (returns one) into a **set selector**. Powers "all pictures" (no filter), "interior pics" (`role: interior`), and later cross-car queries. Carries `carId` from day one so multi-car is free.

### 3.4 `applyAction` — the reducer (single source of truth for screen changes)

```ts
// @vox/agent-core
export function applyAction(state: ViewState, action: CanvasAction, catalog): ViewState;
```

Pure, synchronous, total. `generate` inserts a `pending` item; the heavy lane later patches it to `ready`. Everything that mutates the screen goes through here, so behavior is testable without a browser.

---

## 4. Repo layout — where each piece lives

| Package / file | Change |
|---|---|
| `packages/core/src/index.ts` | Add `ViewState`, `CanvasItem`, `CanvasAction`, `ItemRef`, `ItemFilter`, `BBox` Zod schemas + types. Extend `CarImageSchema` with `boxes`, `zoomTargets`, `pairs` (ingest data). |
| `packages/agent-core/src/index.ts` | Add `selectItems`, `applyAction` (reducer), and `planCanvas` (heuristic → `CanvasAction[]`, generalizes `rankImagesForQuestion`). |
| `packages/ai/src/index.ts` | Add `decideCanvasActions(...)` — the LLM tool-caller (structured JSON via existing `callMiniMaxJson` pattern). Add `generateImage(...)` (heavy lane) later. |
| `apps/agent/src/agent.ts` | Rewrite `llmNode` into the **fan-out loop**: start voice stream + run canvas lane in parallel; publish `ViewState` patches. |
| `apps/web/app/specialist/page.tsx` | Replace single-image canvas with a `ViewState` renderer; consume `view_update` data-channel events; preload images. |
| `apps/web/app/specialist/` (new) | `Canvas.tsx` — dumb renderer for `single / zoom / annotate / compare / grid` + pending tiles. |
| `data/images.json` | Add per-image `boxes`, `zoomTargets`, `pairs` (initially hand-seeded for the M4, then ingest-generated). |
| `data/catalog.json` | Add a 2nd car to exercise multi-car. |
| `scripts/` (new) | `ingest.ts` — offline VLM pass that writes the rich per-image JSON + Moss index. |

---

## 5. The runtime loop (rewrite of `agent.ts` `llmNode`)

```ts
// pseudocode — the fan-out. Voice NEVER awaits canvas.
override async llmNode(chatCtx): ReadableStream<string> {
  const message = latestUserText(chatCtx);
  const [car, images] = await Promise.all([getCar(vin), listImages(vin)]);

  // ── CANVAS LANE (fire-and-forget, parallel) ───────────────────────────
  void (async () => {
    // optional instant first-paint so something moves immediately
    const fast = planCanvas(message, images, this.viewState);   // heuristic, ~ms
    if (fast.length) this.publishViewPatch(applyActions(this.viewState, fast));

    // the real brain, 1–3s, may override the first-paint
    const actions = await decideCanvasActions({               // MiniMax JSON
      message, viewState: this.viewState, car, images, recentTurns: this.history
    });
    const next = applyActions(this.viewState, actions);
    this.viewState = next;
    this.publishViewPatch(next);

    // kick any heavy/generate actions onto the HEAVY LANE (also non-blocking)
    for (const a of actions) if (a.op === "generate") void this.runGenerate(a);
  })();

  // ── VOICE LANE (returns immediately, streams) ─────────────────────────
  const { system, user } = buildVoicePrompt({ car, image: focusOf(this.viewState), message });
  return await streamMiniMaxChat({ system, user, maxTokens: 160, timeoutMs: 12_000 });
}
```

Key properties:
- The `return` (voice) does not `await` the canvas IIFE → voice is unblocked.
- `decideCanvasActions` gets the **current `ViewState` + recent turns** → resolves "zoom into that one", "show the other side".
- Heavy/generated items run on their own lane and patch the view when ready.

---

## 6. Web rendering (`Canvas.tsx`)

- Pure function of `ViewState`: switch on `layout`.
  - `single` / `focus`: one image, fit.
  - `zoom`: CSS `transform: scale()` with `transform-origin` derived from `zoom.region`; smooth transition.
  - `annotate`: absolutely-positioned `<div>` boxes from `marks` (normalized → %).
  - `compare`: 2-up split.
  - `grid`: CSS grid up to 4; `pending` items render a shimmer tile.
- **Preload** all of the active car's images on session connect (~46 images, few MB) → no flash on grid/compare.
- Listen for `view_update` events on `vox.specialist.turn`; replace/patch local `ViewState`.
- Keep the existing transcript/status HUD and voice CTA untouched.

---

## 7. Phased delivery

Each phase is independently shippable and has a concrete demo milestone. Phases 0–3 carry **zero latency risk** (no LLM in the canvas path yet).

### Phase 0 — Contract & types *(foundation, no behavior change)*
- Add `ViewState`, `CanvasItem`, `CanvasAction`, `ItemRef`, `ItemFilter`, `BBox` to `@vox/core`.
- Add `applyAction` reducer + unit tests in `@vox/agent-core`.
- **Demo:** none (plumbing). **Risk:** none. **Exit:** types compile, reducer tested.

### Phase 1 — Dumb renderer with hardcoded ViewStates
- Build `Canvas.tsx` that renders all 5 layouts from a `ViewState` prop.
- Drive it with a dev toggle / hardcoded states.
- **Demo:** flip between single / zoom / annotate / compare / grid by hand. **You can see the wow today.** **Risk:** none.

### Phase 2 — Wire the protocol (heuristic first-paint → new actions)
- Agent publishes `ViewState` patches over the data channel; web consumes them.
- Generalize current image-switch into `planCanvas` emitting `showImage`.
- **Demo:** voice still works exactly as today, but now over the new contract. **Risk:** low (behavior parity).

### Phase 3 — Queryable catalog + set workflows
- Implement `selectItems`; add `showImages` `filter` resolution (beyond explicit `imageIds`).
- Heuristic detects "show all" / "show interior" intent → `showImages({ filter: { role: "interior" } })`.
- **Demo:** "show me all the interior pics" → grid of interior shots. **Risk:** none (no LLM).

### Phase 4 — The canvas brain (async LLM tool-caller)  ← the big unlock
- Implement `decideCanvasActions` (MiniMax structured JSON, Zod-validated, action list capped at ~3).
- Runs on the canvas lane, parallel to voice; heuristic stays as first-paint.
- **Demo:** natural phrasing the heuristic misses now works ("what's that thing next to the cupholder?"). **Risk:** medium → mitigations in §8.

### Phase 5 — Multi-car
- De-hardcode `DEFAULT_VIN`; thread `carId` through `ViewState`, `selectItems`, token dispatch.
- Add `focusCar`; add a 2nd car to `data/catalog.json` + images.
- **Demo:** "show me the other M4" / "compare this to the Macan". **Risk:** medium (touches token/agent dispatch).

### Phase 6 — Annotation + compare (from ingest boxes)
- Seed `boxes` / `zoomTargets` / `pairs` for the M4 images (hand-seed first).
- `zoom` accepts a named target; `annotate` draws boxes; `compare` renders the 2-up pairing.
- **Demo:** "point to the M badge" → box appears; "zoom into the caliper" → close-up; "compare front and back" → 2-up. **Risk:** low.

### Phase 7 — Image generation (heavy lane)
- `generate` inserts a `pending` item; provider call resolves it to `ready`.
- **Demo:** "what would it look like in Sao Paulo yellow?" → tile loads, fills in. **Risk:** medium (provider, cost, latency — but isolated to its lane).

### Phase 8 — Real ingest pass (scales to any dealer car)
- `scripts/ingest.ts`: VLM generates caption + `boxes` + `zoomTargets` + `pairs` + `likelyQuestions` per image; indexes into Moss.
- Optional: pre-bound "visual FAQ" (question → finished `CanvasAction`).
- **Demo:** drop in a brand-new car's raw photos → it just works. **This is the YC scalability slide.** **Risk:** medium (VLM quality), but offline so no runtime risk.

**Suggested hackathon cut line:** Phases 0–4 + 6 give the full wow (zoom/annotate/compare/grid driven by a real brain) on the M4. Phase 5 (multi-car) and Phase 8 (ingest) are the "this is a company" phases. Phase 7 (gen) is a bonus showpiece.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Voice accidentally blocks on canvas** | Enforce the fan-out: canvas runs in a `void (async () => …)()`; lint/review rule "no `await` between voice return and canvas lane." Add a test asserting voice stream starts before canvas resolves. |
| **MiniMax tool-calling reliability** | Don't use free-form tool calling — use the existing **structured-JSON** pattern (`callMiniMaxJson`) returning `CanvasAction[]`, validated by Zod; invalid/unknown ops dropped; cap at ~3 actions. Heuristic first-paint covers the gap if the LLM is slow/wrong. |
| **Moss query latency in the live path** | Measure warm query latency first (target < 150ms). If slower, keep Moss as a *non-blocking* signal that refines the next turn, not a gate. |
| **Grid/compare image flash** | Preload the active car's images on connect; render shimmer tiles for not-yet-decoded items. |
| **Zoom looks soft** | Keep a hi-res original per image (or pre-crop per `zoomTarget` at ingest). |
| **Migration breakage** | Phases 0–2 keep exact behavior parity; the single-image path is just `layout: "single"`. Ship behind the same UI until Phase 3. |
| **Generated-image cost/latency** | Isolated to the heavy lane; gated behind explicit intent; show pending state; cache by prompt. |

---

## 9. Open questions for Krish (decide before/at approval)

1. **Image-gen provider** — which one for Phase 7? (affects cost/latency; can defer the choice, the lane is provider-agnostic.)
2. **Multi-car scope for the demo** — 2 cars enough, or a small inventory (5–10)? Affects `selectItems` UX (filters, "show me SUVs under $60k").
3. **Voice-canvas coupling** — accept that voice answers the question and the canvas *illustrates* a beat later (recommended), or do we want the voice to occasionally wait for a confident canvas action on specific intents (e.g., "compare")? Default: never wait.
4. **Ingest VLM** — which model for Phase 8 captioning + box grounding?

---

## 10. First build step on approval

Phase 0 + Phase 1 together: land the `CanvasAction`/`ViewState` contract in `@vox/core`, the `applyAction` reducer with tests, and the dumb `Canvas.tsx` renderer driven by hardcoded states — so within the first sitting you can *see* zoom / compare / grid working with zero latency risk, and the contract everything else hangs off of is locked.
