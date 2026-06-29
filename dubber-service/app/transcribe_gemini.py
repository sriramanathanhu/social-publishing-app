"""
Gemini Flash timestamped transcription for shorts captions.

Deepgram is fast and word-accurate but effectively mono-lingual: for code-switched
speech (Sanskrit / Tamil / Hindi / English, often within one sentence) it forces
everything into a single language and garbles the rest. This path sends the audio
to Gemini Flash, which transcribes each portion in its OWN native script and
returns timestamped segments.

Returns the same ``(segments, words)`` shape the shorts pipeline expects:
``segments=[{start,end,text}]`` and ``words=[{word,start,end}]``. Gemini gives
segment-level (not word-level) timing, so word timings are interpolated within a
segment — coarser than Deepgram, but correct-language captions beat
perfectly-synced wrong-language ones.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time

from google import genai

from dubber.utils import log

# Flash (not Pro) per the product decision: cheap, fast, handles audio + native
# scripts well. Override via env if needed.
_MODEL = os.getenv("SHORTS_GEMINI_TRANSCRIBE_MODEL", "gemini-2.5-flash")

_PROMPT = (
    "Transcribe this audio EXACTLY as spoken, with timestamps. The speaker may mix "
    "languages (Hindi, Sanskrit, Tamil, English) — sometimes within one sentence. "
    "Transcribe each portion in the SAME language it is spoken, using that "
    "language's NATIVE script: Hindi and Sanskrit in Devanagari (देवनागरी), Tamil "
    "in the Tamil script (தமிழ்), English in the Latin alphabet. Do NOT translate, "
    "romanise, or transliterate; never flatten everything to one language.\n\n"
    "Return ONLY a JSON array covering the whole audio in order. Each element:\n"
    '{"start": <seconds from audio start, a number>, "end": <seconds, a number>, '
    '"text": "<verbatim text in native script>"}\n'
    "Make each segment a short phrase or sentence (roughly 2-6 seconds) so the "
    "timestamps stay accurate. Timestamps are in SECONDS (e.g. 12.4), strictly "
    "increasing and non-overlapping. Ignore silence and non-speech; no commentary."
)


def _extract_audio(media_path: str, out_dir: str) -> str:
    """Mono 16 kHz MP3 — small to upload, plenty for speech."""
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "gemini_audio.mp3")
    subprocess.run(
        ["ffmpeg", "-y", "-i", media_path, "-vn", "-ac", "1", "-ar", "16000",
         "-b:a", "64k", out],
        capture_output=True,
    )
    if not (os.path.exists(out) and os.path.getsize(out) > 1000):
        raise RuntimeError("Could not extract audio for Gemini transcription.")
    return out


def _to_sec(v) -> float:
    """Accept a number or 'M:SS' / 'H:MM:SS' string."""
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if ":" in s:
        p = [float(x) for x in s.split(":")]
        return p[0] * 60 + p[1] if len(p) == 2 else p[0] * 3600 + p[1] * 60 + p[2]
    try:
        return float(re.sub(r"[^0-9.]", "", s) or 0)
    except ValueError:
        return 0.0


def _words_from_segments(segments: list[dict]) -> list[dict]:
    """Interpolate word timings linearly across each segment (Gemini timing is
    segment-level). Good enough for line-grouped captions + clip boundaries."""
    words: list[dict] = []
    for seg in segments:
        toks = (seg.get("text") or "").split()
        if not toks:
            continue
        s, e = float(seg["start"]), float(seg["end"])
        per = max(0.2, e - s) / len(toks)
        for i, tok in enumerate(toks):
            ws = s + i * per
            words.append(
                {"word": tok, "start": round(ws, 3), "end": round(ws + per, 3)}
            )
    return words


def transcribe_with_gemini(
    media_path: str,
    output_dir: str,
    api_key: str,
    language: str = "auto",
) -> tuple[list[dict], list[dict]]:
    """Transcribe ``media_path`` with Gemini Flash → ``(segments, words)`` in the
    spoken languages' native scripts."""
    if not api_key:
        raise ValueError("Gemini API key is required for Gemini transcription")
    audio = _extract_audio(media_path, output_dir)
    client = genai.Client(api_key=api_key)

    f = client.files.upload(file=audio)
    for _ in range(180):  # wait for the upload to become ACTIVE
        f = client.files.get(name=f.name)
        state = str(f.state)
        if "ACTIVE" in state:
            break
        if "FAILED" in state:
            raise RuntimeError("Gemini could not process the audio.")
        time.sleep(1)

    log("GEMINI-TX", f"transcribing with {_MODEL} ...")
    try:
        resp = client.models.generate_content(
            model=_MODEL,
            contents=[f, _PROMPT],
            config={
                "temperature": 0.1,
                "max_output_tokens": 65536,
                "response_mime_type": "application/json",
                "system_instruction": (
                    "You are a precise, multilingual audio transcriptionist who "
                    "returns verbatim text in each spoken language's native script "
                    "with accurate timestamps, and never translates or transliterates."
                ),
            },
        )
    finally:
        try:
            client.files.delete(name=f.name)
        except Exception:  # noqa: BLE001 — cleanup is best-effort
            pass

    raw = (resp.text or "").strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\[.*\]", raw, re.S)
        data = json.loads(m.group(0)) if m else []

    segments: list[dict] = []
    for d in data:
        if not isinstance(d, dict):
            continue
        text = (d.get("text") or "").strip()
        if not text:
            continue
        s, e = _to_sec(d.get("start", 0)), _to_sec(d.get("end", 0))
        if e <= s:
            e = s + 1.0
        segments.append({"start": round(s, 3), "end": round(e, 3), "text": text})
    segments.sort(key=lambda x: x["start"])
    if not segments:
        raise RuntimeError("Gemini returned no transcribable speech.")

    words = _words_from_segments(segments)
    log("GEMINI-TX", f"{len(segments)} segments, {len(words)} words")
    return segments, words
