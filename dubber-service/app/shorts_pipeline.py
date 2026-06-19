"""
Shorts pipeline: one long video → many short clips.

download → transcribe (Deepgram, word-level) → clip-find (Gemini visual, with
NIM/text fallback) → per clip: single-pass crop+overlay+captions → append
transition + end-card → upload to R2 → AI title/description.

Per-clip rendering runs in parallel, and crop+overlay+captions are done in ONE
ffmpeg pass (instead of three) — the two render-speed fixes. Captions and the
transition/overlay/end-card assets are optional.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
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
from dubber.shorts_captions import make_ass_file
from dubber.shorts_render import concat_with, download_url, normalize_asset, scale_png
from dubber.utils import log

# Parallel render: a few workers, each ffmpeg capped to a couple of threads, so
# we use the cores without oversubscribing an 8-core box.
_MAX_WORKERS = max(2, min(4, (os.cpu_count() or 4) // 2))
_FFMPEG_THREADS = 2


@dataclass
class ShortsRequest:
    video_input: str
    deepgram_key: str
    nvidia_key: str
    nvidia_url: str = "https://integrate.api.nvidia.com/v1/chat/completions"
    clip_model: str = DEFAULT_CLIP_MODEL
    title_model: str = DEFAULT_TITLE_MODEL
    # Visual selection (optional; falls back to NIM text selection).
    selector: str = "gemini"          # "gemini" | "nim"
    gemini_key: Optional[str] = None
    gemini_model: str = "gemini-2.5-flash"
    media_resolution: str = "low"
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


def _render_single_pass(video, start, end, crop, overlay_png, ass_path, out) -> bool:
    """Extract [start,end], crop to aspect, overlay PNG, and burn captions — all
    in ONE ffmpeg invocation (vs three separate re-encodes)."""
    args = ["ffmpeg", "-y", "-ss", str(start), "-t", str(end - start), "-i", video]
    if overlay_png:
        args += ["-i", overlay_png]
    chain = f"[0:v]{crop}[c]"
    last = "c"
    if overlay_png:
        chain += f";[{last}][1:v]overlay=0:0:format=auto[o]"
        last = "o"
    if ass_path:
        chain += f";[{last}]ass={ass_path}[v]"
    else:
        chain += f";[{last}]null[v]"
    args += [
        "-filter_complex", chain, "-map", "[v]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-threads", str(_FFMPEG_THREADS),
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
    ]
    subprocess.run(args, capture_output=True)
    return os.path.exists(out) and os.path.getsize(out) > 10000


def _select_clips(req, video_path, segments, words, duration, emit):
    """Gemini visual selection with automatic fallback to NIM text selection."""
    if req.selector == "gemini" and req.gemini_key:
        try:
            from dubber.shorts_gemini import find_clips_gemini

            emit("analyze", 35, "Finding clips (Gemini visual) ...")
            return find_clips_gemini(
                video_path, words, num_clips=req.num_clips,
                min_sec=req.min_seconds, max_sec=req.max_seconds,
                duration=duration, api_key=req.gemini_key, model=req.gemini_model,
                media_resolution=req.media_resolution, settings=req.settings,
                on_log=lambda m: emit("analyze", 40, m),
            )
        except Exception as e:  # noqa: BLE001
            emit("analyze", 38, f"Gemini selection failed ({str(e)[:80]}); using text model")
    emit("analyze", 42, "Finding clips (text model) ...")
    return find_clips(
        segments, words=words, num_clips=req.num_clips, min_sec=req.min_seconds,
        max_sec=req.max_seconds, duration=duration, api_url=req.nvidia_url,
        api_key=req.nvidia_key, model=req.clip_model, settings=req.settings,
        on_log=lambda m: emit("analyze", 44, m),
    )


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

    # 2) Transcribe (word-level)
    emit("transcribe", 18, "Transcribing (Deepgram) ...")
    segments, words = transcribe_with_words(
        video_path, req.workspace, api_key=req.deepgram_key, language=req.language,
    )
    emit("transcribe", 30, f"{len(segments)} segments, {len(words)} words")

    # 3) Clip selection (Gemini visual → NIM fallback)
    clips = _select_clips(req, video_path, segments, words, duration, emit)
    if not clips:
        raise RuntimeError("No clips found.")
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

    # 4) Per clip: single-pass render → append assets → upload. Run in parallel.
    clips_dir = os.path.join(req.workspace, "clips")
    os.makedirs(clips_dir, exist_ok=True)

    def render_one(item):
        i, c = item
        start, end = c.get("start_seconds", 0), c.get("end_seconds", 0)
        base = os.path.join(clips_dir, f"{req.job_id}_{i}")
        ass_path = None
        if req.captions and words:
            ass_path = f"{base}.ass"
            if not make_ass_file(words, start, end, rx, ry, req.settings, ass_path):
                ass_path = None
        cur = f"{base}_a.mp4"
        if not _render_single_pass(video_path, start, end, vf, overlay_png, ass_path, cur):
            log("SHORTS", f"clip {i} render failed, skipping")
            return None
        if extras:
            joined = f"{base}_final.mp4"
            if concat_with(cur, extras, joined, rx, ry):
                cur = joined
        up = upload_clip(cur, f"shorts/{req.job_id}/{i}.mp4")
        return {
            "idx": i, "title": c.get("title", f"Clip {i}"),
            "core_teaching": c.get("core_teaching", ""), "hook": c.get("hook", ""),
            "closing_line": c.get("closing_line", ""),
            "caption_text": c.get("caption_text", ""),
            "start_seconds": start, "end_seconds": end, "duration": end - start,
            "viral_score": c.get("viral_score"),
            "r2_key": up["key"], "public_url": up["publicUrl"],
        }

    emit("render", 55, f"Rendering {len(clips)} clips ({_MAX_WORKERS} parallel) ...")
    rendered = 0
    out_map: dict[int, dict] = {}
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as ex:
        for res in ex.map(render_one, list(enumerate(clips, 1))):
            rendered += 1
            emit("render", 55 + int(30 * rendered / len(clips)),
                 f"Rendered {rendered}/{len(clips)}")
            if res:
                out_map[res["idx"]] = res
    out_clips = [out_map[i] for i in sorted(out_map)]
    if not out_clips:
        raise RuntimeError("All clip renders failed.")

    # 5) Titles & descriptions (NIM text)
    emit("titles", 88, "Generating titles & descriptions ...")
    generate_titles(
        out_clips, segments, api_url=req.nvidia_url, api_key=req.nvidia_key,
        model=req.title_model, settings=req.settings,
        on_log=lambda m: emit("titles", 92, m),
    )

    emit("done", 100, f"{len(out_clips)} clips ready", count=len(out_clips))
    return ShortsResult(clips=out_clips)
