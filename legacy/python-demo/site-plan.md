# Vox Showroom — the "embed on the dealer's site" plan

**Reframe:** Vox isn't a TikTok stage — it's a **widget that lives on a dealership's
website, on the car page (VDP)**. The buyer is already looking at a specific car; our
host is the always-on "talk to someone about *this* car" button — knows every spec +
the live inventory, shows alternatives, never sends you to a car that's sold.

For the demo: build **one real VDP** (the 2022 CR-V) with the host embedded, wrapped in
a small inventory grid so it feels like a live dealer site. Everything we already built
(Moss grounding, brain, voice, avatar clips, sold-out-vanish) powers the widget.

---

## What the judge sees (the demo flow)

1. Lands on **Bay Area Auto** — an inventory grid of real cars (looks like a dealer site).
2. Clicks the **2022 Honda CR-V** → a real VDP: photos, specs, price, financing.
3. A **"👋 Talk to our showroom host"** bubble → the **live avatar** slides in, *already
   knowing which car they're on*: "Hey — you're on the CR-V, AWD, 28k miles, $28,400.
   Want the walkthrough, or are you comparing a few?"
4. Judge: *"anything cheaper with AWD?"* → Moss retrieves alternatives → host surfaces them
   as cards inside the widget (and can swap the page to that car).
5. Judge: *"is this one still here?"* → host confirms from **live inventory**.
6. **The money beat:** mark the CR-V SOLD (admin) → host instantly: *"Ah, that just sold —
   but the Forester's similar, AWD, $27,300."* Pivots live. That's the Moss thesis, felt.

---

## Architecture

```
Dealer site (new)                 Backend (mostly built)
─────────────────                 ──────────────────────
inventory.html  (grid)   ──┐
car.html        (VDP)    ──┼──►  /inventory        list cars        (NEW, thin)
  └─ <vox-widget vin=…>  ──┘     /car/{vin}         one car detail   (NEW, thin)
        │                        /comment {vin}     anchored answer  (EXTEND)
        ▼                        /sold_out          vanish           (built)
   avatar engine                 /next_pitch        (optional greet) (built)
   (reuse stage.js)              Moss + brain + voice + clips        (built)
```

## Build phases

### Phase 1 — Backend context (small)
- `/inventory` → the car list (title, price, mileage, key specs, image) for the grid + VDP.
- `/car/{vin}` → one car's full detail.
- **Extend `/comment`** to accept an optional `context_vin`: the host *anchors* to the car
  the buyer is viewing — leads with it, and Moss still handles "cheaper / AWD / other color."
  (Brain prompt gets a "FEATURED CAR THEY'RE VIEWING: …" line.)

### Phase 2 — The dealer site (new frontend)
- `inventory.html` — clean grid of cars, dealer branding, filters (optional). Cards link to VDP.
- `car.html?vin=…` — the VDP: photo, full spec table, price, payment estimate, and the
  **host bubble**. This is the page that sells it.

### Phase 3 — The embedded host widget
- Refactor the stage's avatar+conversation engine (`playSpoken`, clip engine, captions,
  cards) into a compact **side panel / modal** that opens on the VDP.
- It boots with `context_vin`, greets contextually, takes typed questions (voice via LiveKit
  later), answers grounded, shows alternative cars inside the panel, and can navigate the
  page to a different car.

### Phase 4 — Images (the realism gate)
Car photos make or break a "real site" look. Options:
- **(rec for demo)** Generate 1–3 clean studio shots of the demo car (CR-V) via **MiniMax
  image** (we already have the image-gen path in `portrait.py`). Enough for one polished VDP.
- Stock/placeholder for the surrounding grid.
- Later: real dealer listing photos via their feed.

### Phase 5 — Polish
- The avatar re-rendered into a showroom/neutral setting (currently the apparel-shoot host).
- LiveKit voice so the buyer *talks* to the host instead of typing.

---

## Scope for the hackathon
- **In:** inventory grid + one polished VDP + embedded live host (text) + Moss grounding +
  sold-out-vanish + 1 MiniMax-generated car hero image.
- **Later:** voice (LiveKit), re-rendered showroom avatar, financing/pre-qual, multi-car
  photo galleries, the dealer admin.

## Decisions to lock
1. **One VDP fully built + a simple grid** (recommended) — or all VDPs?
2. **Generate the demo car's photo via MiniMax** (recommended) — or use stock?
3. **Text now, LiveKit voice later** (recommended) — or wire voice now?
