# Zo → Vox: Engineering Notes (read the whole repo, 2026-06-01)

Source: `github.com/adityasingh2400/Zo` (internal codename "EMPIRE"). License PolyForm Noncommercial — fine for us, Aditya is cofounder. These are the notes for rebuilding it as **Vox** on our sponsor stack (Moss / Minimax / LiveKit / Unsiloed / TrueFoundry / AWS).

## The one-sentence truth about Zo
**Zo does not generate live video. It is intelligent stitching of pre-rendered clips, directed by a classifier + a deterministic router, with ~90% of comments answered locally and never hitting the cloud.** The "avatar" is mostly a looping idle clip with reactive clips crossfaded on top, client-side.

---

## Architecture (the real one, not the pitch)

**Backend** (`backend/main.py`, FastAPI :8000) owns the comment pipeline. Flow for a viewer comment:
1. `run_routed_comment(comment)` (main.py:2513) — the dispatcher.
2. **Classify** (optional): Gemma on-device → `{spam|compliment|objection|question}`. **OFF BY DEFAULT** (too slow on a Mac CPU); intent actually comes from keyword cue lists in `router.py`.
3. **Route** (`agents/router.py :: decide` → `_rule_based_decide`): deterministic Python picks one of 4 tools: `respond_locally` (play a pre-rendered MP4, ~0ms), `play_canned_clip` (bridge filler), `block_comment` (spam), `escalate_to_cloud` (Claude→TTS→lip-sync, ~5-7s).
4. **Generate** (`agents/seller.py :: generate_comment_response`): Claude Haiku via **AWS Bedrock** writes a ≤10-word reply. Product "knowledge" passed in is literally `json.dumps(product_data)[:400]` — no embeddings.
5. **Translate** (`agents/translator.py`) if active lang ≠ en (Claude Haiku + SQLite cache; 6 langs).
6. **TTS** (`seller.py :: text_to_speech`): ElevenLabs `flash_v2_5` → audio bytes.
7. **Lip-sync** (`seller.py :: render_comment_response_wav2lip`): RunPod Wav2Lip `/lipsync_fast` → MP4.
8. **Emit**: `avatar_director.Director.play_response(url)` broadcasts a `play_clip` WS message; client plays it.

**Avatar Director** (`agents/avatar_director.py`, the core): a pure orchestrator. Emits JSON `play_clip` commands over WebSocket; never touches media bytes. Two compositing layers — `tier0` (always-on looping idle) and `tier1` (reactive overlay). Suppression gates (`_tier1_locked`, `_post_pitch_settle_until`, `_tier1_busy_until`) keep autonomous idle gestures from stepping on real answers. `_processing_chain_id` is a cancellation token for queued clips.

**Frontend** (`dashboard/`, React+Vite :5173). The seamless playback lives CLIENT-side in `LiveStage.jsx`: four `<video>` els (tier0 A/B + tier1 A/B), load the new clip on the hidden element, decode first frame, then crossfade opacity + ramp volume + a **sinusoidal "blur pulse" (8px peak)** that hides the mouth/jaw discontinuity between clips. `useAvatarStream.js` = "what should be on screen" (two-tier state + `clip_ack`/`stage_ready` backpressure).

---

## ⭐ The biggest insight for us: AUDIO-FIRST = no GPU needed for a great demo

Zo's cheapest, fastest path (`Director.dispatch_audio_first_pitch`) **avoids Wav2Lip entirely**:
- Play a **muted, generic, looping "speaking pose" video** on tier1.
- Stream the **real TTS audio** separately (`pitch_audio` message) with **word timings**.
- Run **karaoke captions** (`KaraokeCaptions.jsx`) synced to the audio's `currentTime`.

The avatar *looks like it's talking* without any per-answer video generation. Zo even uses this for all cloud answers and frames the missing lip-sync as "by design." 

**Implication for Vox:** for the recorded demo we can likely **skip RunPod/Wav2Lip/the GPU entirely** — a looping speaking-pose clip + Minimax audio + karaoke captions, all grounded in Moss, is a complete, convincing live host. Wav2Lip becomes an optional fidelity upgrade for hero moments, not a dependency. This removes the single biggest infra cost and complexity from our build.

---

## The swap seams for Vox (they are tiny and isolated)

1. **Brain → Moss.** In `agents/seller.py :: generate_comment_response`, replace the product context (`json.dumps(product_data)[:400]`) with `moss.query(comment, top_k=5)` formatted into the prompt. Optionally also swap `router.py :: _match_product_field` (the keyword `qa_index` search) for a Moss query. Our `~/Desktop/vox/` spine (ingest.py/prove.py) already does the Moss half.
2. **Voice → Minimax.** Reimplement `seller.py :: text_to_speech()` to call Minimax TTS, return the same `bytes`. Everything downstream is byte-level/provider-agnostic. **Pin ONE Minimax voice_id + model across idle/bridge/answer audio per language** — Zo pins `eleven_flash_v2_5` specifically to avoid a voice "identity break"; this is the #1 regression risk.
3. **Transport → LiveKit.** Replace the Director's `broadcast` callable (raw WebSocket) with LiveKit data channels, and send Minimax audio as a LiveKit audio track. Smallest port keeps the whole Director protocol verbatim. (With LiveKit's continuous track we may not need the client-side A/B crossfade machinery at all — but keep the blur-pulse + caption sync ideas.)
4. **LLM classify (if we want intent) → Minimax.** But **never let the LLM do tool routing** — Zo measured 3-31s latency, 1/4 accuracy for LLM tool-calling. LLM classifies; deterministic Python routes (0ms, 100%).

