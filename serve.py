"""Vox stage server — the local demo of the whole thing.

Ties everything together behind a tiny web app:
  GET  /                 -> the stage UI (stage.html)
  GET  /clips/<name>     -> avatar clip MP4s
  POST /comment          -> director routes -> play plan + reply + audio + cards
  POST /sold_out         -> mark a variant unavailable in Moss (the pivot, live)

Run:
  uvicorn serve:app --reload --port 8000
  # then open http://localhost:8000
"""
from __future__ import annotations

import asyncio
import base64
import collections
import json
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from moss import DocumentInfo, MossClient
from pydantic import BaseModel

import brain
import car_catalog
import director
import host
import pitch
import voice

load_dotenv()
CLIPS_DIR = os.getenv("VOX_CLIPS_DIR", "clips")

_client: MossClient | None = None
# variant_id -> (text, metadata) from the last retrieval, so /sold_out can re-upsert.
DOC_CACHE: dict[str, tuple[str, dict]] = {}
# VINs marked sold this session — so a car's own page knows it just sold.
SOLD: set[str] = set()

# --- Autonomous pitch buffer (the always-talking anchor) -------------------
# The host never goes silent: a background task keeps BUFFER_TARGET ready-to-play
# pitches queued. /next_pitch pops one; the filler tops it back up. Each pitch is
# generated ~seconds before it's needed, so playback is gap-free.
PITCH_BUFFER: collections.deque = collections.deque()
BUFFER_TARGET = 3
_recent_products: collections.deque = collections.deque(maxlen=6)  # avoid back-to-back repeats
_angle_i = 0


async def _fill_pitches():
    """Forever: keep the pitch buffer topped up, rotating through Moss angles."""
    global _angle_i
    while True:
        try:
            if len(PITCH_BUFFER) < BUFFER_TARGET:
                angle = pitch.ANGLES[_angle_i % len(pitch.ANGLES)]
                p = await pitch.make_pitch(await client(), angle, set(_recent_products), style_i=_angle_i)
                _angle_i += 1
                if p:
                    _recent_products.append(p["product_id"])
                    PITCH_BUFFER.append(p)
                    # cache so /sold_out can pull a pitched product too
                    c = p["card"]
                    DOC_CACHE[c["variant_id"]] = (c["text"], c["metadata"])
                else:
                    await asyncio.sleep(1)
            else:
                await asyncio.sleep(0.4)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # never let the anchor die on a transient blip
            print(f"[pitch] fill error: {type(e).__name__}: {e}")
            await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await client()  # warm Moss before the first pitch (non-fatal on a transient blip)
    except Exception as e:
        print(f"[startup] Moss warm-up deferred: {type(e).__name__}: {e}")
    task = asyncio.create_task(_fill_pitches())
    yield
    task.cancel()


app = FastAPI(title="Vox", lifespan=lifespan)
app.mount("/clips", StaticFiles(directory=CLIPS_DIR), name="clips")
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")


async def client() -> MossClient:
    """Lazily build + load the Moss client. Only cache it once the index actually
    loads, so a transient cloud blip doesn't leave a half-initialized client stuck."""
    global _client
    if _client is None:
        pid, key = os.getenv("MOSS_PROJECT_ID"), os.getenv("MOSS_PROJECT_KEY")
        c = MossClient(pid, key)
        await c.load_index(brain.INDEX)  # raises on failure -> not cached, retried next call
        _client = c
    return _client


def _pitch_payload(p: dict) -> dict:
    """Shape a buffered pitch like an answer payload (minus the metadata blob)."""
    return {
        "ready": True,
        "reply": p["reply"],
        "audio_b64": base64.b64encode(p["audio"]).decode(),
        "timings": p["timings"],
        "clip": p.get("clip"),  # {opener, sustain} — 动作绑定
        "card": {k: v for k, v in p["card"].items() if k != "metadata"},
    }


class Comment(BaseModel):
    comment: str
    lang: str = "en"


class Ask(BaseModel):
    comment: str
    vin: str
    lang: str = "en"


class SoldOut(BaseModel):
    variant_id: str


@app.get("/")
async def index():
    return FileResponse("inventory.html")   # the dealership homepage (grid of cars)


