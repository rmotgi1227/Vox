"""Simli — create the Vox host's real-time avatar face, and helpers to use it.

Simli renders the live talking head: it takes the MiniMax-generated host portrait,
builds a "Trinity" face from it (a one-time ~couple-hour async build), then streams
a real-time lip-synced avatar over LiveKit, driven by OUR audio (MiniMax TTS) and
OUR brain (Moss + MiniMax LLM). MiniMax generates the host + content; Simli only
animates the mouth live.

Faces: the free tier allows LEGACY faces (POST /faces/legacy) but NOT the newer
Trinity/"GS" faces (those 403 with "max number of GS Faces" until you upgrade).
So we build her as a legacy face. Best input: a SQUARE PNG sized to a multiple of
512 (e.g. 1024x1024), face centered — otherwise Simli auto-crops to square and does
fractional scaling (minor detail loss).

Flow:
  1. python simli.py create [image]   # build her LEGACY face from a square PNG
                                       # -> prints + caches character_uid in simli_face.json
  2. python simli.py list             # list faces on the account
  3. python simli.py delete <uid>     # delete a face (frees a slot)
  4. python simli.py face             # show the cached face record

Env:
  SIMLI_API_KEY    # in .env (gitignored)
"""
from __future__ import annotations

import json
import os
import sys

import requests
from dotenv import load_dotenv

load_dotenv()

API_BASE = os.getenv("SIMLI_API_BASE", "https://api.simli.ai")
FACE_CACHE = "simli_face.json"
# Head-and-shoulders crop of the MiniMax host portrait (face prominent, eyes to camera).
DEFAULT_IMAGE = os.getenv("SIMLI_FACE_IMAGE", "host_new_3_face.png")


def _key() -> str:
    key = os.getenv("SIMLI_API_KEY")
    if not key:
        raise SystemExit("Set SIMLI_API_KEY in .env")
    return key


def create_face(image_path: str, name: str = "vox_host", kind: str = "legacy") -> dict:
    """Build a face from a single image. kind='trinity' (paid, high-quality lip-sync)
    or 'legacy' (free tier). Returns the API response (character_uid)."""
    if not os.path.exists(image_path):
        raise SystemExit(f"Image not found: {image_path}")
    endpoint = "/faces/trinity" if kind == "trinity" else "/faces/legacy"
    params = {"face_name": name} if kind == "trinity" else {"face_name": name, "characterVersion": "1.5"}
    with open(image_path, "rb") as f:
        resp = requests.post(
            f"{API_BASE}{endpoint}",
            headers={"x-simli-api-key": _key()},
            params=params,
            files={"image": (os.path.basename(image_path), f, "image/png")},
            timeout=120,
        )
    if resp.status_code >= 300:
        raise SystemExit(f"Simli error {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    record = {"type": kind, "face_name": name, "source_image": image_path, **data}
    with open(FACE_CACHE, "w") as out:
        json.dump(record, out, indent=2)
    return record


def list_faces() -> list:
    resp = requests.get(f"{API_BASE}/faces", headers={"x-simli-api-key": _key()}, timeout=30)
    resp.raise_for_status()
    return resp.json()


def delete_face(uid: str) -> None:
    resp = requests.delete(f"{API_BASE}/faces/{uid}", headers={"x-simli-api-key": _key()}, timeout=30)
    if resp.status_code >= 300:
        raise SystemExit(f"Simli error {resp.status_code}: {resp.text[:500]}")
    print(f"Deleted {uid}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "create"

    if cmd in ("create", "create-trinity"):
        kind = "trinity" if cmd == "create-trinity" else "legacy"
        img = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_IMAGE
        print(f"Submitting {img} to Simli ({kind} face build) ...")
        data = create_face(img, kind=kind)
        print(json.dumps(data, indent=2))
        print(f"\nCached -> {FACE_CACHE}")
    elif cmd == "list":
        print(json.dumps(list_faces(), indent=2))
    elif cmd == "delete":
        delete_face(sys.argv[2])
    elif cmd == "face":
        if not os.path.exists(FACE_CACHE):
            raise SystemExit(f"No {FACE_CACHE} yet — run: python simli.py create")
        print(open(FACE_CACHE).read())
    else:
        raise SystemExit(f"Unknown command {cmd!r}. Use: create | list | delete <uid> | face")
