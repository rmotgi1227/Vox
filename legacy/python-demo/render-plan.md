# Vox — GT3 Demo: Storyboard + Render Plan

The plan for the live AI host demo: a believable, interruptible sales pitch of the
2022 Porsche 911 GT3, grounded in Moss, built to look like a 2-day hackathon build
(because it is). Target: **Moss Conversational AI Hackathon (YC SF, June 6–7).**

---

## 0. The product (real numbers — from `car_catalog.py:247`)

**2022 Porsche 911 GT3 · Shark Blue · 4,200 mi · $219,900 · RWD · 6-speed manual**
- 502-hp 4.0L naturally-aspirated flat-six, 9,000 rpm
- Carbon-ceramic brakes · carbon bucket seats · Clubsport pack w/ roll cage
- Front-axle lift · track-ready · 14 city / 18 hwy
- *"A street-legal track weapon — the naturally aspirated, 9,000-rpm enthusiast's
  dream, barely broken in at 4,200 miles."*

**Host voice** (`brain.py:77`): warm, no-pressure showroom specialist; short, natural,
on-camera sentences. Not a hype announcer.

---

## 1. Architecture decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Talking method | **Lip-sync API on our own footage** (not a full-avatar API) | Keeps OUR host in OUR showroom beside OUR car — believable as a build, not a HeyGen wrapper |
| Pitch render | **Pre-rendered offline** (slow/good lip-sync) | Zero demo-time risk; 90% of runtime can't break |
| Answer render | **Live lip-sync**, bridge-covered + canned fallback | The 10% that's live is what proves it's real |
| Demo scope | **Minimum insane**: full pitch + ONE live interrupt (sold-out beat) + agentic booking close | High confidence to ship in 2 days |
| Agentic action | **Avatar books the test drive** via a deterministic `/book` handler (offers fixed slots, captures the lead) | Closes the funnel; the Lead-track product. No LLM tool-calling (Zo: too slow/inaccurate) |
| Body clips | MiniMax I2V (Hailuo-02), framing-locked from `host_gt3.png` | The scene is the moat; a generic talking head can't stand beside the GT3 |

**Sponsor stack stays load-bearing:** Moss (retrieval — the hero) · MiniMax (body video +
voice + LLM) · LiveKit (transport) · lip-sync model as a tool.

---

## 2. The 3-pass render pipeline (every clip)

```
[seed image]   ──MiniMax I2V──►  BODY CLIP        (framing-locked gesture, silent)
[script line]  ──MiniMax TTS──►  AUDIO + timings  (pinned voice)
[body + audio] ──lip-sync API─►  FINAL TALKING CLIP
                                      └─► word-timings drive captions + card reveals
```

Because we lip-sync, **one body "mood" clip is reused across many lines** — we drive the
right audio onto the right mood. No unique render per line.

---

## 3. Storyboard

Arc: **Hook → Desire → [LIVE INTERRUPT = the Moss hero] → Resume → Value → Close → [BOOK = the agentic close].**
Runtime ~90–100s. 🗣️ = spoken line · 🎬 = blocking · 🖥️ = on-screen UI.

### S1 · HOOK — ~9s · body: `present`
- 🗣️ "Hey — glad you stopped on this one. This is the 2022 911 GT3, in Shark Blue. Of everything on the floor right now… this is the car I'd take home."
- 🎬 Beside the car, warm sweep toward it, turns to camera.
- 🖥️ LIVE pill + viewer ticker on. Lower-third: "2022 Porsche 911 GT3 · Shark Blue." Price card: **$219,900**, "LOW MILEAGE" badge.

### S2 · THE SOUL — ~11s · body: `talk`
- 🗣️ "What makes it special is what's behind the seats. A four-liter flat-six, naturally aspirated — no turbos. It pulls all the way to nine thousand RPM. They basically don't build engines like this anymore."
- 🎬 Explaining, light hand gestures, glance toward the rear.
- 🖥️ On "nine thousand RPM": spec card **502 hp · 4.0L flat-six · 9,000 rpm**.

### S3 · THE DRIVE — ~10s · body: `point`
- 🗣️ "And it's a proper six-speed manual. Rear-wheel drive. Five-oh-two horsepower. This isn't a car that drives itself — it's one you actually get to drive."
- 🎬 Engaged, gestures toward the cabin.
- 🖥️ Cards: **6-speed manual** · **RWD**.

---
### ⚡ LIVE INTERRUPT — the semantic-search + sold-out hero moment
---

