"""Phase 0 dubbing pipeline.

A trimmed version of the desktop app's ``run_dub_pipeline`` (see autodubber
``app.py``) covering the core dub path only:

    download → transcribe (Deepgram) → merge → translate → TTS → build → output.mp4

Deliberately excluded for the spike: Demucs BGM separation (GPU-heavy), dub
verification (re-transcription QA), vision extraction, caption generation, and
publishing — those belong to later phases / the PeerPost side.

The pipeline imports the dubber submodules directly (not ``dubber/__init__``)
so it never pulls optional publishing deps (zernio, gspread, demucs).
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from typing import Callable, Optional

from dubber.downloader import download_video, is_url
from dubber.segment_merger import merge_short_segments
from dubber.translator import translate_segments
from dubber.tts_generator import generate_tts_audio
from dubber.video_builder import build_dubbed_video
from dubber.utils import log

from app.transcribe_deepgram import transcribe_audio_deepgram

# Stage weights mirror the desktop app's progress model (minus the excluded
# stages, renormalised) so the bar advances proportionally to real work.
STAGE_WEIGHTS = {
    "download": 0.10,
    "transcribe": 0.28,
    "merge": 0.04,
    "translate": 0.18,
    "tts": 0.14,
    "build": 0.18,
    "captions": 0.08,
}
_ORDER = list(STAGE_WEIGHTS.keys())


@dataclass
class DubRequest:
    video_input: str          # URL or local file path
    target_lang: str          # e.g. "gu"
    voice: str                # Edge-TTS voice, e.g. "gu-IN-NiranjanNeural"
    deepgram_key: str
    gemini_key: str = ""      # translation + vision/content extraction
    nvidia_key: str = ""      # caption generation (NVIDIA NIM; falls back if empty)
    nvidia_url: str = "https://integrate.api.nvidia.com/v1/chat/completions"
    platforms: Optional[list] = None  # caption target platforms (None = all)
    source_lang: str = "auto"
    workspace: str = "workspace"
    output_path: str = "output.mp4"
    source_type: str = "url"          # "url" (extractor) | "upload" (direct fetch)
    cookies_file: Optional[str] = None  # per-job yt-dlp cookies (login/rate-limit)
    burn_captions: bool = False       # burn translated subtitles into the video


@dataclass
class DubResult:
    output_path: str
    captions: dict            # { platform: {caption, title?}, ... }


@dataclass
class StageEvent:
    stage: str
    pct: int
    message: str
    meta: dict = field(default_factory=dict)


ProgressCb = Callable[[StageEvent], None]


def _cumulative(stage: str) -> float:
    total = 0.0
    for name in _ORDER:
        if name == stage:
            return total
        total += STAGE_WEIGHTS[name]
    return total


def _pct(stage: str, fraction: float = 1.0) -> int:
    base = _cumulative(stage)
    weight = STAGE_WEIGHTS.get(stage, 0.0)
    total = sum(STAGE_WEIGHTS.values())
    frac = max(0.0, min(1.0, fraction))
    return max(0, min(100, round(((base + weight * frac) / total) * 100)))


def run_dub(req: DubRequest, on_progress: Optional[ProgressCb] = None) -> "DubResult":
    """Run the dub pipeline, returning the finished video path and captions.

    ``on_progress`` is invoked with a :class:`StageEvent` after each stage; the
    service layer relays these to the browser over SSE.
    """

    def emit(stage: str, message: str, fraction: float = 1.0, **meta):
        log("PIPELINE", f"[{stage}] {message}")
        if on_progress:
            on_progress(StageEvent(stage, _pct(stage, fraction), message, meta))

    # Fresh workspace per run.
    shutil.rmtree(req.workspace, ignore_errors=True)
    os.makedirs(req.workspace, exist_ok=True)

    # Translator reads the Gemini key from the environment (see dubber/config).
    if req.gemini_key:
        os.environ["GEMINI_API_KEY"] = req.gemini_key

    # 1) Source
    if is_url(req.video_input):
        emit("download", "Downloading video ...", 0.1)
        result = download_video(
            req.video_input,
            req.workspace,
            source_type=req.source_type,
            cookies_file=req.cookies_file,
        )
        video_path = (
            result.get("video_path", "") if isinstance(result, dict) else result
        )
    else:
        video_path = req.video_input
    if not video_path or not os.path.exists(video_path):
        raise FileNotFoundError(f"Source video not found: {video_path}")
    emit("download", "Source ready.")

    # 2) Transcribe (Deepgram — replaces self-hosted Whisper)
    emit("transcribe", "Transcribing with Deepgram ...", 0.1)
    segments = transcribe_audio_deepgram(
        video_path,
        req.workspace,
        api_key=req.deepgram_key,
        language=req.source_lang,
    )
    emit("transcribe", f"Transcribed {len(segments)} segments.")

    # 3) Merge short segments (heuristic cleanup, unchanged from desktop)
    emit("merge", "Merging short segments ...", 0.2)
    segments = merge_short_segments(segments)
    emit("merge", f"{len(segments)} segments after merge.")

    # 4) Translate
    emit("translate", f"Translating → {req.target_lang} ...", 0.1)
    segments = translate_segments(segments, req.target_lang, req.workspace)
    emit("translate", "Translation complete.")

    # 5) TTS (Edge-TTS — free, CPU/light). generate_tts_audio returns a NEW list
    # of segments enriched with `audio_path` (the synthesized clip per segment);
    # it does not mutate in place, so the return value MUST be captured or the
    # builder sees no audio and produces a silent video.
    emit("tts", "Synthesising dubbed audio ...", 0.1)
    segments = generate_tts_audio(segments, voice=req.voice, output_dir=req.workspace)
    emit("tts", "Voice synthesis complete.")

    # 6) Build the dubbed video (FFmpeg). BGM disabled in the spike.
    emit("build", "Building dubbed video ...", 0.1)
    build_dubbed_video(
        video_path,
        segments,
        req.output_path,
        bgm_path=None,
        output_dir=req.workspace,
        burn_captions=req.burn_captions,
        caption_lang=req.target_lang,
    )
    if not os.path.exists(req.output_path):
        raise RuntimeError("Build finished but output file is missing.")
    emit("build", "Dubbed video ready.", 1.0, output_path=req.output_path)

    # 7) AI captions. Non-fatal: the dubbed video is the primary deliverable, so
    # a caption-API hiccup must not fail the whole job — we just return {}.
    emit("captions", "Generating captions ...", 0.1)
    captions = _generate_captions(req, segments, emit)
    emit("captions", "Done.", 1.0, output_path=req.output_path)

    return DubResult(output_path=req.output_path, captions=captions)


def _generate_captions(req: DubRequest, segments, emit) -> dict:
    """Vision/content extraction (Gemini) → per-platform captions (NVIDIA NIM).

    Both steps reuse the autodubber modules and run on the translated
    transcript (no video frames needed). Any failure degrades to no captions.
    """
    try:
        from dubber.vision_extractor import extract_vision
        from dubber.caption_generator import generate_all_captions

        vision = extract_vision(
            segments,
            req.gemini_key,
            output_dir=req.workspace,
            target_language=req.target_lang,
        )
        captions = generate_all_captions(
            vision,
            api_key=req.nvidia_key or None,
            api_url=req.nvidia_url or None,
            output_dir=req.workspace,
            segments=segments,
            target_language=req.target_lang,
            selected_platforms=req.platforms or None,
        )
        # Normalise to plain {platform: {caption, title?}} JSON.
        return {
            str(p): {
                k: v
                for k, v in (data or {}).items()
                if k in ("caption", "title") and isinstance(v, str)
            }
            for p, data in (captions or {}).items()
        }
    except Exception as exc:  # non-fatal
        log("PIPELINE", f"caption generation failed: {exc}")
        return {}
