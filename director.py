"""Vox director — deterministic routing + clip selection (no LLM in the loop).

The crown jewel from Zo: comments are routed by fast keyword rules (0ms, 100%
predictable), NOT by an LLM (Zo measured 3-31s latency, 1/4 accuracy for LLM
tool-calling). The LLM only writes the sales copy; THIS decides what happens.

Per comment, decide() returns a play plan: an ordered list of clip commands plus
(for real answers) the host's answer packet. The stage layer (Phase 5) executes
the plan over LiveKit — bridge clip covers render latency, speaking clip carries
the answer audio, then settle back to the always-on idle loop.

Intents -> action:
  spam        -> block (play nothing)
  greeting    -> wave/nod gesture, no cloud call
  compliment  -> laugh/nod gesture, no cloud call
  buy         -> buy_beat + answer
  question /
  objection   -> bridge (while we retrieve+write+speak) -> speaking + audio

Run:
  python director.py "is this good for hot weather?"
  python director.py "first!!! 🔥🔥"        # spam -> blocked
  python director.py "where's the buy link?" # buy intent
"""
from __future__ import annotations

import asyncio
import json
import os
import re

from dotenv import load_dotenv
from moss import MossClient

import brain
import host

load_dotenv()
CLIPS_DIR = os.getenv("VOX_CLIPS_DIR", "clips")

# Keyword cue lists — deterministic intent. Order matters: first match wins.
# Single words match on WORD BOUNDARIES (so "hi" doesn't fire inside "this");
# phrases/emoji match as substrings.
CUES = [
    ("spam", ["first", "fpv", "follow me", "sub4sub", "check my", "free money", "🔥🔥🔥"]),
    ("buy", ["buy", "link", "how much", "price", "checkout", "purchase", "where do i get", "cart"]),
    ("greeting", ["hi", "hey", "hello", "yo", "good morning", "good evening", "what's up"]),
    ("compliment", ["love", "amazing", "gorgeous", "beautiful", "nice", "cool", "fire", "🔥"]),
    ("objection", ["too expensive", "cheaper", "overpriced", "not sure", "meh", "ugly", "hate"]),
]


def _matches(cue: str, comment: str) -> bool:
    """Word-boundary match for plain words; substring for phrases/emoji."""
    if re.fullmatch(r"[a-z']+", cue):  # a single plain word -> need boundaries
        return re.search(rf"\b{re.escape(cue)}\b", comment) is not None
    return cue in comment

# Which clip category answers each intent. Falls back through the list if a
# specific clip is missing from the manifest.
INTENT_CLIPS = {
    "greeting": ["gesture_nod", "speaking_a"],
    "compliment": ["gesture_laugh", "gesture_nod"],
    "buy": ["buy_beat", "gesture_point"],
    "question": ["speaking_a", "speaking_b"],
    "objection": ["speaking_b", "speaking_a"],
}


def load_manifest() -> dict:
    """name -> clip entry, from clips/manifest.json (empty if not rendered yet)."""
    path = os.path.join(CLIPS_DIR, "manifest.json")
    if not os.path.exists(path):
        return {}
    return {e["name"]: e for e in json.load(open(path)).get("clips", [])}


def classify(comment: str) -> str:
    """Deterministic intent from keyword cues; default 'question'."""
    c = comment.lower()
    for intent, cues in CUES:
        if any(_matches(cue, c) for cue in cues):
            return intent
    return "question"


def pick_clip(intent: str, manifest: dict) -> str | None:
    """First clip for this intent that actually exists in the manifest."""
    for name in INTENT_CLIPS.get(intent, ["speaking_a"]):
        if name in manifest:
            return name
    # last resort: any speaking clip, else any idle
    for fallback in ("speaking_a", "speaking_b", "idle_loop"):
        if fallback in manifest:
            return fallback
    return None


# 动作绑定 (action binding), China-style: the gesture is chosen from what the host is
# actually SAYING, then we settle into a talking loop for the rest of the line. Each
# rule is (opener_clip, [trigger phrases]); first match wins. The opener plays once
# (the meaningful beat — grab the item, point at the buy button, lean in to read),
# then `sustain` carries the remaining audio. This is duration-alignment: the gesture
# covers its natural beat, the speaking loop fills the rest so nothing ends mid-motion.
ACTION_BINDINGS = [
    ("buy_beat",       ["buy", "tap", "grab it", "checkout", "link in", "add to cart", "snag it", "get yours"]),
    ("present_holdup", ["check out", "take a look", "look at", "show you", "this one", "here's the",
                        "introducing", "meet the", "say hello to", "feast your eyes"]),
    ("show_shelf",     ["we've got", "we have", "our collection", "the whole", "lineup", "range of",
                        "options", "plenty of", "all of our", "shelves"]),
    ("gesture_point",  ["right here", "over here", "this is", "that's the"]),
    ("gesture_nod",    ["welcome", "hey everyone", "what's up", "great question", "good question",
                        "love that", "absolutely", "for sure"]),
]


