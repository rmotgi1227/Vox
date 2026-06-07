"""Render the Vox avatar clip library via MiniMax Hailuo (image-to-video).

China's 24/7 digital-human livestream playbook, on Zo's clip-stitching engine:
from ONE host portrait we batch-render a small library of seamless, loopable
clips — always-on idles, a few speaking poses, reactive gestures, a bridge
filler, and a buy beat. The stitching engine (serve.py) crossfades between them
driven by the deterministic router; the LLM/voice never touch video bytes.

Prompt constraints (lifted from Zo's Veo tooling — they make stitching seamless):
  * ANCHOR POSE: every clip starts and ends in the SAME neutral framing/pose, so
    any clip can crossfade into any other without a jump.
  * SUBTLE MOTION: no scene cuts, no camera moves, no text overlays.

Looping (Zo's trick): an I2V clip rarely returns to its exact first frame, so a
raw loop has a visible seam. For clips the router LOOPS (idle, bridge), we
post-process a SEAMLESS CROSSFADE LOOP with ffmpeg — the clip's tail is dissolved
back into its head so the first and last frames match. Unlike a boomerang, motion
never plays backwards (no visible rewind); it just loops forever.

Setup:
  VOX_HOST_PORTRAIT=host.png         # one clean, front-facing 9:16 portrait
  MINIMAX_API_KEY                    # same account as brain + voice

Run:
  python render_clips.py             # render the whole library
  python render_clips.py idle_loop   # render one clip by name
  python render_clips.py --loops-only   # just (re)build seamless loops from mp4s
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time

import requests
from dotenv import load_dotenv

load_dotenv()

API_BASE = os.getenv("MINIMAX_API_BASE", "https://api.minimax.io")
VIDEO_MODEL = os.getenv("MINIMAX_VIDEO_MODEL", "I2V-01")
# Hailuo-02 supports a resolution/duration param the old I2V-01 doesn't. Only sent
# for Hailuo models so we don't break I2V-01. 1080P is the quality jump we want.
VIDEO_RESOLUTION = os.getenv("MINIMAX_VIDEO_RESOLUTION", "1080P")
VIDEO_DURATION = os.getenv("MINIMAX_VIDEO_DURATION", "6")
CLIPS_DIR = os.getenv("VOX_CLIPS_DIR", "clips")

# The shared look every prompt inherits — keeps the host + framing identical so
# any two clips crossfade cleanly. Tuned for the 9:16 lifestyle host (host.png):
# a chambray-shirted live-shopping host, hands visible, cozy shelf background.
ANCHOR = (
    "The same man in the light chambray button-up shirt, same cozy lifestyle "
    "studio with warm wood shelves and softly blurred fairy lights behind him. "
    "Vertical 9:16 medium shot, same framing and lighting throughout, eyes to "
    "camera. He starts and ends in the same relaxed upright neutral pose with "
    "hands resting at the bottom of the frame, so the clip can blend with any "
    "other. Natural, subtle motion only — no scene cuts, no camera moves, no "
    "text, photorealistic, like a real TikTok live-shopping stream."
)

# loop=True clips get a boomerang pass so they repeat forever with no seam.
# category drives the router -> clip cascade (director.py INTENT_CLIPS).
CLIPS = [
    {
        "name": "idle_loop",
        "category": "tier0_idle",
        "loop": True,
        "prompt": "He listens calmly and warmly to the camera between questions, "
        "gentle natural breathing, a soft blink, a tiny friendly head tilt and "
        "the faintest smile — relaxed and alive, waiting for the next comment. " + ANCHOR,
    },
    {
        "name": "speaking_a",
        "category": "tier1_speaking",
        "loop": False,
        "prompt": "He talks warmly and naturally to the camera, clear mouth "
        "movement, light open-handed gestures near his chest, engaged and "
        "upbeat as if answering a shopper. " + ANCHOR,
    },
    {
        "name": "speaking_b",
        "category": "tier1_speaking",
        "loop": False,
        "prompt": "He explains enthusiastically to the camera, expressive but "
        "controlled hand gestures, confident reassuring smile, clearly mid-"
        "sentence describing a product. " + ANCHOR,
    },
    {
        "name": "gesture_nod",
        "category": "tier1_reactive",
        "loop": False,
        "prompt": "He nods warmly in agreement at a comment, a reassuring smile "
        "and a brief affirming hand gesture, then settles back to neutral. " + ANCHOR,
    },
    {
        "name": "gesture_point",
        "category": "tier1_reactive",
        "loop": False,
        "prompt": "He gestures with an open hand toward a product off to the "
        "side, a welcoming 'check this out' presenting motion, inviting look "
        "back to camera, then settles. " + ANCHOR,
    },
    {
        "name": "gesture_holdup",
        "category": "tier1_reactive",
        "loop": False,
        "prompt": "He raises a folded garment up toward the camera to show it "
        "off, turning it slightly with a proud happy expression, then lowers "
        "it back to neutral. " + ANCHOR,
    },
    {
        "name": "gesture_laugh",
        "category": "tier1_reactive",
        "loop": False,
        "prompt": "He laughs lightly and genuinely at a funny comment, a warm "
        "natural reaction with a relaxed shoulder shrug, then recovers to a "
        "calm smile. " + ANCHOR,
    },
    {
        "name": "bridge_thinking",
        "category": "bridge",
        "loop": True,
        "prompt": "He pauses thoughtfully on a 'let me check that for you' beat, "
        "a slight attentive lean in, keeps warm eye contact and a small "
        "patient smile to fill the moment while looking something up. " + ANCHOR,
    },
    {
        "name": "buy_beat",
        "category": "buy",
        "loop": False,
        "prompt": "He points down toward a buy button with excited friendly "
        "energy, a 'tap to grab it' urgency and a big encouraging smile, then "
        "settles back to neutral. " + ANCHOR,
    },
    # Ambient "live-seller" behaviors — the idle is a RANDOM ROTATION of these so the
    # host is always doing something real (showing merch, gesturing at stock), never
    # the same head-turn on loop. Each starts and ends at the neutral anchor pose so
    # they hard-cut cleanly at a matched frame (masked by the blur-pulse).
    {
        "name": "present_holdup",
        "category": "ambient",
        "loop": False,
        "prompt": "He calmly picks up a neatly folded light-blue chambray shirt "
        "from beside him, holds it up toward the camera to show it off, turns it "
        "slightly with a warm proud smile as if presenting it on a live sale, "
        "then sets it down and returns to the neutral pose. " + ANCHOR,
    },
    {
        "name": "show_shelf",
        "category": "ambient",
        "loop": False,
        "prompt": "He gestures warmly with an open hand toward the shelves of "
        "neatly folded clothing behind him, glances at the stock then back to "
        "camera with an inviting 'we've got it all' smile, then settles back to "
        "the neutral pose. " + ANCHOR,
    },
    {
        "name": "lean_listen",
        "category": "ambient",
        "loop": False,
        "prompt": "He leans in slightly and reads the live comments with warm "
        "attention, a couple of small friendly nods and an easy smile as if "
        "taking in what shoppers are saying, then settles back upright to the "
        "neutral pose. " + ANCHOR,
    },
]

CLIP_BY_NAME = {c["name"]: c for c in CLIPS}


def _headers():
    key = os.getenv("MINIMAX_API_KEY")
    if not key:
        raise SystemExit("Set MINIMAX_API_KEY in .env")
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def _portrait_data_uri() -> str:
    path = os.getenv("VOX_HOST_PORTRAIT")
    if not path or not os.path.exists(path):
        raise SystemExit(
            "Set VOX_HOST_PORTRAIT to a portrait image path in .env "
            "(one clean, front-facing photo of the Vox host)."
        )
    ext = os.path.splitext(path)[1].lstrip(".").lower() or "png"
    mime = "jpeg" if ext in ("jpg", "jpeg") else ext
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return f"data:image/{mime};base64,{b64}"


def submit(prompt: str, image: str) -> str:
    """Submit one image-to-video task, return its task_id."""
    payload = {"model": VIDEO_MODEL, "prompt": prompt, "first_frame_image": image}
    if "Hailuo" in VIDEO_MODEL:  # newer models take resolution/duration; I2V-01 doesn't
        payload["resolution"] = VIDEO_RESOLUTION
        payload["duration"] = int(VIDEO_DURATION)
    resp = requests.post(
        f"{API_BASE}/v1/video_generation",
        headers=_headers(),
        json=payload,
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    task_id = data.get("task_id")
    if not task_id:
        raise RuntimeError(f"No task_id in response: {data}")
    return task_id


def poll(task_id: str, every: float = 5.0, timeout: float = 600.0) -> str:
    """Poll a task until done, return the file_id of the finished video."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        resp = requests.get(
            f"{API_BASE}/v1/query/video_generation",
            headers=_headers(),
            params={"task_id": task_id},
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        status = data.get("status")
        if status == "Success":
            return data["file_id"]
        if status == "Fail":
            raise RuntimeError(f"Task {task_id} failed: {data}")
        print(f"    {status or '?'} ...")
        time.sleep(every)
    raise TimeoutError(f"Task {task_id} did not finish within {timeout}s")