@app.get("/stage")
async def stage():
    return FileResponse("stage.html")       # the old TikTok-style live stage


# ── The dealership site: a vehicle detail page (VDP) with the embedded host ──

def _car_public(c) -> dict:
    """A car's full detail for the VDP (photos resolved from /static/cars/<vin>/)."""
    pdir = os.path.join("static", "cars", c.vin)
    photos = [f"/static/cars/{c.vin}/{f}" for f in sorted(os.listdir(pdir))
              if f.lower().endswith((".jpg", ".jpeg", ".png"))] if os.path.isdir(pdir) else []
    return {
        "vin": c.vin, "title": c.title, "variant": c.variant,
        "price": c.price, "year": c.year, "make": c.make, "model": c.model,
        "trim": c.trim, "body": c.body, "drivetrain": c.drivetrain, "fuel": c.fuel,
        "mileage": c.mileage, "color": c.color, "mpg": c.mpg, "features": c.features,
        "blurb": c.blurb, "available": c.vin not in SOLD, "photos": photos,
    }


@app.get("/inventory")
async def inventory():
    """Summary list of every car for the dealership grid (first photo + key specs)."""
    out = []
    for c in car_catalog.inventory():
        pub = _car_public(c)
        out.append({
            "vin": c.vin, "title": c.title, "trim": c.trim, "price": c.price,
            "mileage": c.mileage, "body": c.body, "drivetrain": c.drivetrain,
            "fuel": c.fuel, "color": c.color, "available": pub["available"],
            "photo": pub["photos"][0] if pub["photos"] else "",
        })
    return out


@app.get("/vdp")
async def vdp():
    return FileResponse("car.html")


@app.get("/car/{vin}")
async def car(vin: str):
    c = car_catalog.by_vin(vin)
    if not c:
        return {"error": "not found"}
    return _car_public(c)


def _anchor_for(vin: str) -> str | None:
    c = car_catalog.by_vin(vin)
    if not c:
        return None
    status = (" — NOTE: this exact car JUST SOLD; tell them warmly and pivot to the "
              "closest match below.") if vin in SOLD else ""
    return c.to_text() + status


@app.post("/ask_stream")
async def ask_stream(a: Ask):
    """Low-latency voice: Moss-grounded reply, then STREAM the audio (PCM over SSE) so the
    host starts talking ~1s in. First event carries the text + clip plan + alternatives."""
    cl = await client()
    docs = await brain.retrieve(cl, a.comment)
    system, user = brain.build_prompt(a.comment, docs, anchor=_anchor_for(a.vin))
    reply = await asyncio.to_thread(brain._llm, system, user)
    cards = host._feature_first(reply, host._cards(docs))
    for card in cards:
        DOC_CACHE[card["variant_id"]] = (card["text"], card["metadata"])
    meta = {
        "reply": reply,
        "clip": director.clip_plan(reply, intent="pitch"),
        "cards": [{k: v for k, v in c.items() if k != "metadata"} for c in cards],
        "sample_rate": voice.PCM_SAMPLE_RATE,
    }

    async def gen():
        yield f"event: meta\ndata: {json.dumps(meta)}\n\n"
        loop = asyncio.get_event_loop()
        q: asyncio.Queue = asyncio.Queue()

        def produce():
            try:
                for chunk in voice.synth_stream(reply, a.lang):
                    loop.call_soon_threadsafe(q.put_nowait, chunk)
            except Exception as e:
                print(f"[ask_stream] tts error: {e}")
            finally:
                loop.call_soon_threadsafe(q.put_nowait, None)

        loop.run_in_executor(None, produce)   # fire the blocking TTS stream into the queue
        while True:
            chunk = await q.get()
            if chunk is None:
                break
            yield f"event: audio\ndata: {base64.b64encode(chunk).decode()}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/ask")
