"""Render the GT3 specialist clips from the showroom seed image (static/host_gt3.png).

The host is animated WITH the car — presenting it, pointing, talking, inviting a test
drive — favoring motions MiniMax I2V handles cleanly (hands away from fine object
manipulation). Reuses render_clips' submit/poll/download/seamless_loop.

Run:
  python render_gt3.py gt3_present      # one clip (the de-risk test)
  python render_gt3.py                  # the whole GT3 pack
"""
from __future__ import annotations

import base64
import os
import subprocess
import sys

import render_clips as rc

SEED = os.getenv("GT3_SEED", "static/host_gt3.png")

ANCHOR = (
    "The same woman — late twenties, warm and friendly, with long dark wavy hair, "
    "wearing a cream blazer over a white blouse with black trousers — standing beside "
    "the Shark Blue Porsche 911 GT3 in the bright glass-walled car showroom, one hand "
    "resting lightly on the car. Identical framing, lighting, background and outfit "
    "throughout. Subtle, natural body motion only — no scene cuts, no camera moves, no "
    "text, no extra people. The last frame returns to the same neutral standing pose as "
    "the first so the clip blends cleanly. Photorealistic, natural movement, sharp focus."
)

CLIPS = [
    {"name": "gt3_idle", "category": "gt3", "loop": True,
     "prompt": "She stands relaxed and friendly beside the car, gentle natural breathing, "
     "a small calm head movement and an easy smile, looking warmly at the camera. " + ANCHOR},
    {"name": "gt3_present", "category": "gt3", "loop": False,
     "prompt": "She warmly sweeps an open hand toward the Porsche 911 GT3 beside her, "
     "presenting it to the viewer with a confident inviting smile — a 'take a look at "
     "this' gesture — then brings her hand back to a relaxed pose. " + ANCHOR},
    {"name": "gt3_talk_a", "category": "gt3", "loop": False,
     "prompt": "She talks to the camera about the car with natural, light hand gestures, "
     "engaged, warm and confident, as if explaining a feature, then settles. " + ANCHOR},
    {"name": "gt3_talk_b", "category": "gt3", "loop": False,
     "prompt": "She explains enthusiastically to the camera with expressive but controlled "
     "hand gestures and a confident reassuring smile, then settles. " + ANCHOR},
    {"name": "gt3_point", "category": "gt3", "loop": False,
     "prompt": "She turns slightly and gestures toward the Porsche 911 GT3 beside her, "
     "drawing the viewer's attention to it, then looks back to the camera. " + ANCHOR},
    {"name": "gt3_leanin", "category": "gt3", "loop": False,
     "prompt": "She leans in slightly toward the camera to make an important point, "
     "attentive and sincere, then settles back upright. " + ANCHOR},
    {"name": "gt3_testdrive", "category": "gt3", "loop": False,
     "prompt": "She gestures invitingly with an open hand toward the car as if offering a "
     "test drive, an enthusiastic welcoming motion with a big smile, then settles. " + ANCHOR},
    {"name": "gt3_bridge", "category": "gt3", "loop": True,
     "prompt": "She pauses thoughtfully for a moment, a small attentive nod and a patient "
     "smile as if checking a detail, keeping warm eye contact. " + ANCHOR},
]


def _data_uri(path: str) -> str:
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return f"data:image/png;base64,{b64}"


def _probe(src: str):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate",
         "-of", "default=noprint_wrappers=1:nokey=1", src],
        check=True, capture_output=True, text=True).stdout.split()
    w, h, fr = int(out[0]), int(out[1]), out[2]
    n, d = (fr.split("/") + ["1"])[:2]
    fps = max(1, round(float(n) / float(d)))
    return w, h, fps


def settle_to_anchor(src: str, anchor_png: str, dest: str, x: float = 0.5) -> None:
    """Force the clip to END on the exact anchor (seed) frame: fade the still seed image
    in over the last `x` seconds (alpha 0->1) so the final frame IS the seed. Since I2V
    already STARTS on the seed, the clip now begins and ends on the identical pose — any
    clip flows into any other (and loops loop) with no jump. The anchor-pose guarantee."""
    w, h, fps = _probe(src)
    d = rc._duration(src)
    off = max(0.0, d - x)
    fc = (
        f"[1:v]scale={w}:{h},setsar=1,format=yuva420p,fade=t=in:st={off}:d={x}:alpha=1[ov];"
        f"[0:v]format=yuv420p,setsar=1[bg];[bg][ov]overlay=format=auto[v]"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-loop", "1", "-i", anchor_png,
         "-filter_complex", fc, "-map", "[v]", "-an", "-t", f"{d}", "-pix_fmt", "yuv420p", dest],
        check=True, capture_output=True,
    )


def _valid(path: str) -> bool:
    try:
        return os.path.exists(path) and rc._duration(path) > 0.5
    except Exception:
        return False


def render_one_anchored(clip: dict, image: str, anchor_png: str) -> dict:
    """Render the raw clip (retry on NETWORK only; reuse an existing raw so a post-step
    bug never re-renders), then settle the end onto the anchor frame (local ffmpeg)."""
    import time
    raw = os.path.join(rc.CLIPS_DIR, f"{clip['name']}_raw.mp4")
    final = os.path.join(rc.CLIPS_DIR, f"{clip['name']}.mp4")
    if not _valid(raw):
        for attempt in range(1, 4):
            try:
                print(f"  {clip['name']} -> submitting")
                task_id = rc.submit(clip["prompt"], image)
                rc.download(rc.poll(task_id), raw)
                break
            except (rc.requests.RequestException, RuntimeError, TimeoutError) as e:
                print(f"    render attempt {attempt}/3 failed ({type(e).__name__}); retry")
                time.sleep(5 * attempt)
        else:
            raise RuntimeError(f"{clip['name']} render failed after 3 attempts")
    else:
        print(f"  {clip['name']} -> reusing existing raw")
    settle_to_anchor(raw, anchor_png, final)   # local; if it fails we keep the raw
    print(f"    saved {final}  (start & end both on anchor)")
    entry = {"name": clip["name"], "category": clip["category"], "file": final}
    if clip.get("loop"):
        entry["loop"] = True
    return entry


def main():
    if not os.path.exists(SEED):
        raise SystemExit(f"Seed image not found: {SEED}")
    only = sys.argv[1] if len(sys.argv) > 1 else None
    todo = [c for c in CLIPS if not only or c["name"] == only]
    if not todo:
        raise SystemExit(f"No clip {only!r}. Names: {[c['name'] for c in CLIPS]}")
    img = _data_uri(SEED)
    print(f"Rendering {len(todo)} GT3 clip(s) from {SEED} (anchor-locked) ...")
    entries = [render_one_anchored(c, img, SEED) for c in todo]
    rc._write_manifest(entries)


if __name__ == "__main__":
    main()