---

## Frontend pieces to lift (mostly as-is)
- `LiveStage.jsx` — A/B double-buffer + crossfade + **blur-pulse**. (Crown jewel; may simplify under LiveKit.)
- `KaraokeCaptions.jsx` — binary-search-on-`currentTime` karaoke; feed it Minimax word timings (translated per language). Reuse verbatim.
- `TikTokShopOverlay.jsx` — the live-commerce shell (phone frame, chat rail, hearts, BUY dock, bezel product showcase, `minimalChrome`).
- `useAvatarStream.js` — two-tier clip state + ack protocol.
- `LanguagePicker.jsx` — 6-lang switcher → swap the POST endpoint.
- `ProductPanel.jsx` + `useSpin3DVoiceState` — product visuals driven off the same voice-state subscription as the avatar.
- IGNORE `AvatarPanel.jsx` (legacy emoji/soundbar placeholder).
- The **chat panel is prop-driven, not simulated** — only the viewer-count ticker + hearts are cosmetic. Comments come from operator typing or `audience_comment` WS events (QR). For our recorded demo, a planted teammate types comments = exactly Zo's pattern.

---

## Pre-render tooling (if we DO want lip-sync / bridge clips)
- `phase0/scripts/veo_idle_library.py` + `veo_bridges_batch.py` — generate idle/bridge clips with **Veo 3.1** from one reference portrait, 8s, 9:16, 1080p. Prompts use a "second 0 == second 8" loop constraint and an identical-anchor-pose trick so any two clips crossfade cleanly.
- `phase0/runpod/wav2lip_server_v2.py` — FastAPI live lip-sync. `/lipsync_fast` (source video already on pod, upload only audio) → raw MP4. Warm+cached: **3-6s**. SHA256 face-cache is the key optimization. RunPod RTX 5090, `deploy_wav2lip.sh` (SSH provisioning, no Docker).
- `latentsync_server.py` — diffusion lip-sync, higher quality but ~50s; for OFFLINE pre-renders only.
- `bridge_clips.py` — 3-tier manifest cascade (`pick_bridge_clip`, `pick_intent_substrate`).

For Vox: if we want lip-sync, generate ONE Vox host portrait → idle + a few speaking-pose substrates via Veo → run Wav2Lip on Minimax audio. But per the audio-first insight, this is optional for the demo.

---

## Demo playbook (steal these)
- **Two demo scripts exist:** "film a random object live" (high risk) and "on-device proof" (safe). We're doing the recorded-video version, so safe + controlled.
- **Pre-warm everything** at T-minus: a **dummy render at t=0:05** warms the queue; pre-warm the LiveKit room, Minimax voice session, and Moss index before recording. Zo gates on `demo_prewarm.sh --stage` → "PASS ≥ 12, zero FAILs."
- **Never show a frozen avatar.** Bridge/idle clip loops while the answer renders; auto-chain bridges up to 3× past 45s.
- **Cost ticker** ($0.00035/decision) is a pitch beat, not just telemetry. Show "answered locally, $0" vs cloud.
- **Fallback = a full pre-recorded rehearsal video**, narrated, no apology ("Sometimes the internet isn't — here's a recording"). We're recording anyway, so this is free insurance.
- Captions: ship **audio before pixels**; use real per-word/char timestamps (Minimax), not synthetic spacing.

## Cost reality (be honest in the pitch)
- Headline **$144/mo assumes 10 simultaneous streams.** Honest single-stream ≈ **$403/mo, ~$288 of it RunPod GPU.** Defensible line: "the search/classify/brain path is ~$0 marginal; the only real variable cost is the streaming GPU." → If we go audio-first (no GPU), our marginal cost story is even better.
- Market-size numbers in Zo's docs are inconsistent ($68B vs $512B vs $500B China). Use OUR researched numbers: US live shopping $14.6B (+50%), TikTok Shop US $15.1B GMV, Whatnot $8B GMV/$11.5B val, global → $2.5T by 2033.

---

## Morning TODO (proposed)
1. Decide avatar path: **audio-first (no GPU, fast)** for the demo vs Wav2Lip lip-sync (nicer, needs RunPod). Recommend audio-first first, lip-sync as stretch.
2. Brain loop: wire Moss `query()` into a `generate_comment_response`-style function + Minimax LLM. (Needs Minimax key + GroupId.)
3. Voice: Minimax TTS with word timings → karaoke captions. Pin one voice per language.
4. Stand up a minimal stage UI (lift `TikTokShopOverlay` + `KaraokeCaptions` + a looping speaking-pose clip), wired over LiveKit.
5. The sold-out pivot is already proven (spine). Wire it into the live UI.