def _trigger_hit(trigger: str, low: str) -> bool:
    """Word-boundary match for single words (so 'staple' doesn't fire 'tap'),
    substring for multi-word phrases."""
    if " " in trigger:
        return trigger in low
    return re.search(rf"\b{re.escape(trigger)}\b", low) is not None


def clip_plan(text: str, intent: str = "pitch", manifest: dict | None = None) -> dict:
    """Bind motion to the line: {opener, sustain}. Opener = a gesture matched to the
    content (plays once), sustain = a talking loop for the rest of the audio."""
    manifest = manifest if manifest is not None else load_manifest()
    low = (text or "").lower()
    sustain = "speaking_a" if ("speaking_a" in manifest or not manifest) else "speaking_b"

    opener = None
    # intent first (greeting/buy are strong signals), then content phrases
    if intent == "greeting":
        opener = "gesture_nod"
    elif intent == "compliment":
        opener = "gesture_laugh"
    elif intent in ("buy",):
        opener = "buy_beat"
    if opener is None:
        for clip, triggers in ACTION_BINDINGS:
            if any(_trigger_hit(t, low) for t in triggers):
                opener = clip
                break
    # a pitch with no strong cue still opens by presenting the product
    if opener is None and intent == "pitch":
        opener = "present_holdup"
    if opener is None:
        opener = "speaking_b" if sustain == "speaking_a" else "speaking_a"

    # fall back to a clip that actually exists
    if manifest and opener not in manifest:
        opener = sustain
    # vary the talking loop so it's not always speaking_a under every gesture
    if opener in ("speaking_a", "speaking_b"):
        sustain = opener
    return {"opener": opener, "sustain": sustain}


# Intents that need a real, grounded, spoken answer (vs. a quick canned reaction).
NEEDS_ANSWER = {"question", "objection", "buy"}


async def decide(client: MossClient, comment: str, lang: str = "en") -> dict:
    """Route a comment to a play plan. Cloud (Moss+LLM+TTS) only when needed."""
    intent = classify(comment)
    manifest = load_manifest()

    if intent == "spam":
        return {"intent": intent, "action": "block", "plan": []}

    plan = []
    answer = None

    if intent in NEEDS_ANSWER:
        # Bridge clip covers the retrieve+write+speak latency — never freeze.
        if "bridge_thinking" in manifest:
            plan.append({"clip": "bridge_thinking", "role": "bridge", "loop": True})
        answer = await host.respond(client, comment, lang)
        speak = pick_clip(intent, manifest)
        plan.append({"clip": speak, "role": "answer", "audio": "answer.mp3",
                     "timings": answer["timings"]})
    else:
        # Quick local reaction — no cloud call, ~0ms, $0.
        plan.append({"clip": pick_clip(intent, manifest), "role": "reaction"})

    # Always settle back to the always-on idle loop.
    plan.append({"clip": "idle_loop", "role": "idle", "loop": True})
    return {"intent": intent, "action": "play", "plan": plan, "answer": answer}


async def _main():
    import sys

    comment = sys.argv[1] if len(sys.argv) > 1 else "is this good for hot weather?"
    pid, key = os.getenv("MOSS_PROJECT_ID"), os.getenv("MOSS_PROJECT_KEY")
    client = MossClient(pid, key)
    await client.load_index(brain.INDEX)

    result = await decide(client, comment)
    print(f"\nSHOPPER: {comment}")
    print(f"INTENT:  {result['intent']}  ->  {result['action']}")
    if result.get("answer"):
        print(f"VOX:     {result['answer']['reply']}")
    print("PLAY PLAN:")
    for step in result["plan"]:
        extra = " (loop)" if step.get("loop") else ""
        audio = f" + {step['audio']}" if step.get("audio") else ""
        print(f"  [{step['role']:>8}] {step['clip']}{audio}{extra}")


if __name__ == "__main__":
    asyncio.run(_main())
