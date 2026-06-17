"""
Shorts pipeline: one long video → many short clips.

download → transcribe (Deepgram, word-level) → AI clip-find (sentence-accurate
boundaries) → per clip: extract → burn captions → overlay → append transition +
end-card → upload to R2 → AI title/description.

Captions and the transition/overlay/end-card assets are optional and applied
only when available. Reuses the dub pipeline's downloader + Deepgram transcriber.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Callable, Optional

from app.pipeline import StageEvent
from app.transcribe_deepgram import transcribe_with_words
from dubber.downloader import download_video, is_url
from dubber.r2_upload import upload_clip
from dubber.shorts_ai import (
    DEFAULT_CLIP_MODEL,
    DEFAULT_TITLE_MODEL,
    find_clips,
    generate_titles,
)
from dubber.shorts_captions import burn_captions
from dubber.shorts_render import (
    apply_overlay,
    concat_with,
    download_url,
    normalize_asset,
    scale_png,
)
from dubber.utils import log


@dataclass
class ShortsRequest:
    video_input: str
    deepgram_key: str
    nvidia_key: str
    nvidia_url: str = "https://integrate.api.nvidia.com/v1/chat/completions"
    clip_model: str = DEFAULT_CLIP_MODEL
    title_model: str = DEFAULT_TITLE_MODEL
    num_clips: int = 15
    min_seconds: int = 90
    max_seconds: int = 120
    aspect: str = "9:16"
    language: str = "en"
    source_type: str = "url"
    cookies_file: Optional[str] = None
    captions: bool = True
    overlay_url: Optional[str] = None
    transition_url: Optional[str] = None
    endcard_url: Optional[str] = None
    settings: dict = field(default_factory=dict)
    workspace: str = "workspace"
    job_id: str = "job"


@dataclass
class ShortsResult:
    clips: list


ProgressCb = Callable[[StageEvent], None]


def _dims(aspect: str) -> tuple[str, int, int]:
    if aspect == "1:1":
        return "crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080", 1080, 1080
    if aspect == "16:9":
        return ("scale=1920:1080:force_original_aspect_ratio=decrease,"
                "pad=1920:1080:-1:-1"), 1920, 1080
    return "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920", 1080, 1920


def _probe_duration(path: str) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def _extract_clip(src, start, end, vf, out_path) -> bool:
    subprocess.run(
        ["ffmpeg", "-y", "-ss", str(start), "-i", src, "-t", str(end - start),
         "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
         "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out_path],
        capture_output=True,
    )
    return os.path.exists(out_path) and os.path.getsize(out_path) > 10000


def run_shorts(req: ShortsRequest, on_progress: Optional[ProgressCb] = None) -> ShortsResult:
    def emit(stage, pct, message, **meta):
        if on_progress:
            on_progress(StageEvent(stage=stage, pct=pct, message=message, meta=meta))
        log("SHORTS", f"[{stage}] {message}")

    shutil.rmtree(req.workspace, ignore_errors=True)
    os.makedirs(req.workspace, exist_ok=True)
    vf, rx, ry = _dims(req.aspect)

    # 1) Source
    emit("download", 5, "Downloading video ...")
    if is_url(req.video_input):
        result = download_video(req.video_input, req.workspace,
                                source_type=req.source_type,
                                cookies_file=req.cookies_file)
        video_path = result.get("video_path", "") if isinstance(result, dict) else result
    else:
        video_path = req.video_input
    duration = _probe_duration(video_path)
    emit("download", 12, f"Source ready ({int(duration)}s)")

    # 2) Transcribe (word-level for sentence-accurate cuts + caption timing)
    emit("transcribe", 18, "Transcribing (Deepgram) ...")
    segments, words = transcribe_with_words(
        video_path, req.workspace, api_key=req.deepgram_key, language=req.language,
    )
    emit("transcribe", 30, f"{len(segments)} segments, {len(words)} words")

    # 3) AI clip-find (sentence boundaries from words)
    emit("analyze", 35, "Finding clips (NVIDIA NIM) ...")
    clips = find_clips(
        segments, words=words, num_clips=req.num_clips, min_sec=req.min_seconds,
        max_sec=req.max_seconds, duration=duration, api_url=req.nvidia_url,
        api_key=req.nvidia_key, model=req.clip_model, settings=req.settings,
        on_log=lambda m: emit("analyze", 40, m),
    )
    if not clips:
        raise RuntimeError("No clips found — the model returned nothing usable.")
    emit("analyze", 50, f"{len(clips)} clips selected")

    # 3b) Prepare optional assets once
    assets_dir = os.path.join(req.workspace, "assets")
    os.makedirs(assets_dir, exist_ok=True)
    overlay_png = transition_n = endcard_n = None
    if req.overlay_url:
        raw = download_url(req.overlay_url, os.path.join(assets_dir, "overlay.png"))
        overlay_png = scale_png(raw, os.path.join(assets_dir, "overlay_s.png"), rx, ry) if raw else None
    if req.transition_url:
        raw = download_url(req.transition_url, os.path.join(assets_dir, "trans.mp4"))
        transition_n = normalize_asset(raw, os.path.join(assets_dir, "trans_n.mp4"), rx, ry) if raw else None
    if req.endcard_url:
        raw = download_url(req.endcard_url, os.path.join(assets_dir, "end.mp4"))
        endcard_n = normalize_asset(raw, os.path.join(assets_dir, "end_n.mp4"), rx, ry) if raw else None
    extras = [p for p in (transition_n, endcard_n) if p]

    # 4) Per clip: extract → captions → overlay → transition/end-card → upload
    clips_dir = os.path.join(req.workspace, "clips")
    os.makedirs(clips_dir, exist_ok=True)
    out_clips = []
    for i, c in enumerate(clips, 1):
        start, end = c.get("start_seconds", 0), c.get("end_seconds", 0)
        frac = i / max(len(clips), 1)
        emit("render", 50 + int(30 * frac), f"Rendering clip {i}/{len(clips)} ...")
        cur = os.path.join(clips_dir, f"{req.job_id}_{i}_0.mp4")
        if not _extract_clip(video_path, start, end, vf, cur):
            log("SHORTS", f"clip {i} extraction failed, skipping")
            continue

        if req.captions and words:
            capped = os.path.join(clips_dir, f"{req.job_id}_{i}_cap.mp4")
            if burn_captions(cur, words, start, end, capped, rx, ry, req.settings):
                cur = capped
        if overlay_png:
            ov = os.path.join(clips_dir, f"{req.job_id}_{i}_ov.mp4")
            if apply_overlay(cur, overlay_png, ov):
                cur = ov
        if extras:
            joined = os.path.join(clips_dir, f"{req.job_id}_{i}_final.mp4")
            if concat_with(cur, extras, joined, rx, ry):
                cur = joined

        key = f"shorts/{req.job_id}/{i}.mp4"
        up = upload_clip(cur, key)
        out_clips.append({
            "idx": i,
            "title": c.get("title", f"Clip {i}"),
            "core_teaching": c.get("core_teaching", ""),
            "hook": c.get("hook", ""),
            "closing_line": c.get("closing_line", ""),
            "caption_text": c.get("caption_text", ""),
            "start_seconds": start,
            "end_seconds": end,
            "duration": end - start,
            "viral_score": c.get("viral_score"),
            "r2_key": up["key"],
            "public_url": up["publicUrl"],
        })

    if not out_clips:
        raise RuntimeError("All clip extractions failed.")

    # 5) Titles & descriptions
    emit("titles", 88, "Generating titles & descriptions ...")
    generate_titles(
        out_clips, segments, api_url=req.nvidia_url, api_key=req.nvidia_key,
        model=req.title_model, settings=req.settings,
        on_log=lambda m: emit("titles", 92, m),
    )

    emit("done", 100, f"{len(out_clips)} clips ready", count=len(out_clips))
    return ShortsResult(clips=out_clips)