async def ask(a: Ask):
    """Voice/text Q&A on a vehicle page — the host is ANCHORED to the car being viewed,
    grounded in live inventory, and pivots to alternatives when asked (or when it sold)."""
    c = car_catalog.by_vin(a.vin)
    anchor = None
    if c:
        sold = a.vin in SOLD
        status = (" — NOTE: this exact car JUST SOLD; tell them warmly and pivot to the "
                  "closest match below.") if sold else ""
        anchor = c.to_text() + status
    answer = await host.respond(await client(), a.comment, a.lang, anchor=anchor)
    for card in answer["cards"]:
        DOC_CACHE[card["variant_id"]] = (card["text"], card["metadata"])
    return {
        "reply": answer["reply"],
        "audio_b64": base64.b64encode(answer["audio"]).decode(),
        "timings": answer["timings"],
        "clip": director.clip_plan(answer["reply"], intent="pitch"),
        "cards": [{k: v for k, v in card.items() if k != "metadata"}
                  for card in answer["cards"]],
    }


@app.get("/manifest")
async def manifest():
    """name -> clip URL + category, so the stage plays the right file and knows
    which clips are ambient (the idle rotation)."""
    path = os.path.join(CLIPS_DIR, "manifest.json")
    clips = json.load(open(path)).get("clips", []) if os.path.exists(path) else []
    return {c["name"]: {"url": f"/clips/{os.path.basename(c['file'])}",
                        "loop": bool(c.get("loop")),
                        "category": c.get("category", "")} for c in clips}


@app.get("/next_pitch")
async def next_pitch():
    """Pop the next ready pitch for the always-talking anchor (or signal not-ready)."""
    if not PITCH_BUFFER:
        return {"ready": False}
    return _pitch_payload(PITCH_BUFFER.popleft())


@app.post("/comment")
async def comment(c: Comment):
    result = await director.decide(await client(), c.comment, c.lang)
    answer = result.pop("answer", None)
    payload = {
        "intent": result["intent"],
        "action": result["action"],
        "plan": result["plan"],
        "reply": None,
        "audio_b64": None,
        "timings": [],
        "clip": None,
        "cards": [],
    }
    if answer:
        payload["reply"] = answer["reply"]
        payload["audio_b64"] = base64.b64encode(answer["audio"]).decode()
        payload["timings"] = answer["timings"]
        # 动作绑定 for the answer: gesture matched to what he says (buy/show/etc.)
        payload["clip"] = director.clip_plan(answer["reply"], intent=result["intent"])
        payload["cards"] = [{k: v for k, v in card.items() if k != "metadata"}
                            for card in answer["cards"]]
        for card in answer["cards"]:
            DOC_CACHE[card["variant_id"]] = (card["text"], card["metadata"])
    return payload


@app.post("/sold_out")
async def sold_out(s: SoldOut):
    """Mark a vehicle SOLD — it vanishes from the very next search, and its own page
    knows it's gone. Works for a car shown in chat OR a car on its VDP (by VIN)."""
    cached = DOC_CACHE.get(s.variant_id)
    if not cached:
        car = car_catalog.by_vin(s.variant_id)  # a VDP car may not be cached yet
        if car:
            cached = (car.to_text(), car.to_metadata())
    if not cached:
        return {"ok": False, "error": "unknown vehicle"}
    text, md = cached
    doc = DocumentInfo(id=s.variant_id, text=text, metadata={**md, "available": "false"})
    c = await client()
    await c.add_docs(brain.INDEX, [doc])
    # Refresh the loaded index so the next search sees the upsert (mirrors prove.py).
    await c.load_index(brain.INDEX)
    SOLD.add(s.variant_id)
    return {"ok": True, "variant_id": s.variant_id}


@app.post("/restock")
async def restock(s: SoldOut):
    """Undo a sale — the inverse of /sold_out. The car reappears in the next search
    and its page no longer says it's gone. Works in chat or by VIN on the VDP."""
    cached = DOC_CACHE.get(s.variant_id)
    if not cached:
        car = car_catalog.by_vin(s.variant_id)  # a VDP car may not be cached yet
        if car:
            cached = (car.to_text(), car.to_metadata())
    if not cached:
        return {"ok": False, "error": "unknown vehicle"}
    text, md = cached
    doc = DocumentInfo(id=s.variant_id, text=text, metadata={**md, "available": "true"})
    c = await client()
    await c.add_docs(brain.INDEX, [doc])
    # Refresh the loaded index so the next search sees the upsert (mirrors /sold_out).
    await c.load_index(brain.INDEX)
    SOLD.discard(s.variant_id)
    return {"ok": True, "variant_id": s.variant_id}
