"""
Gemini visual clip selection — the model WATCHES the source video (frames +
audio), not just the transcript, and returns the strongest standalone moments.

Defaults to media_resolution=LOW so a ~30-min video fits the free-tier 250k
tokens/minute limit (and costs ~3-4x less). Any failure (quota, too long,
upload error) raises so the pipeline falls back to the NIM/text selector —
nobody is ever blocked.
"""

from __future__ import annotations

import json
import time

from google import genai
from google.genai import types

from .shorts_ai import (
    DEFAULT_CHANNEL,
    DEFAULT_SPEAKER,
    _dedup,
    _parse_boundaries,
    _snap,
    build_sentences,
    enforce_duration,
)
from .utils import log

DEFAULT_MODEL = "gemini-2.5-flash"

# Structured-output schema so Gemini returns clean JSON we can trust.
CLIP_SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_seconds": {"type": "integer"},
                    "end_seconds": {"type": "integer"},
                    "title": {"type": "string"},
                    "hook": {"type": "string"},
                    "closing_line": {"type": "string"},
                    "core_teaching": {"type": "string"},
                    "viral_score": {"type": "integer"},
                },
                "required": ["start_seconds", "end_seconds", "title"],
            },
        }
    },
    "required": ["clips"],
}


def _resolution(name: str):
    m = {
        "low": types.MediaResolution.MEDIA_RESOLUTION_LOW,
        "medium": types.MediaResolution.MEDIA_RESOLUTION_MEDIUM,
        "high": types.MediaResolution.MEDIA_RESOLUTION_HIGH,
    }
    return m.get((name or "low").lower(), types.MediaResolution.MEDIA_RESOLUTION_LOW)


def _prompt(num_clips, min_sec, max_sec, duration, ctx) -> str:
    return f"""You are a world-class short-form video editor for content by {ctx['speaker']} ({ctx['channel']}).
Watch this {int(duration)}s video and select up to {num_clips} clips. Each clip must be ONE complete, powerful, standalone teaching that makes full sense with ZERO prior context.

Rules for every clip:
- Duration {min_sec}-{max_sec} seconds.
- Start on a strong HOOK sentence that stands alone (no "and/but/so/this/that/he/she" openers, no greetings).
- End on a COMPLETE sentence (ending in . ? or !). Never cut mid-sentence.
- Use the actual spoken words and on-screen context to judge strength.

For each clip return: start_seconds and end_seconds (integers on the video timeline), a short title, the hook (first sentence verbatim), the closing_line (last sentence verbatim), a one-sentence core_teaching, and a viral_score 0-100."""


def find_clips_gemini(video_path, words, *, num_clips, min_sec, max_sec, duration,
                      api_key, model, media_resolution, settings, on_log=print):
    """Upload the video to Gemini, get clip picks, snap to sentence boundaries.
    Raises on any failure so the caller can fall back to the NIM selector."""
    client = genai.Client(api_key=api_key)

    on_log("Gemini: uploading video ...")
    f = client.files.upload(file=video_path)
    waited = 0
    while getattr(f.state, "name", str(f.state)) == "PROCESSING":
        time.sleep(3)
        waited += 3
        if waited > 600:
            raise TimeoutError("Gemini file processing timed out")
        f = client.files.get(name=f.name)
    if getattr(f.state, "name", str(f.state)) == "FAILED":
        raise RuntimeError("Gemini could not process the video")

    ctx = {
        "speaker": settings.get("speaker", DEFAULT_SPEAKER),
        "channel": settings.get("channel", DEFAULT_CHANNEL),
    }
    try:
        on_log("Gemini: analysing video ...")
        resp = client.models.generate_content(
            model=model or DEFAULT_MODEL,
            contents=[f, _prompt(num_clips, min_sec, max_sec, duration, ctx)],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=CLIP_SCHEMA,
                media_resolution=_resolution(media_resolution),
                temperature=1.0,
            ),
        )
    finally:
        try:
            client.files.delete(name=f.name)
        except Exception:  # noqa: BLE001
            pass

    data = json.loads(resp.text)
    clips = data.get("clips", [])
    if not clips:
        raise RuntimeError("Gemini returned no clips")

    # Snap to sentence boundaries (word-level) so cuts complete sentences, then
    # hard-enforce min floor / max ceiling (when we have boundaries to repair to).
    bounds = _parse_boundaries(build_sentences(words)) if words else []
    if bounds:
        clips = _snap(clips, bounds, min_sec, max_sec)
        clips = enforce_duration(clips, min_sec, max_sec)
    clips = _dedup(clips)[:num_clips]
    for i, c in enumerate(clips, 1):
        c["rank"] = i
    log("SHORTS", f"Gemini selected {len(clips)} clips")
    return clips