### INT-A · QUESTION LANDS — ~1s
- 💬 Viewer comment appears in chat rail (audience member types it): **"what else you got like this on the floor? 👀"** *(a similarity query — only semantic search answers it)*
- 🎬 Host's pitch audio cuts at a word boundary; he **turns from the car toward camera** (framing shift sells the interrupt).

### INT-B · BRIDGE — ~2–3s · body: `bridge` (loop) · covers retrieval+render
- 🗣️ "Ooh — good question. Let me pull up what else is on the floor."
- 🖥️ **Moss "searching inventory…" indicator fires** ← the live proof.

### INT-C · THE ANSWER + THE VANISH — ~9s · body: `lean-in` · **LIVE**
1. **Moss semantic search fires** → similar-car cards slide in: **718 Cayman S**, **Corvette Stingray** (both real, in catalog).
2. **LIVE: teammate marks the Cayman S SOLD** (`/sold_out`, already wired in `serve.py`).
3. **Within ~2s the Cayman card flips to SOLD and vanishes** — Moss re-ranks live, no redeploy, no cache.
4. 🗣️ *(live, Moss-grounded)* "So — there's a Corvette Stingray if you want that world… and that Cayman just sold, actually, right as I said it. But honestly? This GT3's the one anyway."
- 🖥️ The SOLD vanish is the centerpiece visual. Semantic retrieval + zero-hallucination + real-time inventory in one motion.

### INT-D · RESUME — ~3s · body: `present`
- 🗣️ "Anyway — back to this beast."
- 🎬 Turns back toward the car, re-presents. Result cards fade.

---

### S4 · THE HARDWARE — ~11s · body: `point`
- 🗣️ "It's track-ready out of the box. Carbon-ceramic brakes, carbon bucket seats, the Clubsport package with the roll cage. Front-axle lift, so you're not scraping it on your driveway."
- 🖥️ Kit cards cascade as he names them (4 cards).

### S5 · THE VALUE — ~10s · body: `talk`
- 🗣️ "And here's the part that's hard to find — forty-two hundred miles. Barely broken in. Somebody bought it, babied it — it's basically a brand-new GT3 without the two-year waitlist."
- 🖥️ Trust badges: **4,200 mi · 1 owner · no accidents · Carfax**.

### S6 · THE CLOSE — ~11s · body: `invite`
- 🗣️ "It's two-nineteen-nine. No pressure from me — but if you want, I'll have it pulled around and you can hear it start up. That's usually the moment people decide. Want to take a look?"
- 🖥️ CTA dock: **Book a test drive / Talk to a specialist**.

### S7 · THE BOOKING (agentic close) — ~14s · body: `invite` · **LIVE ACTION**
- 💬 Viewer: **"yeah can I actually come see it this weekend?"**
- 🗣️ "Love it. I've got **Saturday at 2**, or **Sunday morning** — which works better for you?"
- 💬 Viewer: **"saturday"**
- 🎬 Attentive, then a confirming nod/smile.
- ⚙️ **Avatar takes the action**: `director` → `/book` → records the lead `{vin, slot, name/contact}` (captures the lead — the Lead-track product).
- 🗣️ *(live, slot-filled)* "Done — you're booked **Saturday at 2**. I'll have the GT3 warmed up and ready to start. What's the best number to text you the details?"
- 🖥️ **Booking confirmation card**: ✓ Test Drive Booked — *2022 911 GT3 · Sat 2:00 PM* · lead captured. The loop closes: live shopping → conversion.

---

## 4. Render manifest — pre-rendered vs. live

| Scene | Body mood | Audio | Render timing | Risk |
|---|---|---|---|---|
| S1 | present | TTS S1 | bake night before | zero |
| S2 | talk | TTS S2 | bake night before | zero |
| S3 | point | TTS S3 | bake night before | zero |
| INT-B bridge | bridge (loop) | TTS generic | bake night before | zero |
| **INT-C answer + vanish** | lean-in | **live TTS** | **on stage** | bridge-covered + canned fallback |
| INT-D resume | present | TTS "back to this beast" | bake night before | zero |
| S4 | point | TTS S4 | bake night before | zero |
| S5 | talk | TTS S5 | bake night before | zero |
| S6 | invite | TTS S6 | bake night before | zero |
| S7 slot-offer | invite | TTS "Saturday at 2 or Sunday morning…" | bake night before | zero |
| **S7 confirmation** | invite | **live TTS** (slot-filled) | **on stage** | bridge-covered + fixed-phrase fallback |