def download(file_id: str, dest: str) -> None:
    """Resolve a file_id to its URL and save the MP4 to dest."""
    group = os.getenv("MINIMAX_GROUP_ID", "")
    resp = requests.get(
        f"{API_BASE}/v1/files/retrieve",
        headers=_headers(),
        params={"file_id": file_id, **({"GroupId": group} if group else {})},
        timeout=30,
    )
    resp.raise_for_status()
    url = resp.json()["file"]["download_url"]
    mp4 = requests.get(url, timeout=120)
    mp4.raise_for_status()
    with open(dest, "wb") as f:
        f.write(mp4.content)


def _duration(src: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", src],
        check=True, capture_output=True, text=True,
    )
    return float(out.stdout.strip())


def seamless_loop(src: str, dest: str, x: float = 0.7) -> None:
    """Crossfade the clip's tail back into its head -> a forward-only seamless loop.

    Boomerang (forward+reverse) makes any directional motion visibly rewind. Instead
    we dissolve the last `x` seconds into the first `x` seconds so the output's first
    and last frames match: it loops with no seam AND never plays backwards. The
    output is `x` seconds shorter than the source. Strips audio (loops are silent).

    Layout: [tail(D-x..D) dissolving into head(0..x)] + [middle(x..D-x)]. The blend
    starts on the tail (~frame D-x) and the middle ends on ~frame D-x, so the loop
    boundary lands on matching frames.
    """
    d = _duration(src)
    mid_end = d - x
    fc = (
        f"[0:v]trim={mid_end}:{d},setpts=PTS-STARTPTS[tail];"
        f"[0:v]trim=0:{x},setpts=PTS-STARTPTS[head];"
        f"[tail][head]blend=all_expr='A*(1-T/{x})+B*(T/{x})'[blend];"
        f"[0:v]trim={x}:{mid_end},setpts=PTS-STARTPTS[mid];"
        f"[blend][mid]concat=n=2:v=1[v]"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-filter_complex", fc,
         "-map", "[v]", "-an", "-pix_fmt", "yuv420p", dest],
        check=True, capture_output=True,
    )


