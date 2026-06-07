"""Vox voice — MiniMax TTS with word timings.

Turns a host reply into (audio bytes, per-chunk timestamps). The timestamps are
the whole point: they drive the karaoke captions synced to the avatar's voice
(Phase 5). Audio is requested before pixels — captions ride the audio clock, not
synthetic spacing.

ONE pinned voice + model per language (the #1 regression risk per ZO-NOTES: a
voice "identity break" if idle/bridge/answer audio drift across voices). Override
per language in VOICES below or via MINIMAX_VOICE_ID.

Run:
  python voice.py "The Shore Shirt in Navy Lyocell is perfect for hot weather!"
  # -> writes out.mp3 + prints the word timings
"""
from __future__ import annotations

import json
import os

import requests
from dotenv import load_dotenv

load_dotenv()

API_BASE = os.getenv("MINIMAX_API_BASE", "https://api.minimax.io")
TTS_MODEL = os.getenv("MINIMAX_TTS_MODEL", "speech-02-hd")

# Pin ONE voice per language. Keep the host's identity stable across every clip.
# (MiniMax system voice ids; override any of these in .env via MINIMAX_VOICE_ID.)
VOICES = {
    "en": "Friendly_Person",
    "es": "Friendly_Person",
    "fr": "Friendly_Person",
    "de": "Friendly_Person",
    "pt": "Friendly_Person",
    "zh": "Friendly_Person",
}


def voice_for(lang: str) -> str:
    return os.getenv("MINIMAX_VOICE_ID") or VOICES.get(lang, VOICES["en"])


def synth(text: str, lang: str = "en") -> tuple[bytes, list[dict]]:
    """Synthesize speech. Returns (mp3_bytes, timings).

    timings is a list of {"text", "start_ms", "end_ms"} chunks for karaoke
    captions (empty list if the model returns no subtitle track).
    """
    key = os.getenv("MINIMAX_API_KEY")
    if not key:
        raise SystemExit("Set MINIMAX_API_KEY in .env")
    group = os.getenv("MINIMAX_GROUP_ID", "")

    url = f"{API_BASE}/v1/t2a_v2"
    if group:
        url += f"?GroupId={group}"
    resp = requests.post(
        url,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": TTS_MODEL,
            "text": text,
            "stream": False,
            "subtitle_enable": True,  # ask for word/char timestamps
            "voice_setting": {"voice_id": voice_for(lang), "speed": 1.0, "vol": 1.0, "pitch": 0},
            "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1},
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    base = data.get("base_resp") or {}
    if base.get("status_code"):
        raise SystemExit(f"MiniMax TTS error {base['status_code']}: {base.get('status_msg')}")

    payload = data["data"]
    audio = bytes.fromhex(payload["audio"])
    timings = _parse_subtitle(payload.get("subtitle_file"))
    return audio, timings


# --- Voice provider for the low-latency STREAM path -----------------------
# ElevenLabs (best quality + lowest latency) if a key is set; else MiniMax.
EL_KEY = os.getenv("ELEVENLABS_API_KEY")
EL_VOICE = os.getenv("ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB")  # default premade voice
EL_MODEL = os.getenv("ELEVENLABS_MODEL", "eleven_flash_v2_5")        # ~75ms TTFB
# Sample rate of the streamed PCM (the browser is told this in the /ask_stream meta).
PCM_SAMPLE_RATE = 24000 if EL_KEY else 32000


def synth_stream(text: str, lang: str = "en", sample_rate: int | None = None):
    """Yield raw 16-bit mono PCM byte-chunks (low latency) for Web-Audio streaming.

    ElevenLabs Flash if ELEVENLABS_API_KEY is set (best voice, ~75ms to first byte),
    otherwise MiniMax streaming TTS. The browser plays chunks as they arrive, so the
    host starts talking almost immediately. No subtitles on the streaming path.

    sample_rate overrides the MiniMax PCM rate (the Simli avatar ingests 16 kHz, so the
    live agent asks for that to avoid a resample). Defaults to PCM_SAMPLE_RATE.
    """
    if EL_KEY:
        yield from _stream_elevenlabs(text)
        return
    yield from _stream_minimax(text, lang, sample_rate or 32000)


def _stream_elevenlabs(text: str):
    """ElevenLabs streaming TTS -> raw PCM (pcm_24000) chunks."""
    url = (f"https://api.elevenlabs.io/v1/text-to-speech/{EL_VOICE}/stream"
           f"?output_format=pcm_24000")
    resp = requests.post(
        url,
        headers={"xi-api-key": EL_KEY, "Content-Type": "application/json"},
        json={
            "text": text,
            "model_id": EL_MODEL,
            "voice_settings": {"stability": 0.45, "similarity_boost": 0.8, "style": 0.25, "use_speaker_boost": True},
        },
        stream=True,
        timeout=60,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"ElevenLabs error {resp.status_code}: {resp.text[:200]}")
    for chunk in resp.iter_content(chunk_size=8192):
        if chunk:
            yield chunk


def _stream_minimax(text: str, lang: str = "en", sample_rate: int = 32000):
    """MiniMax streaming TTS -> raw PCM chunks (fallback)."""
    key = os.getenv("MINIMAX_API_KEY")
    if not key:
        raise SystemExit("Set ELEVENLABS_API_KEY or MINIMAX_API_KEY in .env")
    model = os.getenv("MINIMAX_TTS_STREAM_MODEL", "speech-02-turbo")
    resp = requests.post(
        f"{API_BASE}/v1/t2a_v2",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "text": text,
            "stream": True,
            "voice_setting": {"voice_id": voice_for(lang), "speed": 1.0, "vol": 1.0, "pitch": 0},
            "audio_setting": {"sample_rate": sample_rate, "bitrate": 128000, "format": "pcm", "channel": 1},
        },
        stream=True,
        timeout=60,
    )
    resp.raise_for_status()
    for line in resp.iter_lines():
        if not line:
            continue
        s = line.decode("utf-8", "ignore")
        if not s.startswith("data:"):
            continue
        try:
            d = json.loads(s[5:])
        except Exception:
            continue
        data = d.get("data") or {}
        # MiniMax sends incremental status=1 chunks, then a FINAL status=2 chunk that
        # repeats the ENTIRE audio — yielding that too plays everything twice. Skip it.
        if data.get("status") == 2:
            continue
        audio_hex = data.get("audio")
        if audio_hex:
            yield bytes.fromhex(audio_hex)


