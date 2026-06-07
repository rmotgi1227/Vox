"""Vox live agent — the real-time AI saleswoman.

This is the live Q&A path: a visitor joins a LiveKit room (mic + chat), and this
agent runs the whole loop, all on the sponsor stack:

    visitor speech ──► MiniMax STT
    visitor turn   ──► Moss retrieval (brain.retrieve) injected as grounding
                   ──► MiniMax LLM  (writes the grounded reply)
                   ──► MiniMax TTS  (speaks it)
                   ──► Simli avatar (her face, lip-synced live)  ──► back over LiveKit

MiniMax is the generative core (STT + LLM + TTS); Simli only animates her mouth.
The host face is the MiniMax-generated portrait, built into a Simli legacy face
(see simli.py / simli_face.json). Pre-rendered greeting/idle clips live elsewhere;
this agent is the live reactive layer.

Run (after `pip install -r requirements.txt` and a built Simli face):
    python agent.py dev      # connect to LiveKit Cloud, wait for a room to join
    python agent.py console  # local mic test in the terminal
"""
from __future__ import annotations

import asyncio
import json
import os

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RoomInputOptions,
    RoomOutputOptions,
    WorkerOptions,
    cli,
    tts as lk_tts,
    utils as lk_utils,
)
from livekit.agents.llm import ChatContext, ChatMessage
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS
from livekit.plugins import openai, silero, simli
from moss import MossClient

import brain
import car_catalog
import voice

load_dotenv()

# --- Work around a race in livekit's audio StreamBuffer -----------------------
# The MiniMax TTS plugin can push a final audio chunk after the decoder buffer is
# closed; StreamBuffer.write() seeks a closed BytesIO -> ValueError -> no audio ->
# no avatar video. Guard write-after-close (the buffer already tracks _closed).
from livekit.agents.utils.codecs import decoder as _lk_decoder  # noqa: E402


def _safe_stream_write(self, data: bytes) -> None:
    with self._data_available:
        if self._closed:
            return
        self._bio.seek(self._write_pos)
        self._bio.write(data)
        self._write_pos = self._bio.tell()
        self._data_available.notify_all()


_lk_decoder.StreamBuffer.write = _safe_stream_write


# --- MiniMax TTS via our own voice.py (raw PCM, no PyAV decode) ---------------
# The livekit MiniMax TTS plugin emits audio PyAV can't decode (InvalidDataError).
# voice.py already does MiniMax TTS over REST and yields raw 16-bit mono PCM, which
# we hand to the AudioEmitter as audio/pcm — no decoder, no plugin.

# MiniMax TTS reliably emits 32 kHz PCM; LiveKit resamples to Simli's 16 kHz. (16 kHz
# direct from MiniMax was unverified — speech-02-turbo returned empty for it.)
class VoxTTS(lk_tts.TTS):
    def __init__(self, lang: str = "en") -> None:
        super().__init__(
            capabilities=lk_tts.TTSCapabilities(streaming=False),
            sample_rate=voice.PCM_SAMPLE_RATE,
            num_channels=1,
        )
        self._lang = lang

    def synthesize(self, text: str, *, conn_options=DEFAULT_API_CONNECT_OPTIONS) -> lk_tts.ChunkedStream:
        return _VoxStream(tts=self, input_text=text, conn_options=conn_options, lang=self._lang)


class _VoxStream(lk_tts.ChunkedStream):
    def __init__(self, *, tts: VoxTTS, input_text: str, conn_options, lang: str) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._lang = lang

    async def _run(self, output_emitter) -> None:
        output_emitter.initialize(
            request_id=lk_utils.shortuuid(),
            sample_rate=self._tts.sample_rate,
            num_channels=1,
            mime_type="audio/pcm",
        )
        loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue()

        def produce():  # voice.synth_stream is blocking (requests) -> run off-loop
            try:
                for chunk in voice.synth_stream(self._input_text, self._lang, sample_rate=self._tts.sample_rate):
                    loop.call_soon_threadsafe(q.put_nowait, chunk)
            except Exception as e:  # surface TTS errors into the async side
                loop.call_soon_threadsafe(q.put_nowait, e)
            finally:
                loop.call_soon_threadsafe(q.put_nowait, None)

        loop.run_in_executor(None, produce)
        while True:
            item = await q.get()
            if item is None:
                break
            if isinstance(item, Exception):
                raise item
            output_emitter.push(item)
        output_emitter.flush()

INDEX = os.getenv("MOSS_INDEX_NAME", "vox-cars")
TTS_VOICE = os.getenv("MINIMAX_VOICE_ID", "Friendly_Person")
TTS_MODEL = os.getenv("MINIMAX_TTS_MODEL", "speech-02-turbo")
LLM_MODEL = os.getenv("MINIMAX_MODEL", "MiniMax-Text-01")
# MiniMax speaks OpenAI's dialect at this base URL, so the openai plugin drives it.
MINIMAX_BASE = os.getenv("MINIMAX_OPENAI_BASE", "https://api.minimax.io/v1")


def _stt():
    """Voice input needs a transcription provider (MiniMax has none in-plugin).
    Prefer Groq Whisper (free, fast, OpenAI-compatible), then OpenAI, then Deepgram,
    else None (text chat only)."""
    if os.getenv("GROQ_API_KEY"):
        return openai.STT(
            model=os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo"),
            base_url="https://api.groq.com/openai/v1",
            api_key=os.environ["GROQ_API_KEY"],
        )
    if os.getenv("OPENAI_API_KEY"):
        return openai.STT()
    if os.getenv("DEEPGRAM_API_KEY"):
        from livekit.plugins import deepgram
        return deepgram.STT()
    return None


