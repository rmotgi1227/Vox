# Vox

The AI host that actually knows your lot. Plug in a dealer's inventory, an AI avatar
goes live and sells it — answering any shopper's question instantly from the live
catalog, in any language, 24/7, and **never pitching a car that's already sold**.

The brain is **Moss** (real-time, sub-10ms semantic search). Cars are the perfect
fit: every unit is *unique and perishable* — one VIN, one price, one mileage, and
when it sells it's gone. That's exactly why real-time grounding is the whole
product. Hallucinating "yes, we have it!" on a $40k purchase torches the deal.

## How it works

A shopper asks something in plain language — *"AWD SUV under 30k for a family"*,
*"fun first car"*, *"truck for towing"* — and Vox:

1. **retrieves** matching cars from the live inventory in Moss (semantic, intent-style),
2. **answers** grounded only in what's actually on the lot (no hallucinated stock),
3. **speaks** the reply through an avatar (TTS + lip-synced video clips), and
4. **shows** the matching car as a feature-first card.

The moment a car is marked sold, it **vanishes from the very next search** — the
"never sell what's gone" pivot, live.

## The pieces

**Inventory → Moss**
- `car_catalog.py` — a realistic used-car dealer inventory mapped to Vox's schema
  (VIN = the unique perishable unit; make+model = the product; mileage / drivetrain
  / body / fuel / color as facets). Each car embeds a blurb tuned for semantic search.
- `car_ingest.py` — index the inventory into Moss.
- `prove.py` — prove the two claims Vox stands on: sub-10ms search, and a sold car
  disappearing from the next query.

**The host**
- `brain.py` — Moss retrieval + LLM, answering grounded in the live catalog.
- `voice.py` — TTS + word timings.
- `host.py` — assembles the answer packet and the feature-first car card.
- `director.py` — routes a comment to the right play plan (answer / pitch / clip).
- `pitch.py` — the autonomous anchor: keeps selling between questions so the host
  never goes silent.

**The stage**
- `serve.py` — FastAPI app tying it together (stage UI, avatar clips, `/comment`
  routing, `/sold_out` live control, and the always-on pitch buffer).
- `stage.html` / `car.html` / `inventory.html` — the showroom UI.
- `render_clips.py` / `portrait.py` / `render_gt3.py` — the avatar pipeline.

## Setup

```bash
cd ~/vox
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then fill it in
```

Fill `.env`:
- `MOSS_PROJECT_ID` / `MOSS_PROJECT_KEY` — from https://portal.usemoss.dev
- `MINIMAX_API_KEY` — powers the brain (LLM), voice (TTS), and avatar clips
- `MOSS_INDEX_NAME` — e.g. `vox-cars`

## Run

```bash
python car_ingest.py             # index the dealer inventory into Moss
python prove.py                  # prove sub-10ms search + the sold-out pivot
python brain.py --answer "AWD SUV under 30k for a family"   # text-only sanity check

./run.sh                         # the full showroom → http://localhost:8000
```