def render_one(clip: dict, image: str, attempts: int = 3) -> dict:
    """Render a single clip end-to-end; retry on transient network errors.

    For loop=True clips, also writes a seamless crossfade loop and points the
    manifest at it.
    """
    raw = os.path.join(CLIPS_DIR, f"{clip['name']}.mp4")
    for attempt in range(1, attempts + 1):
        try:
            print(f"  {clip['name']} ({clip['category']}) -> submitting")
            task_id = submit(clip["prompt"], image)
            file_id = poll(task_id)
            download(file_id, raw)
            entry = {"name": clip["name"], "category": clip["category"], "file": raw}
            if clip.get("loop"):
                loop = os.path.join(CLIPS_DIR, f"{clip['name']}_loop.mp4")
                seamless_loop(raw, loop)
                entry["file"] = loop
                entry["loop"] = True
                print(f"    saved {raw}  +  seamless loop {loop}")
            else:
                print(f"    saved {raw}")
            return entry
        except (requests.RequestException, RuntimeError, TimeoutError) as e:
            wait = 5 * attempt
            print(f"    attempt {attempt}/{attempts} failed ({type(e).__name__}); retry in {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"{clip['name']} failed after {attempts} attempts")


def _write_manifest(entries: list[dict]) -> None:
    """Merge new entries into clips/manifest.json (single re-renders keep the rest)."""
    path = os.path.join(CLIPS_DIR, "manifest.json")
    existing = {}
    if os.path.exists(path):
        existing = {e["name"]: e for e in json.load(open(path)).get("clips", [])}
    for e in entries:
        existing[e["name"]] = e
    with open(path, "w") as f:
        json.dump({"clips": list(existing.values())}, f, indent=2)
    print(f"Wrote {path} ({len(existing)} clips total).")


def _loops_only() -> None:
    """Rebuild seamless loops from already-downloaded mp4s (no re-render / no cost)."""
    entries = []
    for clip in CLIPS:
        raw = os.path.join(CLIPS_DIR, f"{clip['name']}.mp4")
        if not os.path.exists(raw):
            continue
        entry = {"name": clip["name"], "category": clip["category"], "file": raw}
        if clip.get("loop"):
            loop = os.path.join(CLIPS_DIR, f"{clip['name']}_loop.mp4")
            seamless_loop(raw, loop)
            entry["file"] = loop
            entry["loop"] = True
            print(f"  seamless loop {loop}")
        entries.append(entry)
    _write_manifest(entries)


def main():
    os.makedirs(CLIPS_DIR, exist_ok=True)

    if sys.argv[1:2] == ["--loops-only"]:
        _loops_only()
        return

    only = sys.argv[1] if len(sys.argv) > 1 else None
    todo = [c for c in CLIPS if not only or c["name"] == only]
    if not todo:
        raise SystemExit(f"No clip named {only!r}. Names: {[c['name'] for c in CLIPS]}")

    image = _portrait_data_uri()
    print(f"Rendering {len(todo)} clip(s) via {VIDEO_MODEL} from {os.getenv('VOX_HOST_PORTRAIT')} ...")
    entries = [render_one(c, image) for c in todo]
    _write_manifest(entries)


if __name__ == "__main__":
    main()
