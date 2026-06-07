"""Pull free-licensed car photos from Wikimedia Commons into static/cars/<vin>/.

Usage:
  python fetch_photos.py VOX00036000000000:4 VOX00001000000000:3   # specific vins:count
  python fetch_photos.py grid                                      # a curated grid set
The query is derived from the car's make + model (+ a hint for exotics).
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request

import car_catalog

UA = {"User-Agent": "VoxShowroomDemo/0.1 (hackathon demo)"}


def _search(query: str, n: int) -> list[str]:
    api = ("https://commons.wikimedia.org/w/api.php?action=query&generator=search"
           f"&gsrsearch={urllib.parse.quote(query)}&gsrnamespace=6&gsrlimit={n*3}"
           "&prop=imageinfo&iiprop=url|mime&iiurlwidth=1280&format=json")
    req = urllib.request.Request(api, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    pages = (data.get("query") or {}).get("pages", {})
    # keep stable order by page index
    items = sorted(pages.values(), key=lambda p: p.get("index", 0))
    urls = []
    for p in items:
        ii = (p.get("imageinfo") or [{}])[0]
        u = ii.get("thumburl") or ii.get("url")
        if u and ii.get("mime", "").startswith("image/jpeg"):
            urls.append(u)
    return urls


def fetch(vin: str, count: int = 3) -> int:
    car = car_catalog.by_vin(vin)
    if not car:
        print(f"  {vin}: not found"); return 0
    query = f"{car.make} {car.model}"
    urls = []
    for attempt in range(3):
        try:
            urls = _search(query, count)
            break
        except Exception as e:
            print(f"  {query}: search retry ({type(e).__name__}) …"); time.sleep(3)
    d = os.path.join("static", "cars", vin)
    os.makedirs(d, exist_ok=True)
    saved = 0
    for u in urls:
        if saved >= count:
            break
        dest = os.path.join(d, f"{saved+1}.jpg")
        try:
            req = urllib.request.Request(u, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
                f.write(r.read())
            saved += 1
            time.sleep(1.2)  # be polite -> avoid 429
        except Exception as e:
            print(f"    skip ({type(e).__name__})"); time.sleep(2)
    print(f"  {vin} {car.title}: {saved} photo(s)")
    return saved


# A curated grid set: the halo car + photogenic, recognizable models.
GRID = [
    "911 GT3", "Corvette Stingray", "718 Cayman", "Mustang", "MX-5 Miata",
    "Model 3", "Model Y", "RAV4", "CR-V", "F-150", "Tacoma", "3 Series",
    "RX 350", "Q5", "Grand Cherokee", "Telluride", "Prius", "Civic",
]


def _vins_for_models(models: list[str]) -> list[str]:
    out = []
    for c in car_catalog.inventory():
        if any(m.lower() in c.model.lower() for m in models):
            out.append(c.vin)
    return out


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args == ["grid"]:
        targets = [(v, 4 if "911 GT3" in (car_catalog.by_vin(v).model) else 1)
                   for v in _vins_for_models(GRID)]
    else:
        targets = []
        for a in args:
            vin, _, c = a.partition(":")
            targets.append((vin, int(c) if c else 3))
    print(f"Fetching photos for {len(targets)} car(s) …")
    total = 0
    for vin, count in targets:
        total += fetch(vin, count)
    print(f"Done. {total} photos saved.")