The booking confirmation is the only dynamic line — slot-fill a fixed template
("you're booked **{slot}**…") so the live render is short and the phrasing is
predictable. Offering a **fixed set of slots** (not free-form time parsing) keeps it
reliable on stage.

---

## 5. Body clips to render (the MiniMax budget)

Render all moods from the **same seed (`static/host_gt3.png`), same framing
instruction, anchor-locked** — so the host is the same size/position across every mood
and cuts are clean (fixes the `car.html:204` "teleport + resize" problem). ~6 renders
total, each lip-synced multiple times.

| Mood | Used by | Status |
|---|---|---|
| present | S1, INT-D | re-render hi-res (Hailuo-02) |
| talk | S2, S5 | re-render hi-res |
| point | S3, S4 | re-render hi-res |
| lean-in (to camera) | INT-C | re-render hi-res |
| bridge (loop) | INT-B | re-render hi-res |
| invite | S6 | re-render hi-res |

---

## 6. The sold-out live sequence (what fires when)

```
viewer comment ──► director.interrupt()
                ──► Moss semantic query ──► cards render (Cayman, Corvette)
   [teammate hits /sold_out on Cayman]
                ──► Moss index updates (~seconds)
                ──► director re-queries ──► Cayman card → SOLD → fade out
                ──► host.respond() sees updated inventory ──► answer text
                ──► MiniMax TTS ──► live lip-sync ──► answer clip plays
```

Infra already exists: `/sold_out` endpoint (`serve.py`), Moss spine proven (`prove.py`),
answer engine `host.respond()` (`host.py:69`).

### The booking sequence (S7 — the agentic close)

```
viewer "can I come see it this weekend?" ──► director.classify ──► intent: book
                ──► host offers fixed slots (pre-rendered S7 slot-offer clip)
   viewer picks "saturday"
                ──► director ──► POST /book {vin, slot, contact}   (records the lead)
                ──► confirmation text (slot-filled template)
                ──► MiniMax TTS ──► live lip-sync ──► confirmation clip
                ──► booking-confirmation card renders (✓ booked, lead captured)
```

New infra needed: a small `/book` endpoint (mock store — JSON/SQLite — returns a
confirmation; no real calendar required for the demo). Director gains a `book` intent
in `classify()` and a slot-offer/confirm handler.

---

## 7. Build order (render-side)

1. **Pin the MiniMax voice** (one voice_id per `brain.py` persona) — lock before any audio.
2. **Render the 6 body moods** hi-res, framing-locked, from `host_gt3.png`.
3. **Wire the lip-sync API** — one `lipsync(body, audio) → clip` function.
4. **Batch-bake S1–S6 + INT-B + INT-D** (audio → lip-sync → final clips + timings).
5. **Wire the live answer path** (`host.respond` → TTS → live lip-sync).
6. **Wire sold-out → Moss → card vanish.**
7. **Wire the booking** — `book` intent in `classify()`, `/book` endpoint (mock lead store), slot-offer + slot-filled confirmation, confirmation card.
8. Captions + card reveals from word-timings; CTA dock; pre-warm + fallback recording.

---

## 8. Decisions (LOCKED)

- [x] **Interrupt question** — *"what else you got like this on the floor?"* (similarity query → sold-out vanish).
- [x] **Body clips** — **re-render hi-res on Hailuo-02**, framing-locked from `host_gt3.png`.
- [x] **Lip-sync API** — **sync.so** (verify exact pricing + API shape before first render).
- [x] **Length** — **~90s full arc** (S1–S7, both hero moments).
- [x] **Voice** — **MiniMax TTS**, one pinned voice, fed into sync.so for lip-sync.
- [x] **Booking backend** — **mock store** (JSON/SQLite + confirmation card; no external auth).
- [x] **Booking slots** — **fixed offered slots** ("Sat 2 / Sun morning"), no free-form parsing.
- [x] **Lead capture** — **yes**, collect name + phone on screen (the Lead-track payoff).

### Still to verify (not blockers, just confirm)
- [ ] sync.so exact pricing + that it accepts our MiniMax audio (it does — confirm API shape).
- [ ] MiniMax Hailuo-02 model string available on the account key.

---

## 9. Cost (hackathon-scale estimate)

| Item | Est. |
|---|---|
| MiniMax body renders (~6 × Hailuo-02) | a few $ |
| MiniMax TTS (all lines) | < $1 |
| Lip-sync API (sync.so / fal), pitch + answers | ~$5–25 |
| Moss / LLM | sponsor / < $5 |
| **Total** | **~$15–35** |
