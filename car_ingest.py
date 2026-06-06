"""Index the car dealer inventory into Moss (the showroom reskin).

Run:  python car_ingest.py
Then: python prove.py   (semantic search still works, now over cars)
"""
import asyncio
import os

from dotenv import load_dotenv
from moss import DocumentInfo, MossClient

from car_catalog import DEALER, inventory

load_dotenv()
INDEX = os.getenv("MOSS_INDEX_NAME", "vox-cars")


async def main():
    pid, key = os.getenv("MOSS_PROJECT_ID"), os.getenv("MOSS_PROJECT_KEY")
    if not pid or not key:
        raise SystemExit("Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY in .env")

    cars = inventory()
    print(f"{DEALER}: {len(cars)} cars")
    docs = [
        DocumentInfo(id=c.vin, text=c.to_text(), metadata=c.to_metadata())
        for c in cars
    ]
    client = MossClient(pid, key)
    print(f"Indexing {len(docs)} cars into Moss index '{INDEX}' (model moss-minilm) ...")
    await client.create_index(INDEX, docs, "moss-minilm")
    print("Done. Try:  python brain.py --answer \"AWD SUV under 30k for a family\"")


if __name__ == "__main__":
    asyncio.run(main())
