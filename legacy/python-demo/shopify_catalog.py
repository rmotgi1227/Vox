"""Pull a Shopify store's PUBLIC catalog with nothing but its URL.

Every Shopify store exposes /products.json with no auth. This is Vox's
zero-friction onboarding: a merchant types their URL and we read the whole
catalog in seconds. Returns one normalized record per *variant* so that size /
color are individually searchable and individually markable as sold out.
"""
from __future__ import annotations

import html
import re
import time
from dataclasses import dataclass

import requests

_TAG_RE = re.compile(r"<[^>]+>")


def normalize_store_url(raw: str) -> str:
    """'store.myshopify.com', 'https://store.com/', etc. -> 'https://host'."""
    raw = raw.strip()
    raw = re.sub(r"^https?://", "", raw)
    raw = raw.split("/")[0]  # host only
    return f"https://{raw}"


def _strip_html(s: str | None) -> str:
    if not s:
        return ""
    s = _TAG_RE.sub(" ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


@dataclass
class Variant:
    variant_id: str
    product_id: str
    product_title: str
    variant_title: str
    options: dict          # e.g. {"Color": "Sand", "Size": "L"}
    price: str
    available: bool
    image: str
    description: str
    handle: str
    product_url: str

    def to_text(self) -> str:
        """The blurb Moss embeds. Keep it tight (~1-3 sentences)."""
        opts = ", ".join(f"{k}: {v}" for k, v in self.options.items() if v)
        parts = [self.product_title]
        if opts:
            parts.append(f"({opts})")
        if self.description:
            parts.append("- " + self.description[:300])
        parts.append(f"Price ${self.price}.")
        return " ".join(parts)

    def to_metadata(self) -> dict:
        """Moss metadata values must be strings."""
        md = {
            "product_id": self.product_id,
            "variant_id": self.variant_id,
            "title": self.product_title,
            "variant": self.variant_title,
            "price": str(self.price),
            "available": "true" if self.available else "false",
            "handle": self.handle,
            "image": self.image,
            "url": self.product_url,
        }
        for k, v in self.options.items():
            if v:
                md[f"opt_{k.lower()}"] = str(v)
        return md


def fetch_variants(
    store_url: str,
    page_size: int = 250,
    max_pages: int = 50,
    pause: float = 0.2,
) -> list[Variant]:
    """Page through the public /products.json and flatten to variants."""
    base = normalize_store_url(store_url)
    session = requests.Session()
    session.headers.update({"User-Agent": "Vox/0.1 (+catalog ingest)"})

    out: list[Variant] = []
    seen_products: set[str] = set()
    for page in range(1, max_pages + 1):
        url = f"{base}/products.json?limit={page_size}&page={page}"
        resp = session.get(url, timeout=20)
        if resp.status_code == 404:
            raise RuntimeError(
                f"{base}/products.json returned 404. This store may have its "
                f"public catalog disabled, or the URL is wrong."
            )
        resp.raise_for_status()
        products = resp.json().get("products", [])
        products = [p for p in products if str(p.get("id")) not in seen_products]
        if not products:
            break  # catalog exhausted, or this store ignores ?page pagination

        for p in products:
            seen_products.add(str(p.get("id")))
            option_names = [o.get("name") for o in p.get("options", [])]
            first_image = (p.get("images") or [{}])[0].get("src", "")
            handle = p.get("handle", "")
            product_url = f"{base}/products/{handle}" if handle else base
            desc = _strip_html(p.get("body_html"))

            for v in p.get("variants", []):
                opts = {}
                for i, name in enumerate(option_names, start=1):
                    val = v.get(f"option{i}")
                    if name and val:
                        opts[name] = val
                out.append(
                    Variant(
                        variant_id=str(v.get("id")),
                        product_id=str(p.get("id")),
                        product_title=p.get("title", ""),
                        variant_title=v.get("title", ""),
                        options=opts,
                        price=str(v.get("price", "")),
                        available=bool(v.get("available", True)),
                        image=(v.get("featured_image") or {}).get("src") or first_image,
                        description=desc,
                        handle=handle,
                        product_url=product_url,
                    )
                )
        time.sleep(pause)

    return out


if __name__ == "__main__":
    import os
    import sys

    from dotenv import load_dotenv

    load_dotenv()
    store = sys.argv[1] if len(sys.argv) > 1 else os.getenv("SHOPIFY_STORE_URL")
    if not store:
        sys.exit("Usage: python shopify_catalog.py <store-url>  (or set SHOPIFY_STORE_URL)")

    variants = fetch_variants(store)
    in_stock = sum(1 for v in variants if v.available)
    print(f"Pulled {len(variants)} variants ({in_stock} in stock) from {store}")
    for v in variants[:5]:
        flag = "IN " if v.available else "OUT"
        print(f"  - [{flag}] {v.product_title} / {v.variant_title}  ${v.price}")
        print(f"      text: {v.to_text()[:100]}...")
