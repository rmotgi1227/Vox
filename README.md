# Vox

The AI host that actually knows your store. Plug in a Shopify store, an AI avatar
goes live and sells it, answering any shopper's question instantly from your live
catalog, in any language, 24/7, and never pitching what's sold out.

The brain is **Moss** (real-time, sub-10ms semantic search). This repo starts with
the spine: the part that de-risks the whole product.

## What's here (the spine)

Onboarding is zero-friction: a merchant types their store URL, nothing else. Every
Shopify store exposes a public `/products.json`, so we read the whole catalog with
no login, no token, no app.

- `shopify_catalog.py` — pull a store's public catalog by URL, one record per variant.
- `ingest.py` — index that catalog into Moss.
- `prove.py` — prove the two claims Vox stands on:
  1. search over the live catalog returns in **well under 10ms**, and
  2. marking a variant sold out makes it **vanish from the very next search**
     (the "never sell what's sold out" pivot).

If `prove.py` prints a sub-10ms time and a shirt disappears, the bet is proven and
everything else is the show layered on top.

## Setup

```bash
cd ~/Desktop/vox
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then fill it in
```

Fill `.env`:
- `MOSS_PROJECT_ID` / `MOSS_PROJECT_KEY` — from https://portal.usemoss.dev (the only keys you need)
- `SHOPIFY_STORE_URL` — your cousin's store, e.g. `coolshirts.myshopify.com` (no token needed)

## Run

```bash
python shopify_catalog.py        # sanity check: see the catalog we pulled
python ingest.py                 # index it into Moss
python prove.py                  # prove sub-10ms search + the sold-out pivot
```

## Next (see ~/Desktop/Vox-Design-Doc.md)

1. ✅ Shopify → Moss spine (this repo)
2. Brain loop: LLM answers questions grounded in Moss retrieval (text first)
3. Voice + avatar: Minimax TTS + LiveKit/Tavus avatar
4. Stream page: avatar + product card + simulated chat panel + sold-out control
5. Multilingual: detect the comment's language, answer in it
6. Polish + record the 2.5-min demo video
