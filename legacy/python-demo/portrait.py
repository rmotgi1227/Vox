"""Generate the Vox host portrait via MiniMax's image model.

One clean, front-facing portrait that becomes the face of the live host. The
image is the seed for the whole avatar clip library (render_clips.py turns it
into idle/speaking/gesture video), so it must be: front-facing, eyes to camera,
even studio lighting, neutral background, head-and-shoulders framing — anything
that animates cleanly and loops without artifacts.

Run:
  python portrait.py                 # generate with the default host brief
  python portrait.py "your brief"    # generate from your own description
  # -> saves host_portrait_N.png and prints the paths
"""
from __future__ import annotations

import base64
import os
import sys

import requests
from dotenv import load_dotenv

load_dotenv()

API_BASE = os.getenv("MINIMAX_API_BASE", "https://api.minimax.io")
IMAGE_MODEL = os.getenv("MINIMAX_IMAGE_MODEL", "image-01")
# 9:16 is right for a tight portrait seed; a host-beside-the-car scene needs a wider
# frame so both fit. Override per-run, e.g. MINIMAX_IMAGE_ASPECT=4:3 python portrait.py "..."
IMAGE_ASPECT = os.getenv("MINIMAX_IMAGE_ASPECT", "9:16")

# Brand-fit host for Taylor Stitch (rugged American heritage menswear): warm,
# stylish, trustworthy. Framed like a real TikTok livestreamer (9:16 medium shot,
# cozy lifestyle background, hands visible for gestures) — NOT a corporate headshot.
# Lessons from Zo's seed portrait: vertical, medium shot, lived-in warm setting.
DEFAULT_BRIEF = (
    "Vertical 9:16 photo of a warm, charismatic live-shopping host: a man in his "
    "late twenties with short dark hair and light stubble, wearing a light chambray "
    "button-up shirt, friendly genuine smile, looking directly at the camera. "
    "MEDIUM SHOT framing from the top of the head to the waist, centered, "
    "front-facing, relaxed upright posture with hands resting comfortably and "
    "visible at the bottom of the frame (ready to gesture). Cozy lifestyle studio "
    "background: warm wood shelves with neatly folded clothing, soft greenery and "
    "string fairy lights gently blurred behind him, warm inviting light. Soft even "
    "key light on the face, natural skin texture, sharp focus. Photorealistic, high "
    "detail, calm neutral expression ready to start talking, like a live shopping stream."
)


def generate(brief: str, n: int = 1) -> list[str]:
    """Generate n portraits, save them, return the file paths."""
    key = os.getenv("MINIMAX_API_KEY")
    if not key:
        raise SystemExit("Set MINIMAX_API_KEY in .env")

    resp = requests.post(
        f"{API_BASE}/v1/image_generation",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": IMAGE_MODEL,
            "prompt": brief,
            "aspect_ratio": IMAGE_ASPECT,   # 9:16 portrait, or 4:3/16:9 for host-beside-car scenes
            "response_format": "base64",
            "n": n,
        },
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json()
    base = data.get("base_resp") or {}
    if base.get("status_code"):
        raise SystemExit(f"MiniMax image error {base['status_code']}: {base.get('status_msg')}")

    images = (data.get("data") or {}).get("image_base64") or []
    if not images:
        raise SystemExit(f"No images returned: {data}")

    paths = []
    for i, b64 in enumerate(images, 1):
        path = f"host_portrait_{i}.png"
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64))
        paths.append(path)
    return paths


if __name__ == "__main__":
    brief = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BRIEF
    n = int(os.getenv("VOX_PORTRAIT_N", "1"))
    print(f"Generating {n} host portrait(s) via {IMAGE_MODEL} ...")
    paths = generate(brief, n)
    for p in paths:
        print(f"  saved {p}")
    print("\nPick one, then set in .env:  VOX_HOST_PORTRAIT=host_portrait_1.png")
