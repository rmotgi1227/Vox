# Vox — the 24/7 AI Showroom Host

**One line:** Every online car shopper gets a personal, no-pressure showroom visit — a
live AI avatar that *shows* them the car and answers anything, grounded in the dealer's
**real-time inventory**, at any hour.

Built for the **Moss Conversational AI Hackathon** (YC SF, June 6–7, 2026). Track: **Lead
Gen** (with a Support/service expansion in the narrative).

---

## 1. The problem (money on fire)

Car buying is the #1 most-hated big purchase, and on the dealer's side it's a lead-gen
bloodbath:

- The average dealer takes **47 hours** to respond to an online lead. By then **78%** of
  buyers have already contacted a competitor.
- Leads answered in **under a minute convert 7×**.
- **~40% of leads arrive after hours** — when the showroom is dark and *no human exists*.
- Sales staff churn **~70%/yr**, so the human who'd answer is scarce, expensive, and often
  the pushy person buyers are trying to avoid.

And the buyer hates it too: pressure, opacity, and driving 40 minutes to see a car that
already sold.

> The wound: every lead that lands at 11pm and gets nothing until morning is money on the
> floor — on a product where one conversion is worth **$2,000–$4,000** in dealer gross.

## 2. Why now

Voice models are cheap, memory is solved — **retrieval was the bottleneck, and Moss killed
it.** You can finally hold a fluid showroom conversation grounded in volatile, unique,
VIN-level inventory with **zero hallucination**. The enabling tech landed this year. This is
literally the thesis the hackathon is built on.

## 3. The product (picture it)

> **11:04pm.** Sarah is on a dealer's site hunting a used SUV, dreading the showroom. She
> clicks **"Talk to a host."** A warm face appears on video:
>
> **Vox:** "Hey Sarah — saw you in the SUVs. What's the mission? Budget, must-haves?"
> **Sarah:** "Under $30k, AWD, room for a car seat, low miles."
>
> *(Moss filters the dealer's live inventory in real time.)*
>
> **Vox:** "Three fit — this is my pick." *(gestures; the actual car slides in, 360 spin)*
> "2022 CR-V AWD, 28k miles, **$28,400.** Huge back seat for the car seat, Apple CarPlay.
> Want to see inside?"
> **Sarah:** "Monthly with $3k down?"
> **Vox:** "About **$410/mo over 60 months.** Want me to check if you pre-qualify?"
> **Sarah:** "Is it actually there? Last time I drove out and it was gone."
> **Vox:** "Looking at live inventory right now — it's on the lot. I'll **hold it** and book
> you a test drive. Saturday at 10?"
>
> *(If that CR-V sells at 11:06, it **instantly vanishes** from everything Vox offers —
> she's never sent to a ghost car.)*

The dealer wakes up to a **hot, pre-qualified, trusting buyer with a booked test drive** —
a lead that last week would've been a cold email in the morning.

## 4. Why an avatar (and not just a voice bot)

This is the sharpest question, so here's the honest answer. A video face only beats a voice
agent when **trust + a visual matter** — and car buying is the most *visual, high-trust*
consumer purchase there is.

- **Voice wins the "are you open?" ping.** (Incumbents like Mia Labs already do this.)
- **The avatar wins the "should I spend $40k on this?" decision** — because it *shows you
  the car* and earns confidence a text/voice bot can't.

So the avatar is not decoration and it's not the lead-responder — it's the **showroom**.
Build it as a showroom (host + the actual car + trust), not a trivia bot, and it's the only
one of its kind.

## 5. Why Moss is the hero (the moat)

A clothing store has 50 of each shirt. **A dealer has ONE of each car** — a specific VIN,
price, mileage, color, incentive — and it's *perishable*. When it sells, it's gone forever.

- A buyer's questions are exact: "blue AWD SUV under $30k, low miles, CarPlay?" The answer
  must come from **live inventory, exact, zero hallucination.**
- If the avatar says "yes, come on down!" and the car sold yesterday, she drives out, it's
  gone, and you've **torched the trust and the deal on a $40k purchase.**
- A generic LLM car-bot hallucinates "yes we have it!" constantly — useless.

Unique + perishable + high-stakes inventory is the *exact* case where stale/wrong data is
catastrophic. **Real-time grounding + sold-out-vanish is the entire product** — and it's the
mechanic we already built.

## 6. The market (huge + proven fundable)

- **$1.2 trillion** US auto retail.
- Automotive AI is the breakout category of 2025; conversational AI **$13.6B → $100.8B by
  2034**.
- **Mia Labs** (voice-only) raised a **$20M Series A**, serves **350+ dealers**, and enabled
  **$45M** in dealer revenue — proof dealers *write checks for this.* We're the premium,
  visual, grounded tier above them.

## 7. China validation + our gap

- China proved AI avatars **sell**: Luo Yonghao's digital twin did **$7.6M GMV in 6 hours,
  13M viewers** on Baidu.
- But that's **broadcast live-commerce** (1-to-many, impulse) — not a 1:1, inventory-grounded
  car showroom.
- The US proved **AI converts car leads** — but **voice/text only** (Mia).
- **Nobody has combined them:** a grounded *video showroom* for the highest-consideration
  purchase. That white space is the bet.

## 8. The wedge → platform (the YC story)

- **Wedge (Lead Gen):** the **after-hours showroom** — the 40% of leads *no human covers*.
  Pure found money for the dealer, an easy yes.
- **Expand (Support / fixed ops):** the same host services the car for the next 6 years —
  recalls, service appointments, "what's this warning light," grounded in the owner's manual
  + *that car's* service history. Fixed ops is ~**50% of dealer gross profit**, recurring and
  sticky — arguably the bigger business.
- **The vision:** **one AI relationship across the entire ownership lifecycle — buy → own →
  service.** A wedge-to-platform story, landing across the Lead Gen *and* Support tracks.

## 9. Why us / the sponsor stack (every piece load-bearing)

- **Unsiloed** — shreds window stickers, spec sheets, finance docs into structured knowledge.
- **Moss** — real-time semantic retrieval over live inventory (<10ms, zero hallucination).
  *The hero.*
- **MiniMax** — the avatar's brain (LLM) + voice (TTS) + the avatar video itself.
- **LiveKit** — the live video showroom call.
- **TrueFoundry / AWS** — deploy + host.

Pull any one out and it breaks. And we've **already built ~80%** — our live-selling stage
*is* the showroom (avatar + Moss catalog + real-time inventory + "now showing" cards +
sold-out-vanish). The reskin is shirts → cars.

## 10. The demo (June 7, 2 minutes)

1. Load a **real dealer's live inventory** into Moss.
2. A judge plays Sarah at 11pm. The avatar greets, asks what she wants.
3. She asks a brutal spec + financing question → the host answers, **grounded in real data**,
   and shows the car.
4. She asks "is it still there?" → **we mark it SOLD live on stage → it instantly vanishes →
   the host pivots to the next best match** without missing a beat.
5. Closer line: "...and the same host services that car for the next six years."

That sold-out-vanish moment *is* the Moss thesis, felt in 30 seconds.

## 11. The one risk (named out loud)

We have to **out-convert the voice incumbents on the trust/visual layer.** If the avatar
doesn't *feel* like a better showroom than a phone call, we're just a prettier Mia. The demo
has to sell the **experience**, not the tech. That's the whole bet — and why we build the
showroom, not the chatbot.

---

### Bottom line
Strongest, most fundable idea on the table: real wound, **Moss as the literal hero**, $1.2T
market with funded comps, fits Lead Gen + Support, and **~80% already built**. Its success
rides entirely on making the showroom *experience* undeniable.