def _parse_subtitle(subtitle_url: str | None) -> list[dict]:
    """Fetch MiniMax's subtitle file and return per-WORD timings.

    MiniMax gives sentence-level segments ([{text, time_begin, time_end}]); we
    interpolate word timings inside each segment, proportional to word length,
    so karaoke captions can highlight word-by-word.
    """
    if not subtitle_url:
        return []
    try:
        segments = requests.get(subtitle_url, timeout=30).json()
    except Exception:
        return []

    words: list[dict] = []
    for seg in segments:
        start = float(seg.get("time_begin", 0))
        end = float(seg.get("time_end", start))
        words.extend(_split_segment(seg.get("text", ""), start, end))
    return words


def _split_segment(text: str, start: float, end: float) -> list[dict]:
    """Spread a segment's [start,end] across its words by character weight."""
    tokens = text.split()
    if not tokens:
        return []
    span = max(end - start, 1.0)
    total = sum(len(t) for t in tokens)
    out, t = [], start
    for tok in tokens:
        dur = span * (len(tok) / total)
        out.append({"text": tok, "start_ms": round(t), "end_ms": round(t + dur)})
        t += dur
    return out


if __name__ == "__main__":
    import sys

    text = sys.argv[1] if len(sys.argv) > 1 else "The Shore Shirt in Navy Lyocell is perfect for hot weather!"
    lang = sys.argv[2] if len(sys.argv) > 2 else "en"

    print(f"Synthesizing ({lang}, voice={voice_for(lang)}, model={TTS_MODEL}) ...")
    audio, timings = synth(text, lang)
    with open("out.mp3", "wb") as f:
        f.write(audio)
    print(f"  wrote out.mp3 ({len(audio)} bytes)")
    if timings:
        print(f"  {len(timings)} timed chunks:")
        for t in timings[:12]:
            print(f"    [{t['start_ms']:>6}–{t['end_ms']:>6} ms] {t['text']}")
    else:
        print("  (no subtitle timings returned — check model/subtitle_enable support)")
