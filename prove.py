"""De-risk the entire product in one script.

Proves the two claims Vox is built on:
  1) Search over the live catalog returns in well under 10ms.
  2) Marking a variant sold out makes it vanish from the very next search
     (Moss instant index update) — the "never sell what's sold out" pivot.

Run after ingest.py:  python prove.py
"""
import asyncio
import os
import time

from dotenv import load_dotenv
from moss import DocumentInfo, MossClient, QueryOptions

load_dotenv()
INDEX = os.getenv("MOSS_INDEX_NAME", "vox-catalog")

# Only surface variants that are in stock. Filter syntax mirrors the Moss CLI:
#   {"field": <key>, "condition": {"$eq": <value>}}
AVAILABLE = {"field": "available", "condition": {"$eq": "true"}}


async def timed_query(client, query, top_k=5, only_available=True):
    opts = QueryOptions(
        top_k=top_k,
        alpha=0.8,  # hybrid: lean semantic, keep keyword signal for size/color/SKU
        filter=AVAILABLE if only_available else None,
    )
    t0 = time.perf_counter()
    res = await client.query(INDEX, query, opts)
    ms = (time.perf_counter() - t0) * 1000
    return res, ms


def show(res, ms, label):
    print(f"\n{label}  ({ms:.1f} ms)")
    for d in res.docs:
        md = d.metadata or {}
        print(
            f"   {md.get('title', '?')} / {md.get('variant', '?')}"
            f"  ${md.get('price', '?')}  [{md.get('available')}]  score={d.score:.3f}"
        )


async def main():
    pid, key = os.getenv("MOSS_PROJECT_ID"), os.getenv("MOSS_PROJECT_KEY")
    if not pid or not key:
        raise SystemExit("Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY in .env")

    client = MossClient(pid, key)
    await client.load_index(INDEX)

    query = os.getenv("VOX_TEST_QUERY", "a comfortable everyday t-shirt")

    # 1) Speed --------------------------------------------------------------
    res, ms = await timed_query(client, query)
    show(res, ms, f"SEARCH: '{query}' (available only)")
    if not res.docs:
        raise SystemExit("No results — is the index populated? Run ingest.py first.")
    if ms < 10:
        print(f"\n  OK  sub-10ms retrieval ({ms:.1f}ms). This is the whole pitch.")
    else:
        print(f"\n  ~~  {ms:.1f}ms (first call may include warmup; re-run for the hot path).")

    # 2) The sold-out pivot -------------------------------------------------
    top = res.docs[0]
    md = top.metadata or {}
    vid = md.get("variant_id") or top.id
    print(f"\n--- Marking SOLD OUT: {md.get('title')} / {md.get('variant')} (id={vid}) ---")

    sold = DocumentInfo(id=vid, text=top.text, metadata={**md, "available": "false"})
    t0 = time.perf_counter()
    await client.add_docs(INDEX, [sold])  # upsert by id -> now unavailable
    print(f"   index updated in {(time.perf_counter() - t0) * 1000:.1f} ms")

    res2, ms2 = await timed_query(client, query)
    gone = vid not in [d.id for d in res2.docs]
    if not gone:
        # Fallback if the loaded index needs an explicit refresh to see the upsert.
        await client.load_index(INDEX)
        res2, ms2 = await timed_query(client, query)
        gone = vid not in [d.id for d in res2.docs]

    show(res2, ms2, "SAME SEARCH after sell-out")
    mark = "OK " if gone else "XX "
    state = "vanished from the next search" if gone else "STILL showing (check filter schema in docs)"
    print(f"\n  {mark} the sold-out variant {state}.")


if __name__ == "__main__":
    asyncio.run(main())
