"""The Vox host pipeline — one comment in, one answer packet out.

Ties the brain (Moss retrieval + MiniMax reply) to the voice (MiniMax TTS +
word timings) and the product cards to show on screen. This is the single thing
the stage layer (LiveKit + avatar director) will call per shopper comment.

The avatar/video is deliberately NOT here: the host produces words, audio, and
timings; the deterministic router + director decide which clip plays over them.

Run:
  python host.py "is this shirt good for hot weather?"
  # -> prints the reply + product cards, writes answer.mp3, shows word timings
"""
from __future__ import annotations

import asyncio
import os
import re

from dotenv import load_dotenv
from moss import MossClient

import brain
import voice

load_dotenv()


def _cards(docs) -> list[dict]:
    """The product cards the stage shows alongside the reply (in-stock only)."""
    cards = []
    for d in docs:
        md = d.metadata or {}
        cards.append(
            {
                "title": md.get("title", "?"),
                "variant": md.get("variant", ""),
                "price": md.get("price", ""),
                "image": md.get("image", ""),
                "url": md.get("url", ""),
                "variant_id": md.get("variant_id", d.id),
                "score": round(getattr(d, "score", 0.0), 3),  # Moss relevance -> on-screen match badge
                "text": d.text,        # embedding text, so the server can re-upsert on sell-out
                "metadata": md,        # full metadata for the sold-out upsert
            }
        )
    return cards


def _feature_first(reply: str, cards: list[dict]) -> list[dict]:
    """Put the product the host actually NAMED in the reply first, so the on-screen
    'Now Showing' card matches what he's pitching (no mouth/merch mismatch).

    Scores each card by how many of its title words appear in the reply; the best
    match leads. Falls back to the top Moss result if nothing clearly matches.
    """
    low = reply.lower()
    def overlap(card):
        words = [w for w in re.findall(r"[a-z]+", card.get("title", "").lower()) if len(w) > 2]
        return sum(w in low for w in words)
    best = max(range(len(cards)), key=lambda i: overlap(cards[i]), default=None)
    if best is None or overlap(cards[best]) == 0:
        return cards
    return [cards[best]] + cards[:best] + cards[best+1:]


async def respond(client: MossClient, comment: str, lang: str = "en", top_k: int = 5,
                  anchor: str | None = None) -> dict:
    """Full host turn: retrieve → write → speak. Returns the answer packet.

    `anchor` (optional) is the car the shopper is viewing on a vehicle page — the host
    leads with it and only pivots to alternatives when asked (or when it just sold)."""
    docs = await brain.retrieve(client, comment, top_k)
    system, user = brain.build_prompt(comment, docs, anchor=anchor)
    reply = brain._llm(system, user)
    audio, timings = voice.synth(reply, lang)
    return {
        "comment": comment,
        "lang": lang,
        "reply": reply,
        "audio": audio,          # mp3 bytes
        "timings": timings,      # [{text, start_ms, end_ms}] for karaoke
        "cards": _feature_first(reply, _cards(docs)),  # the named product leads
    }


async def _main():
    import sys

    args = sys.argv[1:]
    comment = args[0] if args else "what do you recommend?"
    lang = args[1] if len(args) > 1 else "en"

    pid, key = os.getenv("MOSS_PROJECT_ID"), os.getenv("MOSS_PROJECT_KEY")
    client = MossClient(pid, key)
    await client.load_index(brain.INDEX)

    pkt = await respond(client, comment, lang)
    with open("answer.mp3", "wb") as f:
        f.write(pkt["audio"])

    print(f"\nSHOPPER: {pkt['comment']}")
    print(f"VOX:     {pkt['reply']}")
    print(f"\nCARDS ({len(pkt['cards'])} in-stock):")
    for c in pkt["cards"]:
        print(f"  - {c['title']} / {c['variant']}  ${c['price']}")
    print(f"\nAUDIO:   answer.mp3 ({len(pkt['audio'])} bytes), {len(pkt['timings'])} timed words")
    print("CAPTION: " + " ".join(t["text"] for t in pkt["timings"]))


if __name__ == "__main__":
    asyncio.run(_main())
