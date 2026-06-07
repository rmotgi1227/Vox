# Vox — a real-time AI car-buying specialist you *talk* to

**Vox is a voice + avatar AI car specialist that answers instantly, drives the screen for you, generates photoreal images on demand, finds the right car from the whole lot, and books your test drive over text — in real time.**

> Built at the **Moss Conversational AI Hackathon @ Y Combinator** · June 6–7, 2026 · **Lead Gen track**

Powered by **Moss · LiveKit · MiniMax · Unsiloed**

---

## The problem

The average online sales lead waits **47 hours** for an answer.¹ Most people don't wait — they walk. And buying a car online is its own special pain: dead listings, grainy photos, and no one to answer a real question, even though **8 in 10 buyers start their search online.**²

Voice AI was supposed to fix this. But agents *stall* — you ask, then wait while they think and look things up. As this hackathon's host puts it: **voice models are no longer the bottleneck, retrieval is.** Every "let me look that up" pause is a retrieval problem wearing a trench coat.

## The idea

Make retrieval instant, and the conversation comes alive.

Vox is a single specialist you talk to about a car. Under the hood, **Moss** does sub-10ms semantic search across the entire inventory — so the agent can cross-sell, compare, and pivot mid-sentence without ever making you wait. The screen isn't a static listing — **the agent drives it**: zooming, swapping views, comparing two cars, generating brand-new photoreal images. And when you're ready, it captures the lead and texts you the confirmation.

**47 hours, down to 13 milliseconds.** That's the whole pitch.

## What it does

| Feature | How |
|---|---|
| **Live voice + lip-synced avatar** | Talk naturally; a real face answers in real time. STT → reasoning → TTS → a WebRTC talking head, all streaming. |
| **The agent drives the screen** | "Show me the front." "Zoom in on the badge." The agent emits typed canvas actions — it's tool calls, not buttons. |
| **Generates what the photos can't** | "What would the trunk hold for a weekend trip?" → a new photoreal image is generated on demand and dropped onto the canvas. |
| **Finds the right car from the whole lot** | "I need something for my family" → the M4 is a two-seat coupe, so it surfaces the Telluride and Pilot from real inventory, retrieved by Moss in ~13ms. |
| **Side-by-side compare** | "Show me the M4 and the Telluride together" → the canvas splits 2-up and the agent compares the actual trade-off (503-hp coupe at $89,900 vs. a $39,995 three-row AWD SUV). |
| **Converts the lead** | "Book a test drive Saturday at 2, my number's …" → the booking is captured and a confirmation **text actually sends**. |
| **Live inventory** | Mark a car sold mid-conversation → the agent knows on its next turn and surfaces the next best car instead of pitching one that's gone. |

Backed by a catalog of **two dozen real cars** (full photo sets, specs, and pricing), with the 2026 BMW M4 as the demo's hero vehicle.

## Architecture — three lanes, one contract

The core principle: **the voice lane never `await`s anything.** A single spoken utterance fans out into three independent lanes, each with its own latency budget, so the conversation stays instant while slower work resolves in parallel.

```
  You speak ──▶ Deepgram nova-3 STT ──▶ finalized utterance
                                            │  fan-out (no serialization)
        ┌────────────────────────────────────┼────────────────────────────────┐
        ▼                                    ▼                                  ▼
   VOICE LANE                          CANVAS LANE                          HEAVY LANE
   (instant, ≤ ~500ms first token)     (1–3s)                              (async, arrives whenever)
   spoken reply                        LLM tool-caller emits               image generation
   → Cartesia TTS                      CanvasAction[]                       → pending placeholder
   → Simli avatar lip-sync             → reducer → ViewState                → resolves to ready
                                       → publish over data channel          → patches ViewState
```

| Lane | Budget | What runs there |
|---|---|---|
| **Voice + live text** | ≤ ~500ms to first token, streaming | STT → reasoning → TTS → avatar |
| **Canvas** | 1–3s | LLM tool-caller (+ optional instant heuristic first-paint) |
| **Heavy / generated** | async | on-demand image generation; surfaces as `pending → ready` |

**One contract: `CanvasAction → ViewState`.** The only way anything changes the screen is by emitting a typed `CanvasAction`; the renderer is dumb and simply draws `f(ViewState)`. The vocabulary today:

```
showImage · showImages · zoom · annotate · compare · compareCars · focusCar
```

**Two deciders, one protocol.** Both an instant keyword heuristic and a slower LLM tool-caller emit the *same* `CanvasAction[]`, so the canvas doesn't care who produced them. That's what makes the system future-proof — adding a new canvas power is "add one tool," not "rewrite the UI." All heavy intelligence (image understanding, search tags) is pre-computed at ingest, never at speak-time.

### Anatomy of one turn

