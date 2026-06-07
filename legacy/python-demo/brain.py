"""The Vox brain loop (text-first).

A shopper comment in -> a short, grounded sales reply out, retrieved live from
Moss over the merchant's catalog. This is Zo's `generate_comment_response` swap
seam, rebuilt on Moss + Minimax:

    retrieve (Moss, in-stock only)  ->  prompt  ->  LLM writes <=10 words

Routing is NOT here. A deterministic Python router decides *whether* to call this
(vs. play a canned clip, block spam, etc.). The LLM only writes copy; it never
routes tools. See ZO-NOTES.md.

Run a retrieval-only smoke test (no LLM key needed):
    python brain.py "is this shirt good for hot weather?"

Run the full loop (needs an LLM key, see _llm below):
    python brain.py --answer "is this shirt good for hot weather?"
"""
from __future__ import annotations

import asyncio
import os

from dotenv import load_dotenv
from moss import MossClient, QueryOptions

load_dotenv()
INDEX = os.getenv("MOSS_INDEX_NAME", "vox-catalog")

# Only ever surface in-stock variants — the "never sell what's sold out" pivot.
AVAILABLE = {"field": "available", "condition": {"$eq": "true"}}


# --- Retrieval (Moss) ------------------------------------------------------

async def retrieve(client: MossClient, comment: str, top_k: int = 5):
    """Top-k in-stock, product-distinct variants for the shopper's comment.

    Over-fetches and keeps the best-scoring variant per product, so the host
    sees variety (different shirts) instead of one shirt in five sizes.
    """
    opts = QueryOptions(
        top_k=top_k * 5,
        alpha=0.8,  # lean semantic, keep keyword signal for size/color/SKU
        filter=AVAILABLE,
    )
    res = await client.query(INDEX, comment, opts)
    seen: set[str] = set()
    distinct = []
    for d in res.docs:  # already score-ordered, so first per product is the best
        pid = (d.metadata or {}).get("product_id") or d.id
        if pid in seen:
            continue
        seen.add(pid)
        distinct.append(d)
        if len(distinct) >= top_k:
            break
    return distinct


def format_context(docs) -> str:
    """Render retrieved items as a compact, grounded context block. The embedded
    text already carries the full, rich description (specs, mileage, features), so
    we lead with the title and let that blurb do the work."""
    lines = []
    for d in docs:
        md = d.metadata or {}
        blurb = (d.text or "").strip()
        line = f"- {md.get('title', '?')} ({md.get('variant', '')}) — ${md.get('price', '?')}"
        if blurb:
            line += f"\n    {blurb}"
        lines.append(line)
    return "\n".join(lines) if lines else "(nothing on the lot matched)"


SYSTEM = (
    "You are Vox, a warm, no-pressure showroom host at a car dealership, talking to a "
    "shopper on a live video call. Answer using ONLY the cars listed in CONTEXT — never "
    "invent a car, price, mileage, or availability (a buyer who drives out to a car that "
    "isn't there is a disaster). If nothing in CONTEXT fits, say so honestly and point to "
    "the closest match on the lot. Be specific and trustworthy: name the car, and call out "
    "the detail they care about (price, mileage, AWD, mpg, seats). Reply in at most 18 "
    "words, friendly and natural, like a real host on camera. No emojis, no markdown."
)


def build_prompt(comment: str, docs, anchor: str | None = None) -> tuple[str, str]:
    """Return (system, user) messages for the LLM.

    On a vehicle page, `anchor` is the car the shopper is currently looking at — the
    host leads with it and only pivots to the others if they ask for an alternative.
    """
    lead = f"THE CAR THE SHOPPER IS LOOKING AT RIGHT NOW:\n{anchor}\n\n" if anchor else ""
    instr = (
        "Lead with the car they're viewing. Only bring up another car if they ask for "
        "something cheaper, a different spec, or an alternative — or if their car just sold.\n\n"
        if anchor else ""
    )
    user = (
        f"{lead}OTHER CARS ON THE LOT:\n{format_context(docs)}\n\n"
        f"{instr}SHOPPER: {comment}\n\nReply (<=18 words):"
    )
    return SYSTEM, user


# --- Generation (LLM, pluggable) -------------------------------------------

def _llm(system: str, user: str) -> str:
    """Single-call chat completion. Minimax (sponsor stack) by default;
    falls back to Anthropic if its key is present. Returns the reply text.

    Provider is chosen by which key is set, so wiring a key is the only step
    needed to switch the brain on:
      MINIMAX_API_KEY (+ MINIMAX_GROUP_ID)   -> Minimax
      ANTHROPIC_API_KEY                       -> Claude
    """
    if os.getenv("MINIMAX_API_KEY"):
        return _llm_minimax(system, user)
    if os.getenv("ANTHROPIC_API_KEY"):
        return _llm_anthropic(system, user)
    raise SystemExit(
        "No LLM key set. Add MINIMAX_API_KEY (+ MINIMAX_GROUP_ID) or "
        "ANTHROPIC_API_KEY to .env to run the full brain loop."
    )


def _llm_minimax(system: str, user: str) -> str:
    import requests

    key = os.environ["MINIMAX_API_KEY"]
    base = os.getenv("MINIMAX_API_BASE", "https://api.minimax.io")
    model = os.getenv("MINIMAX_MODEL", "MiniMax-Text-01")
    url = f"{base}/v1/text/chatcompletion_v2"
    resp = requests.post(
        url,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": 64,
            "temperature": 0.6,
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    # MiniMax returns HTTP 200 even on logical errors; the real status is here.
    base = data.get("base_resp") or {}
    if base.get("status_code"):
        raise SystemExit(f"MiniMax error {base['status_code']}: {base.get('status_msg')}")
    return data["choices"][0]["message"]["content"].strip()


def _llm_anthropic(system: str, user: str) -> str:
    import anthropic

    client = anthropic.Anthropic()
    model = os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
    msg = client.messages.create(
        model=model,
        max_tokens=64,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return msg.content[0].text.strip()


# --- The loop --------------------------------------------------------------

async def answer(client: MossClient, comment: str, top_k: int = 5) -> dict:
    """Full brain loop: retrieve -> prompt -> generate. Returns reply + sources."""
    docs = await retrieve(client, comment, top_k)
    system, user = build_prompt(comment, docs)
    reply = _llm(system, user)
    return {
        "reply": reply,
        "sources": [(d.metadata or {}).get("title", "?") for d in docs],
    }


async def _main():
    import sys

    args = sys.argv[1:]
    do_answer = "--answer" in args
    args = [a for a in args if a != "--answer"]
    comment = args[0] if args else os.getenv("VOX_TEST_QUERY", "what do you recommend?")

    pid, key = os.getenv("MOSS_PROJECT_ID"), os.getenv("MOSS_PROJECT_KEY")
    if not pid or not key:
        raise SystemExit("Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY in .env")

    client = MossClient(pid, key)
    await client.load_index(INDEX)

    docs = await retrieve(client, comment)
    print(f"\nSHOPPER: {comment}")
    print(f"\nRETRIEVED (in-stock):\n{format_context(docs)}")

    if do_answer:
        system, user = build_prompt(comment, docs)
        print(f"\nVOX: {_llm(system, user)}")
    else:
        print("\n(retrieval-only; add --answer + an LLM key for the full reply)")


if __name__ == "__main__":
    asyncio.run(_main())
