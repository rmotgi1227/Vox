"""Autonomous pitch loop — the host sells the catalog non-stop (China 24/7 anchor).

Instead of waiting for comments, Vox continuously pitches products: rotate through
themed "selling angles," retrieve the best in-stock match from Moss, write a punchy
proactive pitch (MiniMax), speak it (TTS). The server pre-buffers these so the live
stream never goes silent; shopper comments preempt the queue and the host resumes.

This is the difference between a chatbot-with-a-face and a real live-shopping channel:
the host is always selling, always grounded in Moss + the real Shopify catalog.

Run a one-off pitch (smoke test):
  python pitch.py "a breathable shirt for warm weather"
"""
from __future__ import annotations

import asyncio
import os

from dotenv import load_dotenv
from moss import MossClient

import brain
import director
import host
import voice

load_dotenv()

# Themed selling angles. Each is a real Moss query, so pitches stay grounded AND
# varied — the host curates ("need an AWD family SUV?...", "shopping on a budget?...")
# instead of reading a flat list. Rotated in order; cars are de-duped across a short
# window so the host doesn't feature the same one twice in a row.
ANGLES = [
    "an AWD SUV for a family with low miles",
    "a fuel-efficient hybrid commuter",
    "a reliable first car under 20k",
    "a truck for towing and hauling",
    "an electric car with good range",
    "a luxury SUV that feels brand new",
    "a fun sporty weekend car",
    "a 3-row SUV or minivan for a big family",
    "a sharp midsize sedan with low miles",
    "a great value commuter that's cheap to own",
]

# A DIFFERENT prompt from Q&A: proactive selling, not answering. Punchy, one benefit.
PITCH_SYSTEM = (
    "You are Vox, a warm showroom host at a car dealership on a live video call. Feature "
    "the ONE car in CONTEXT to the shopper in a single short, genuine, enthusiastic "
    "sentence (at most 18 words). Use ONLY the car in CONTEXT — never invent specs, "
    "mileage, or price. No emojis, no markdown."
)

# 话术泛化 (script generalization): rotate the ANGLE of each pitch so the host never
# repeats the same sentence shape, even for similar cars. One is chosen per pitch.
PITCH_STYLES = [
    "Lead with the price and what a great value it is.",
    "Lead with who it's perfect for (family, commuter, first car).",
    "Open with a short direct question to the shopper, then the car.",
    "Lead with the standout spec (AWD, mpg, towing, range, low miles).",
    "Frame it as reliable and worry-free to own.",
    "Lead with the color or how clean and sharp it looks.",
    "Create gentle urgency — low miles / hard to find at this price.",
    "Lead with comfort and the features inside.",
]


def _first_sentence(text: str, max_words: int = 22) -> str:
    """Keep the first sentence (host pitches one punchy line), word-capped as a guard."""
    text = text.strip()
    for end in (". ", "! ", "? "):
        i = text.find(end)
        if 0 < i < len(text) - 1:
            text = text[: i + 1]
            break
    words = text.split()
    if len(words) > max_words:
        text = " ".join(words[:max_words]).rstrip(",;:") + "!"
    return text


def build_pitch_prompt(docs, style: str) -> tuple[str, str]:
    """(system, user) for pitching the single featured product, in a rotated style."""
    user = (
        f"FEATURED PRODUCT:\n{brain.format_context(docs[:1])}\n\n"
        f"STYLE FOR THIS PITCH: {style}\n\n"
        f"Pitch it to the live audience right now (one sentence):"
    )
    return PITCH_SYSTEM, user


async def make_pitch(client: MossClient, angle: str, recent_ids: set[str] | None = None,
                     style_i: int = 0) -> dict | None:
    """Build one ready-to-play pitch packet for a themed angle, grounded in Moss.

    Returns {reply, audio, timings, card, clip, product_id} or None if the angle
    surfaced nothing in stock. `style_i` rotates the phrasing angle (话术泛化) so the
    host never repeats a sentence shape. The blocking LLM/TTS calls run in threads so
    the server's event loop (and the pitch buffer) keep flowing.
    """
    recent_ids = recent_ids or set()
    docs = await brain.retrieve(client, angle, top_k=6)
    if not docs:
        return None
    pick = next((d for d in docs if (d.metadata or {}).get("product_id") not in recent_ids), docs[0])

    style = PITCH_STYLES[style_i % len(PITCH_STYLES)]
    system, user = build_pitch_prompt([pick], style)
    reply = await asyncio.to_thread(brain._llm, system, user)
    reply = _first_sentence(reply)  # one punchy line keeps pacing tight + TTS fast
    audio, timings = await asyncio.to_thread(voice.synth, reply)
    card = host._cards([pick])[0]
    return {
        "reply": reply,
        "audio": audio,
        "timings": timings,
        "card": card,
        "clip": director.clip_plan(reply, intent="pitch"),  # 动作绑定: gesture matched to the line
        "product_id": (pick.metadata or {}).get("product_id") or card["variant_id"],
        "angle": angle,
    }


async def _main():
    import sys

    angle = sys.argv[1] if len(sys.argv) > 1 else ANGLES[0]
    pid, key = os.getenv("MOSS_PROJECT_ID"), os.getenv("MOSS_PROJECT_KEY")
    client = MossClient(pid, key)
    await client.load_index(brain.INDEX)
    p = await make_pitch(client, angle)
    if not p:
        print(f"(nothing in stock for angle: {angle})")
        return
    print(f"ANGLE:  {angle}")
    print(f"PITCH:  {p['reply']}")
    print(f"PRODUCT: {p['card']['title']}  (Moss {round((p['card'].get('score') or 0)*100)}%)")
    print(f"AUDIO:  {len(p['audio'])} bytes, {len(p['timings'])} word-timings")


if __name__ == "__main__":
    asyncio.run(_main())
