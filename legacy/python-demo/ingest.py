"""Pull a Shopify catalog by URL and index it into Moss.

Reads SHOPIFY_STORE_URL + MOSS creds from .env.
Run:  python ingest.py
"""
import asyncio
import os

from dotenv import load_dotenv
from moss import DocumentInfo, MossClient

from shopify_catalog import fetch_variants

load_dotenv()
INDEX = os.getenv("MOSS_INDEX_NAME", "vox-catalog")


async def main():
    store = os.getenv("SHOPIFY_STORE_URL")
    if not store:
        raise SystemExit("Set SHOPIFY_STORE_URL in .env")
    pid, key = os.getenv("MOSS_PROJECT_ID"), os.getenv("MOSS_PROJECT_KEY")
    if not pid or not key:
        raise SystemExit("Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY in .env")

    print(f"Pulling catalog from {store} ...")
    variants = fetch_variants(store)
    print(f"  {len(variants)} variants")
    if not variants:
        raise SystemExit("No variants pulled — check the store URL / public catalog.")

    docs = [
        DocumentInfo(id=v.variant_id, text=v.to_text(), metadata=v.to_metadata())
        for v in variants
    ]
    max_docs = int(os.getenv("VOX_MAX_DOCS", "600"))
    if len(docs) > max_docs:
        print(f"  capping to {max_docs} docs for a fast first index (set VOX_MAX_DOCS to change)")
        docs = docs[:max_docs]

    client = MossClient(pid, key)
    print(f"Indexing {len(docs)} variants into Moss index '{INDEX}' (model moss-minilm) ...")
    # create_index creates (or replaces) the index with these documents.
    await client.create_index(INDEX, docs, "moss-minilm")
    print("Done. Now run:  python prove.py")


if __name__ == "__main__":
    asyncio.run(main())
