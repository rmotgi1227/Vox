# Avatar v2 — "the host shows you the car"

Goal: the host doesn't just talk, it **presents the car** — gestures to a feature and the
screen reveals it, like a real walkaround. The instinct (show, don't tell) is right. The
question is *how* to get it without lighting money on fire or fighting video-model artifacts.

## The honest take on "avatar physically opens the door"

Tempting, but it's the worst place to spend renders:
- **It can't be THIS car.** Our clips come from image→video of a host. To have him open *the
  Shark-Blue GT3's* door, the generated frame needs that exact car in it — I2V will give a
  generic blue 911, not the car in our listing photos. Mouth/merch mismatch, but for the car.
- **Hands-on-objects is where video models break.** Opening a door, gripping a handle,
  pointing at a specific bolt — fingers morph, the door warps. Highest artifact risk.
- **It's per-car and expensive.** Real feature-interaction clips would have to be re-rendered
  for every vehicle. 38 cars × a dozen clips = not happening.

So: literal interaction = dream, but unreliable + unscalable + can't match the real car.

## The winning architecture: host + synced feature cutaways (how QVC / China actually do it)

The host stays a clean, reliable **presenter**; the *car* is shown by the **screen**, synced
to what he says. He gestures ("take a look at the carbon buckets") and the gallery **cross-
fades / Ken-Burns zooms to the real photo** of those seats. Your brain stitches it into "he's
showing me the seats" — and it's the *actual* car, scales to all 38, and costs almost nothing
per car.

Three pieces:

### 1. Re-render the host once — a premium showroom presenter (reusable for ALL cars)
- **Setting:** modern auto showroom — glass, polished concrete, a car softly blurred behind
  him. Sells "specialist," not "guy in a clothing shop."
- **Wardrobe:** sharp but approachable (clean polo or quarter-zip + the brand). Same person.
- **Gesture library (~12 clips, the China action set, reused everywhere):**
  - `idle_loop`, `speaking_a/b`, `bridge_thinking`
  - `present_right` / `present_left` — open-hand sweep toward the screen ("look at this")
  - `point_detail` — points at a feature on-screen
  - `lean_in` — leans toward camera for an important point
  - `gesture_nod`, `gesture_laugh`
  - `present_keys` — holds up keys/brochure ("ready when you are")
  - `testdrive_beat` — enthusiastic "let's get you behind the wheel"
- One-time ~12-render job. Reused across the whole lot. No per-car cost.

### 2. Enrich the car's photos into a FEATURE set (so there's something to show)
Today we only have exterior shots. For the hero car (GT3) pull a tagged set:
`exterior`, `interior`, `engine`, `wheels/brakes`, `seats`, `dash`. (Wikimedia + stock.)
Each photo tagged with a feature keyword.

### 3. The sync engine (the magic, cheap to build)
- When the host answers, the brain also returns a **`focus`** tag (exterior / interior /
  engine / wheels / seats) for what he's talking about.
- The VDP gallery **cross-fades to that feature photo with a slow zoom**, while the host plays
  the matching **`present_*` / `point_detail`** gesture (动作绑定, already built).
- Result: "he points, the camera shows the carbon-ceramic brakes." Feels like a walkaround,
  uses the real car, costs nothing per car.

## Lip-sync — honest call
With the new **streaming PCM voice**, true real-time lip-sync means driving a talking-head
model from live audio (HeyGen-interactive / realtime Wav2Lip) — another vendor + latency.
**Recommend: defer.** The streaming voice + a believable speaking clip already reads well, and
the *feature cutaways* are where the wow is. Revisit lip-sync after the showroom re-render.

## Optional stretch — 2–3 GT3-only "hero" action clips
If we want to flex on the halo car specifically, render a *small* set of GT3-context clips
(host beside a blue 911, a present-toward-car move) — accept it's a generic blue 911 and
some artifact risk, use them only as B-roll garnish on the GT3 page. Low priority, pure spice.

## Rough cost
- **Reusable presenter set:** one ~12-clip MiniMax I2V job (+ iteration). One time, all cars.
- **Feature photos:** free (Wikimedia/stock), a fetch script.
- **Sync engine:** code only.
- **Stretch GT3 clips:** a few extra renders. Optional.
vs. literal per-car interaction = 12 clips × 38 cars. The reusable+sync path is ~1/38th the cost
for arguably a *better*, real-car result.

## Decisions to lock
1. **Architecture:** host presenter + synced real-photo cutaways (rec) — or chase literal car interaction?
2. **Setting:** premium auto showroom (rec) — or neutral studio?
3. **Lip-sync:** defer (rec) — or wire it now?
4. **Stretch GT3 hero clips:** yes (spice) / skip for now?