1. You say *"how fast is it, and show me the front."*
2. **Deepgram nova-3** (via LiveKit Inference, with ~45 curated automotive keyterms so trims and spec words don't get mangled) finalizes the transcript.
3. The utterance fans out:
   - **Voice lane** generates the spoken answer and streams it through **Cartesia** TTS into the **Simli** avatar — you hear and see the answer in well under a second.
   - **Canvas lane** asks the LLM tool-caller for actions; "the front" resolves to a real photo via a **Moss image-metadata search** (not a filename guess), and it returns `showImage(front)` + `zoom`, which reduce into a new `ViewState` published to the browser.
   - In parallel, **Moss** semantically searches the rest of the lot via the catalog index so a cross-sell is ready *before* you ask for one.
4. The browser renders `f(ViewState)`. Voice never waited on the canvas; the canvas never waited on Moss.

Full design notes: [`docs/CANVAS_AGENT_PLAN.md`](docs/CANVAS_AGENT_PLAN.md) · 2-minute demo script: [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

## Built on the sponsors

**Moss (host) is the reason this works.** It's the difference between an agent that pauses to think and one that just *knows the lot* — sub-10ms retrieval is what keeps every other lane off the critical path.

| Sponsor | What it powers in Vox | Where |
|---|---|---|
| **Moss** | The headline, and it does two jobs. A **catalog index** powers cross-sell across the whole lot ("find me a family car") and instant inventory awareness. A separate **image-metadata index** is how the agent picks the *right photo of this car* — "show me the gear shifter" is a semantic search over every image's parsed metadata, not a keyword match. Sub-10ms, with a local keyword fallback if the cloud is unreachable. | `packages/ai` (`searchCatalog`, `searchMoss`, `warmMossIndexes`) |
| **LiveKit** | Real-time agent runtime + WebRTC, plus the Inference gateway that fronts STT and TTS (billed on LiveKit credits, no separate provider keys). The entire voice loop runs on it. | `apps/agent`, `apps/api` |
| **MiniMax** | The model layer — `MiniMax-Text-01` in the voice/reasoning profiles, plus fast-turn planning and T2A helpers that shape how the specialist thinks and speaks. | `packages/ai` (`callMiniMaxJson`, `generateMiniMaxFastTurn`), `packages/core` (model profiles) |
| **Unsiloed** | Offline vision ingest — parses every dealer photo into structured, searchable metadata (role, viewpoint, visible features, condition) so Moss can retrieve by what's actually *in* the image. | `packages/ai` (`analyzeImageWithUnsiloed`), `scripts/ingest-moss.ts` |

*Also built with:* Cerebras (fast inference for the live turn deciders), Cartesia + Deepgram (TTS/STT via LiveKit Inference), Simli (lip-synced avatar), Gemini (on-demand image generation), Linq (test-drive confirmation SMS).

## Why it fits the Lead Gen track

Vox *is* inbound lead conversion. A shopper lands on a listing and — instead of waiting 47 hours — gets answers instantly, gets the exact car for their needs surfaced from the whole lot (even when their first pick is wrong or already sold), and books a test drive with the confirmation texted on the spot. Nurture and convert, in one continuous conversation, with zero dead air.

## Repo layout

```
apps/
  web/      Next.js 16 + React 19 front end — the /specialist canvas, /inventory, /admin
  api/      Hono server — LiveKit tokens, Simli session tokens, state, booking + Moss warmup
  agent/    LiveKit voice agent — the three-lane brain (STT, reasoning, canvas, TTS, avatar)
packages/
  core/     Shared types — CanvasAction / ViewState contract, model profiles, schemas
  ai/       Providers — Moss, MiniMax, Cerebras, Unsiloed, Gemini, Linq, TTS/STT helpers
  agent-core/  Canvas reducer + heuristic decider (applyAction, planCanvas)
scripts/    Ingest + processing — Moss ingest, image processing, Unsiloed analysis
data/       Catalog, image metadata, Moss documents
```

## Running it

```bash
npm install
cp .env.example .env   # fill in the provider keys
npm run dev            # starts web (:3000), api (:8787), agent (:8081) in parallel
```

Then open **http://localhost:3000/specialist** and start talking.

**Two gotchas:**
- **Each developer needs their own `SIMLI_API_KEY`** — the free tier caps concurrent avatar sessions, so a shared key returns `429` when two people run the avatar at once.
- **The LiveKit agent has no hot-reload** — restart `dev:agent` after any change under `apps/agent` or `packages/ai`, or it runs stale code.

---

¹ Drift *Lead Response Report* (B2B benchmark; only 7% of companies answered within 5 minutes).
² Cox Automotive *Car Buyer Journey Study*.

*Vox · built on Moss, so retrieval never makes you wait.*
