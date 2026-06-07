# Vox — Build Plan

The spine (Shopify → Moss) is done. This plan builds the **live AI host** on top of it:
a real digital-human avatar that sells a Shopify catalog 24/7, grounded in Moss, in any
language — **China's 24/7 digital-human livestream playbook**, on **Zo's clip-stitching
engine**, with clips **rendered through MiniMax Hailuo (image-to-video)**.

**One vendor, three boxes:** MiniMax powers the brain (LLM), the voice (TTS + word
timings), AND the avatar clip library (Hailuo I2V from one host portrait). Vimo/Eachlabs
is dropped — it was just a wrapper around Kling/Veo/Sora, so we go direct. The only
remaining external piece is per-answer **lip-sync** (MiniMax video does not do lip-sync):
Eachlabs/Kling lip-sync or RunPod Wav2Lip, decided in Phase 4.

## Locked decisions
- **Avatar = real, like Zo.** Full clip-stitching pipeline with **real per-answer lip-sync**
  (not the audio-first shortcut). Idle/speaking loops always run; bridge clips cover render
  latency so the avatar never freezes (Zo's escalate-to-cloud pattern, ~5–7s hidden).
- **Clip library via Vimo / Eachlabs API** — batch-render reproducibly from one Vox host
  portrait (Kling/Veo/Sora under the hood). Reuse Zo's "second 0 == second 8" loop +
  identical-anchor-pose constraints so any two clips crossfade cleanly.
- **Per-answer lip-sync via Eachlabs first** (Kling/Runway expose lip-sync), fall back to
  RunPod Wav2Lip only if latency/quality disappoints. Architecture is the same either way.
- **Voice = Minimax TTS** with word/char timings. **Pin ONE voice_id + model per language**
  (#1 regression risk — voice identity break).
- **Routing stays deterministic Python.** LLM writes copy + (optionally) classifies; it
  never routes tools (Zo measured 3–31s latency, 1/4 accuracy for LLM tool-calling).

## Phases

### Phase 0 — Verify the spine (gate)
Run `ingest.py` + `prove.py` against the real store. Confirm sub-10ms retrieval and the
sold-out variant vanishing from the next search. Nothing else proceeds until this passes.

### Phase 1 — Brain loop (text-first) ✅ DONE
`moss.query(comment, top_k=5)` → product-distinct context → prompt → LLM writes a ≤10-word
grounded reply. Built in `brain.py`, powered by MiniMax `MiniMax-Text-01`. Verified live
against the Taylor Stitch index — grounded, in-stock, on-topic. Deterministic router (which
*decides* whether to call this) comes with the stage wiring; the LLM only writes copy.

### Phase 2 — Voice (MiniMax TTS) ✅ DONE
Built in `voice.py`. `synth(text, lang)` → (mp3 bytes, per-word timings). MiniMax returns
sentence-level subtitles; we interpolate word timings by character weight for karaoke.
Voice pinned per language (`speech-02-hd`, `Friendly_Person`). Verified live.

### Host pipeline ✅ DONE
`host.py :: respond(comment, lang)` ties brain + voice into one answer packet:
`{reply, audio (mp3), timings (per-word), cards (in-stock products)}`. This is the single
entry point the stage/director calls per comment. Verified end to end.

### Phase 3 — Avatar clip library (MiniMax Hailuo I2V) ✅ DONE
- Host locked: 9:16 medium-shot lifestyle streamer (`host.png`, chambray shirt, hands in
  frame, cozy shelf + fairy-light set). Old 3:4 set archived in `clips_old_3x4/`.
- Full 9-clip library rendered from the one portrait via `render_clips.py`: `idle_loop`,
  `speaking_a/b`, `gesture_nod/point/holdup/laugh`, `bridge_thinking`, `buy_beat`. Identity
  stays consistent across all 9 (same face/outfit/background) so any two crossfade cleanly.
- **Boomerang loops** (Zo's seam trick): loop=True clips (idle, bridge) get a forward+reverse
  ffmpeg pass so they return to frame 0 and repeat forever with no visible seam.
- `clips/manifest.json` (name→file→category, loop flag); `serve.py /manifest` resolves clip
  names to the right file (boomerang for loops) so `stage.html` plays them transparently.
  Verified live end-to-end: question→bridge→speaking→idle, spam blocked, local reactions $0.

### Director ✅ DONE (routing brain of the stage)
`director.py :: decide(comment)` — deterministic keyword routing (word-boundary matched,
0ms, no LLM) → intent (spam/greeting/compliment/buy/question/objection) → a play plan:
bridge clip covers answer latency, speaking clip carries the audio, settle back to idle.
Spam blocked, quick reactions stay local ($0), only real questions hit the cloud. Verified.

### Phase 4 — Per-answer lip-sync
- Eachlabs lip-sync (Kling/Runway): speaking-pose substrate + Minimax audio → MP4.
- Measure warm latency. If unacceptable, stand up RunPod Wav2Lip `/lipsync_fast` (SHA256
  face-cache, 3–6s warm) as the fallback.
- Bridge clip auto-chains (up to 3×) cover the render gap. Never show a frozen avatar.

### Phase 5 — Stitching engine + stage UI ✅ DONE (local demo)
`serve.py` (FastAPI) + `stage.html`: TikTok-shop vertical stage — looping idle avatar,
crossfade to the speaking clip on answers, **karaoke captions** synced to MiniMax word
timings, product card, live chat rail, intent + cost ticker, and a **sold-out button** that
marks a variant unavailable and makes it vanish from the next search (index reload after
upsert). Endpoints: `/comment` (director → plan + reply + audio + cards), `/sold_out`.
Verified live. (LiveKit transport + Zo's blur-pulse polish are an upgrade, not a blocker.)

### Phase 6 — Multilingual + demo
6-language detect → answer → translated captions. Pre-warm everything (dummy render at
t=0:05, warm LiveKit room + Minimax session + Moss index). Record the 2.5-min demo. Keep a
full pre-recorded rehearsal as fallback insurance.