def _face_id() -> str:
    """The Simli character_uid for her face, cached by simli.py."""
    if os.path.exists("simli_face.json"):
        rec = json.load(open("simli_face.json"))
        fid = rec.get("character_uid") or rec.get("faceId") or rec.get("face_id")
        if fid:
            return fid
    fid = os.getenv("SIMLI_FACE_ID")
    if not fid:
        raise SystemExit("No Simli face — run `python simli.py create` or set SIMLI_FACE_ID")
    return fid


class VoxHost(Agent):
    """The saleswoman. Persona from brain.SYSTEM; every turn is grounded in Moss.

    On a vehicle page she's ANCHORED to the car being viewed (car!=None): she leads
    with it and only pivots to alternatives when asked — or when it JUST SOLD."""

    def __init__(self, moss: MossClient, car=None) -> None:
        instructions = brain.SYSTEM
        if car is not None:
            instructions += (
                f"\n\nThe shopper is on the page for THIS car: {car.to_text()} "
                "Lead with this car. Only bring up another car if they ask for something "
                "cheaper/different, or if this car just sold."
            )
        super().__init__(instructions=instructions)
        self._moss = moss
        self._car = car

    async def _anchor_available(self) -> bool:
        """Is the viewed car still in stock? (retrieve filters available=true, so if its
        own VIN no longer comes back for its own title, it's sold.)"""
        if self._car is None:
            return True
        docs = await brain.retrieve(self._moss, self._car.title, top_k=8)
        return any(d.id == self._car.vin for d in docs)

    async def on_user_turn_completed(self, turn_ctx: ChatContext, new_message: ChatMessage) -> None:
        """RAG: reload the live index (to see sales made this session), pull matching
        in-stock cars, and inject them as grounding so she can't invent stock — the
        'never sell what's sold out' pivot, live."""
        query = new_message.text_content
        if not query:
            return
        await self._moss.load_index(INDEX)  # see /sold_out upserts from the other process
        docs = await brain.retrieve(self._moss, query)
        block = ""
        if self._car is not None:
            sold = not await self._anchor_available()
            status = (" — NOTE: this exact car JUST SOLD; tell them warmly and pivot to the "
                      "closest match below.") if sold else ""
            block += f"THE CAR THEY'RE VIEWING:\n{self._car.to_text()}{status}\n\n"
        block += f"OTHER CARS ON THE LOT:\n{brain.format_context(docs)}"
        turn_ctx.add_message(role="assistant", content=block)


def _car_from_room(room_name: str | None):
    """Room is 'vox-car-<VIN>-<rand>' on a vehicle page -> the car she's anchored to."""
    if not room_name or not room_name.startswith("vox-car-"):
        return None
    parts = room_name.split("-")
    return car_catalog.by_vin(parts[2]) if len(parts) >= 3 else None


async def entrypoint(ctx: JobContext) -> None:
    # Moss: the live catalog she's grounded in (whole inventory).
    moss = MossClient(os.environ["MOSS_PROJECT_ID"], os.environ["MOSS_PROJECT_KEY"])
    await moss.load_index(INDEX)
    car = _car_from_room(ctx.room.name)

    session = AgentSession(
        stt=_stt(),                                          # visitor voice -> text (optional)
        llm=openai.LLM(model=LLM_MODEL, base_url=MINIMAX_BASE,  # MiniMax via OpenAI dialect
                       api_key=os.environ["MINIMAX_API_KEY"]),
        tts=VoxTTS(),                                        # MiniMax via voice.py (raw PCM)
        vad=silero.VAD.load(),                               # turn detection
    )

    # Simli renders her face live, driven by the session's TTS audio.
    avatar = simli.AvatarSession(
        simli_config=simli.SimliConfig(api_key=os.environ["SIMLI_API_KEY"], face_id=_face_id()),
    )
    await avatar.start(session, room=ctx.room)

    await session.start(
        agent=VoxHost(moss, car),
        room=ctx.room,
        # Accept the visitor's typed chat + mic; the avatar publishes the audio.
        room_input_options=RoomInputOptions(text_enabled=True),
        room_output_options=RoomOutputOptions(audio_enabled=False, transcription_enabled=True),
    )

    # Scripted greeting (no LLM call). Anchored to the car on a VDP, generic otherwise.
    if car is not None:
        highlight = (car.features[0] if car.features else car.blurb) or "a great spec"
        greeting = (
            f"Hey, welcome in! You're looking at the {car.year} {car.make} {car.model} "
            f"in {car.color} — {highlight.lower() if isinstance(highlight, str) else highlight}. "
            "Want me to walk you through it, or do you have a question?"
        )
    else:
        greeting = (
            "Hey, welcome in! I'm Vox — I can help you find the right car on the lot. "
            "Ask me anything: your budget, the kind of car you need, or about the one you're looking at."
        )

    # Don't greet until the client has SUBSCRIBED to the avatar tracks + unblocked audio,
    # otherwise the avatar speaks into the void and only the transcript text shows. The
    # browser sends a 'greet' data packet once it's ready; a timeout fallback covers older
    # clients so she always greets.
    _greeted = False

    async def _greet():
        nonlocal _greeted
        if _greeted:
            return
        _greeted = True
        await session.say(greeting)

    @ctx.room.on("data_received")
    def _on_data(pkt) -> None:
        try:
            if getattr(pkt, "topic", "") == "vox-control" and bytes(pkt.data).decode() == "greet":
                asyncio.create_task(_greet())
        except Exception:
            pass

    async def _greet_fallback() -> None:
        await asyncio.sleep(5)
        await _greet()

    asyncio.create_task(_greet_fallback())


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
