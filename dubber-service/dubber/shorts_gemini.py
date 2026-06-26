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
                      api_key, model, media_resolution, settings, segments=None,
                      on_log=print):
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

    # Always snap so cuts complete sentences: prefer word-built sentences, but
    # fall back to Deepgram utterance segments when word timings are sparse/absent
    # (Gemini returns whole-second guesses that otherwise cut mid-sentence). Then
    # hard-enforce min floor / max ceiling.
    units = build_sentences(words) if words else (segments or [])
    bounds = _parse_boundaries(units)
    if bounds:
        clips = _snap(clips, bounds, min_sec, max_sec)
        clips = enforce_duration(clips, min_sec, max_sec)
    clips = _dedup(clips)[:num_clips]
    for i, c in enumerate(clips, 1):
        c["rank"] = i
    log("SHORTS", f"Gemini selected {len(clips)} clips")
    return clips


# ─── Gemini TEXT selection (reads the transcript, not the video) ──────────────
# Preferred over the NIM text model: the WHOLE transcript goes in one call, so
# the model sees complete jokes/stories and never grabs half of one.

# Try the best model first (paid keys land on pro); fall back to flash (free
# keys / quota). If both fail the caller falls back to the NVIDIA selector.
SELECT_MODELS = ("gemini-2.5-pro", "gemini-2.5-flash")


def _timestamped_text(words, segments) -> str:
    """Full transcript as '[start-end] sentence' lines for the model to reason
    over (sentence units so boundaries land on whole thoughts)."""
    units = build_sentences(words) if words else (segments or [])
    lines = []
    for u in units:
        t = (u.get("text") or "").strip()
        if t:
            lines.append(f"[{int(u.get('start', 0))}-{int(u.get('end', 0))}] {t}")
    return "\n".join(lines)


def _text_prompt(num_clips, min_sec, max_sec, flex_cap, duration, ctx,
                 auto=False) -> str:
    how_many = (
        "Return EVERY clip that is genuinely worth posting as a standalone reel — "
        f"as many as this video truly contains and no more (could be 2, could be 15). "
        f"Do NOT pad to a number; quality over quantity. Only include a clip if you "
        f"would actually publish it. (Hard safety limit: at most {num_clips} — but "
        f"return far fewer unless the video really has that many strong moments.)"
        if auto
        else f"Choose the {num_clips} STRONGEST standalone clips for social reels, best first."
    )
    return f"""You are a world-class short-form video editor for content by {ctx['speaker']} ({ctx['channel']}).

Below is the FULL timestamped transcript of a {int(duration)}-second video. Each line is "[start-end] text" (seconds on the video timeline).

{how_many}

CRITICAL — every clip MUST be a COMPLETE, self-contained unit:
- A full JOKE: include the ENTIRE setup AND the punchline. Never cut before the punchline; never start mid-setup.
- A full STORY / anecdote: from its opening to its resolution.
- A complete TEACHING / point: the whole idea, not a fragment.
- It must make sense on its own to someone who hasn't seen the rest of the video.
- NEVER start or end mid-sentence or mid-thought, and NEVER take only "half from the beginning" or "half from the end" of a unit.

Length: aim for {min_sec}-{max_sec} seconds. But COMPLETENESS WINS over length — if a joke or story needs longer to stay whole, you MAY extend a clip up to {flex_cap} seconds. Do not pad; cut exactly at the natural start and end of the unit.

For each clip return: start_seconds and end_seconds (integers, at the natural boundaries of the complete unit), a short title, the hook (first sentence verbatim), the closing_line (last sentence verbatim), a one-sentence core_teaching, and a viral_score 0-100."""


def find_clips_gemini_text(words, segments, *, num_clips, min_sec, max_sec,
                           duration, api_key, model, settings, auto=False,
                           on_log=print):
    """Text-only Gemini clip selection. Sends the whole transcript, asks for
    complete self-contained units (jokes/stories/teachings), snaps to sentence
    boundaries, and allows clips to flex up to 1.5x max to keep a unit whole.
    Raises on any failure so the caller can fall back."""
    transcript = _timestamped_text(words, segments)
    if not transcript:
        raise RuntimeError("no transcript for Gemini text selection")
    flex_cap = int(max_sec * 1.5)
    ctx = {
        "speaker": settings.get("speaker", DEFAULT_SPEAKER),
        "channel": settings.get("channel", DEFAULT_CHANNEL),
    }
    client = genai.Client(api_key=api_key)
    resp = client.models.generate_content(
        model=model,
        contents=[
            transcript
            + "\n\n"
            + _text_prompt(num_clips, min_sec, max_sec, flex_cap, duration, ctx,
                           auto=auto)
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=CLIP_SCHEMA,
            temperature=0.6,
        ),
    )
    clips = (json.loads(resp.text) or {}).get("clips", [])
    if not clips:
        raise RuntimeError("Gemini text returned no clips")

    # Snap to sentence boundaries; enforce the min floor but allow the flex cap
    # as the ceiling so complete jokes/stories aren't truncated back to max.
    units = build_sentences(words) if words else (segments or [])
    bounds = _parse_boundaries(units)
    if bounds:
        clips = _snap(clips, bounds, min_sec, flex_cap)
        clips = enforce_duration(clips, min_sec, flex_cap)
    clips = _dedup(clips)[:num_clips]
    for i, c in enumerate(clips, 1):
        c["rank"] = i
    log("SHORTS", f"Gemini text ({model}) selected {len(clips)} clips")
    return clips


def select_clips_gemini_text(words, segments, *, num_clips, min_sec, max_sec,
                             duration, api_key, settings, auto=False,
                             on_log=print):
    """Cascade: gemini-2.5-pro → gemini-2.5-flash. Raises if both fail."""
    err = None
    for m in SELECT_MODELS:
        try:
            on_log(f"Gemini text selection ({m}) …")
            clips = find_clips_gemini_text(
                words, segments, num_clips=num_clips, min_sec=min_sec,
                max_sec=max_sec, duration=duration, api_key=api_key, model=m,
                settings=settings, auto=auto, on_log=on_log,
            )
            if clips:
                return clips
        except Exception as e:  # noqa: BLE001
            err = e
            on_log(f"Gemini {m} failed: {str(e)[:100]}")
    raise err or RuntimeError("Gemini text selection failed")
