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

import glob
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
# Transcribe in fixed source-aligned windows: Gemini's timestamps are reliable on
# SHORT audio but drift badly across a whole long video, so we split, transcribe
# each window with CHUNK-RELATIVE timing, then offset by the window's real start.
_CHUNK_SEC = float(os.getenv("SHORTS_GEMINI_CHUNK_SEC", "90"))

_PROMPT = (
    "Transcribe this audio clip EXACTLY as spoken, with timestamps. The speaker "
    "may mix languages (Hindi, Sanskrit, Tamil, English) — sometimes within one "
    "sentence. Transcribe each portion in the SAME language it is spoken, using "
    "that language's NATIVE script: Hindi and Sanskrit in Devanagari (देवनागरी), "
    "Tamil in the Tamil script (தமிழ்), English in the Latin alphabet. Do NOT "
    "translate, romanise, or transliterate; never flatten everything to one "
    "language.\n\n"
    "Return ONLY a JSON array covering this clip in order. Each element:\n"
    '{"start": <seconds from the START OF THIS CLIP, a number>, '
    '"end": <seconds from the start of this clip>, '
    '"text": "<verbatim text in native script>"}\n'
    "Make each segment a short phrase (roughly 2-5 seconds) so timestamps stay "
    "accurate. Timestamps are in SECONDS from the start of THIS clip (the first "
    "word is near 0), strictly increasing and non-overlapping. Ignore silence and "
    "non-speech; no commentary."
)


def _chunk_audio(media_path: str, out_dir: str) -> list[str]:
    """Split source audio into fixed ~_CHUNK_SEC windows, mono 16 kHz MP3, WITHOUT
    trimming silence (the timeline must stay source-aligned). Returns the ordered
    chunk paths."""
    os.makedirs(out_dir, exist_ok=True)
    full = os.path.join(out_dir, "gemini_full.mp3")
    subprocess.run(
        ["ffmpeg", "-y", "-i", media_path, "-vn", "-ac", "1", "-ar", "16000",
         "-b:a", "64k", full],
        capture_output=True,
    )
    if not (os.path.exists(full) and os.path.getsize(full) > 1000):
        raise RuntimeError("Could not extract audio for Gemini transcription.")
    pattern = os.path.join(out_dir, "gchunk_%04d.mp3")
    subprocess.run(
        ["ffmpeg", "-y", "-i", full, "-f", "segment",
         "-segment_time", str(_CHUNK_SEC), "-c:a", "libmp3lame", "-q:a", "5",
         pattern],
        capture_output=True,
    )
    chunks = sorted(glob.glob(os.path.join(out_dir, "gchunk_*.mp3")))
    return chunks or [full]


def _probe_dur(path: str) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return _CHUNK_SEC


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


def _transcribe_chunk(client: "genai.Client", path: str) -> list[dict]:
    """Transcribe ONE short chunk → chunk-relative ``[{start,end,text}]``."""
    f = client.files.upload(file=path)
    for _ in range(180):  # wait for the upload to become ACTIVE
        f = client.files.get(name=f.name)
        state = str(f.state)
        if "ACTIVE" in state:
            break
        if "FAILED" in state:
            raise RuntimeError("Gemini could not process the audio chunk.")
        time.sleep(1)
    try:
        resp = client.models.generate_content(
            model=_MODEL,
            contents=[f, _PROMPT],
            config={
                "temperature": 0.1,
                "max_output_tokens": 16384,
                "response_mime_type": "application/json",
                "system_instruction": (
                    "You are a precise, multilingual audio transcriptionist who "
                    "returns verbatim text in each spoken language's native script "
                    "with clip-relative timestamps, and never translates."
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
    out: list[dict] = []
    for d in data:
        if not isinstance(d, dict):
            continue
        text = (d.get("text") or "").strip()
        if not text:
            continue
        s, e = _to_sec(d.get("start", 0)), _to_sec(d.get("end", 0))
        if e <= s:
            e = s + 1.0
        out.append({"start": s, "end": e, "text": text})
    return out


def transcribe_with_gemini(
    media_path: str,
    output_dir: str,
    api_key: str,
    language: str = "auto",
) -> tuple[list[dict], list[dict]]:
    """Transcribe ``media_path`` with Gemini Flash → ``(segments, words)`` in the
    spoken languages' native scripts, with SOURCE-aligned timestamps. Done in
    fixed windows so Gemini's (otherwise drifting) timing stays accurate, then
    each window is offset by its real start time on the source timeline."""
    if not api_key:
        raise ValueError("Gemini API key is required for Gemini transcription")
    chunks = _chunk_audio(media_path, output_dir)
    client = genai.Client(api_key=api_key)

    segments: list[dict] = []
    offset = 0.0
    for idx, path in enumerate(chunks):
        dur = _probe_dur(path)
        try:
            local = _transcribe_chunk(client, path)
        except Exception as exc:  # noqa: BLE001 — one bad chunk shouldn't kill all
            log("GEMINI-TX", f"chunk {idx} failed: {exc}")
            local = []
        for seg in local:
            s = offset + seg["start"]
            e = offset + seg["end"]
            # Keep a segment from spilling past its window (clamp to the chunk).
            e = min(e, offset + dur + 0.5)
            if e > s:
                segments.append(
                    {"start": round(s, 3), "end": round(e, 3), "text": seg["text"]}
                )
        offset += dur

    segments.sort(key=lambda x: x["start"])
    if not segments:
        raise RuntimeError("Gemini returned no transcribable speech.")

    words = _words_from_segments(segments)
    log("GEMINI-TX",
        f"{len(chunks)} chunks → {len(segments)} segments, {len(words)} words")
    return segments, words
