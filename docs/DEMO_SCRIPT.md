# Vox — 2-Minute Demo Script

**Total 2:00 · Problem 0:30 · Live demo 1:30.** Voice lines below are exactly what the on-camera "shopper" says. *Italics = speed-up / director note.*

---

## 0:00 – 0:30 — The Problem (to camera / voiceover)

> "Buying a car online is broken — dead listings, grainy photos, and no one to answer a real question. AI agents should fix this, but they feel robotic: you ask, then wait while they think and dig for the answer. That lag is a **retrieval** problem. **Moss** makes retrieval disappear — sub-10-millisecond semantic search — so an AI car specialist can hold a real, instant conversation. We built that. Meet Vox."

*Cut to screen on the last line.*

---

## 0:30 – 1:58 — Live demo (one continuous conversation)

> Pre-roll setup: open `/specialist` once before recording so Moss's one-time index load is cached. Every query on camera is then ~13ms.

**0:30 – 0:40 · Greeting (voice + avatar)**
- Avatar (let it play, full speed): "Hey, welcome — I'm Vox. What would you like to know about this M4?"
- Caption: `Live AI specialist — voice + lip-synced avatar`

**0:40 – 0:52 · The screen reacts to you**
- Shopper: "Show me the front, and how fast is it?"
- → canvas shows the front; agent answers 0–60. Then: "Zoom in on the badge." → canvas zooms.
- Caption: `The agent drives the screen — tool calls, not buttons`
- *Speed up think-pauses ~1.5×; keep spoken answers real-time.*

**0:52 – 1:05 · Generate what the photos can't show (Nano Banana)**
- Shopper: "The trunk looks small — what would it hold for a weekend trip?"
- → agent offers, you say "yeah, show me," → **a new photoreal image generates: the trunk packed with luggage.**
- Caption: `Generates new photoreal images on demand — Gemini`
- *Generation takes a few seconds — speed up the "generating…" shimmer 3×, then cut to the finished image at full speed.*

**1:05 – 1:18 · Moss finds the right car (the Moss moment)**
- Shopper: "Honestly I need something for my family — got anything?"
- → agent pivots: "The M4's a two-seat coupe, but we've got a Kia Telluride and a Honda Pilot…" (real inventory, retrieved by **Moss** in ~13ms).
- Caption: `Moss semantic search — the right car from the whole lot, instantly`

**1:18 – 1:30 · Side-by-side compare**
- Shopper: "Show me the M4 and the Telluride side by side."
- → canvas splits 2-up; agent compares: "M4's a 503-hp rear-drive coupe at $89,900 for thrill; Telluride's a $39,995 AWD three-row family SUV for space."
- Caption: `Compare any two cars side by side`

**1:30 – 1:42 · Close the deal — book a test drive (SMS)**
- Shopper: "Love the M4. Can I book a test drive Saturday at 2? My number's 650-555-0199."
- → agent confirms; **a real confirmation text goes out (Linq SMS)** — booking card appears.
- Caption: `Books the test drive — and texts the confirmation`
- *If you can, show the SMS landing on a phone in the corner.*

**1:42 – 1:52 · It sells out, live (Moss + agent awareness)**
- Action: click **Mark as Sold** → red SOLD stamp + "⚡ Moss found your next car."
- Shopper: "Wait, is the M4 still available?" → agent: "Ah, that just sold — but here's a great alternative…" (it knows instantly).
- Caption: `Inventory changes live — Moss surfaces the next car, the agent already knows`

**1:52 – 1:58 · Real inventory**
- Quick cut to `/inventory`: grid of **24 cars** → click one → detail page.
- Caption: `Real inventory — every car`
- *Speed up 2×.*

---

## 1:58 – 2:00 — Close

- Back to the avatar. Voiceover:
> "Talks, shows, generates, compares, and closes — in real time. Powered by Moss, so retrieval never makes you wait."
- End card: `Vox · built on Moss` — LiveKit · Deepgram · Cartesia · Cerebras · Simli · Gemini · Linq

---

## Director checklist
- **Speak clearly** — it's a live speech-to-text transcript; mumbles get misheard on camera.
- **Pre-warm Moss** (open `/specialist` once) so on-camera queries are ~13ms.
- **Reset between takes:** after a Mark-as-Sold or a booking, flip the M4 back to available before the real take.
- **Use a real phone number you control** for the SMS beat so the text actually arrives on screen.
- **Never speed up** the avatar speaking or the generated-image reveal — those are the magic moments. Speed up think-pauses, the "generating" shimmer, page loads, and the inventory flash.
- **Feature checklist hit:** voice ✓ avatar ✓ canvas tool-calls ✓ image-gen ✓ Moss cross-sell ✓ compare ✓ SMS booking ✓ mark-sold + Moss replacement ✓ inventory ✓.
