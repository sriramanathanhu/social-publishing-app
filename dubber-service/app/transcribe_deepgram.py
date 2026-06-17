"""Deepgram transcription adapter.

Drop-in replacement for ``dubber.transcriber.transcribe_audio`` that uses
Deepgram's prerecorded API instead of a self-hosted faster-whisper model. This
is what removes the GPU requirement: transcription becomes a per-user, per-job
API call billed to the user's own Deepgram key.

The contract that the rest of the pipeline depends on is a list of segment
dicts ``[{"start": float, "end": float, "text": str}, ...]`` sorted by start
time — identical to what the Whisper path returns (see
``dubber/transcriber.py``), so ``merge_short_segments`` / ``translate_segments``
/ ``generate_tts_audio`` / ``build_dubbed_video`` consume it unchanged.
"""

from __future__ import annotations

import os
import subprocess
from typing import Optional

import requests

from dubber.utils import log

DEEPGRAM_URL = "https://api.deepgram.com/v1/listen"
# nova-2 has the broadest language coverage and returns word + utterance level
# timestamps, which is exactly what dub alignment needs.
DEFAULT_MODEL = os.getenv("DEEPGRAM_MODEL", "nova-2")
# 16 kHz mono PCM WAV: small, lossless enough for ASR, and matches what the
# Whisper path produced — keeps Deepgram's billed audio-minutes minimal.
PROBE_SAMPLE_RATE = "16000"
PROBE_CHANNELS = "1"


def _extract_wav(media_path: str, output_dir: str) -> str:
    """Decode any video/audio input to a mono 16 kHz WAV via FFmpeg."""
    os.makedirs(output_dir, exist_ok=True)
    wav_path = os.path.join(output_dir, "dg_input.wav")
    cmd = [
        "ffmpeg", "-y", "-i", media_path,
        "-vn", "-ac", PROBE_CHANNELS, "-ar", PROBE_SAMPLE_RATE,
        "-c:a", "pcm_s16le", wav_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(wav_path):
        raise RuntimeError(
            f"ffmpeg audio extraction failed: {proc.stderr[-400:]}"
        )
    return wav_path


def _segments_from_response(payload: dict) -> list[dict]:
    """Map a Deepgram response to ``[{start, end, text}]`` segments.

    Prefers ``utterances`` (sentence-level, the closest analogue to Whisper
    segments). Falls back to grouping ``words`` if utterances are absent.
    """
    utterances = payload.get("results", {}).get("utterances") or []
    if utterances:
        segs = []
        for utt in utterances:
            text = (utt.get("transcript") or "").strip()
            if not text:
                continue
            segs.append(
                {
                    "start": round(float(utt.get("start", 0.0)), 3),
                    "end": round(float(utt.get("end", 0.0)), 3),
                    "text": text,
                }
            )
        if segs:
            return sorted(segs, key=lambda s: s["start"])

    # Fallback: reconstruct coarse segments from word timings.
    try:
        words = (
            payload["results"]["channels"][0]["alternatives"][0]["words"]
        )
    except (KeyError, IndexError):
        words = []
    if not words:
        return []

    segs, buf, buf_start, buf_end = [], [], None, None
    for w in words:
        token = w.get("punctuated_word") or w.get("word") or ""
        if buf_start is None:
            buf_start = float(w.get("start", 0.0))
        buf.append(token)
        buf_end = float(w.get("end", buf_end or 0.0))
        # Break on sentence-final punctuation to approximate utterances.
        if token.endswith((".", "?", "!", "।")):
            segs.append(
                {
                    "start": round(buf_start, 3),
                    "end": round(buf_end, 3),
                    "text": " ".join(buf).strip(),
                }
            )
            buf, buf_start, buf_end = [], None, None
    if buf:
        segs.append(
            {
                "start": round(buf_start or 0.0, 3),
                "end": round(buf_end or 0.0, 3),
                "text": " ".join(buf).strip(),
            }
        )
    return sorted(segs, key=lambda s: s["start"])


def transcribe_audio_deepgram(
    media_path: str,
    output_dir: str,
    api_key: str,
    language: str = "auto",
    model: Optional[str] = None,
) -> list[dict]:
    """Transcribe ``media_path`` with Deepgram, returning dub segments.

    Args:
        media_path: input video or audio file.
        output_dir: working dir for the extracted WAV.
        api_key: the user's Deepgram API key (never persisted by this service).
        language: ISO code (e.g. ``"en"``) or ``"auto"`` to detect.
        model: Deepgram model override; defaults to ``DEEPGRAM_MODEL`` env / nova-2.
    """
    if not api_key:
        raise ValueError("Deepgram API key is required")

    wav_path = _extract_wav(media_path, output_dir)

    params = {
        "model": model or DEFAULT_MODEL,
        "smart_format": "true",
        "utterances": "true",
        "punctuate": "true",
    }
    if language and language != "auto":
        params["language"] = language
    else:
        params["detect_language"] = "true"

    log("DEEPGRAM", f"Transcribing ({params['model']}, lang={language}) ...")
    with open(wav_path, "rb") as fh:
        resp = requests.post(
            DEEPGRAM_URL,
            params=params,
            headers={
                "Authorization": f"Token {api_key}",
                "Content-Type": "audio/wav",
            },
            data=fh,
            timeout=600,
        )

    if resp.status_code != 200:
        raise RuntimeError(
            f"Deepgram error {resp.status_code}: {resp.text[:300]}"
        )

    segments = _segments_from_response(resp.json())
    log("DEEPGRAM", f"Got {len(segments)} segments.")
    if not segments:
        raise RuntimeError("Deepgram returned no transcribable speech.")
    return segments


def _words_from_response(payload: dict) -> list[dict]:
    """Flat word list ``[{word, start, end}]`` from a Deepgram response."""
    try:
        words = payload["results"]["channels"][0]["alternatives"][0].get("words", [])
    except (KeyError, IndexError):
        return []
    out = []
    for w in words:
        # smart_format puts the nicely-punctuated token in punctuated_word.
        token = w.get("punctuated_word") or w.get("word") or ""
        out.append({
            "word": token,
            "start": float(w.get("start", 0.0)),
            "end": float(w.get("end", 0.0)),
        })
    return out


def transcribe_with_words(
    media_path: str,
    output_dir: str,
    api_key: str,
    language: str = "auto",
    model: Optional[str] = None,
) -> tuple[list[dict], list[dict]]:
    """Like :func:`transcribe_audio_deepgram` but also returns word-level timings.

    Returns ``(segments, words)``. Words drive sentence-accurate clip boundaries
    and word-by-word caption timing in the shorts pipeline.
    """
    if not api_key:
        raise ValueError("Deepgram API key is required")
    wav_path = _extract_wav(media_path, output_dir)
    params = {
        "model": model or DEFAULT_MODEL,
        "smart_format": "true",
        "utterances": "true",
        "punctuate": "true",
    }
    if language and language != "auto":
        params["language"] = language
    else:
        params["detect_language"] = "true"

    with open(wav_path, "rb") as fh:
        resp = requests.post(
            DEEPGRAM_URL, params=params,
            headers={"Authorization": f"Token {api_key}", "Content-Type": "audio/wav"},
            data=fh, timeout=600,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"Deepgram error {resp.status_code}: {resp.text[:300]}")
    payload = resp.json()
    segments = _segments_from_response(payload)
    words = _words_from_response(payload)
    if not segments:
        raise RuntimeError("Deepgram returned no transcribable speech.")
    log("DEEPGRAM", f"Got {len(segments)} segments, {len(words)} words.")
    return segments, words
