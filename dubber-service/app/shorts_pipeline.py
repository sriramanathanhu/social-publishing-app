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
    build_sentences,
    find_clips,
    generate_titles,
    judge_clips,
)
from dubber.shorts_captions import make_ass_file
from dubber.shorts_reframe import (
    auto_crop_filter,
    compute_reference_embedding,
    models_available,
)
from dubber.shorts_render import concat_with, download_url, normalize_asset, scale_png
from dubber.utils import log

# Parallel render: a few workers, each ffmpeg capped to a couple of threads, so
# we use the cores without oversubscribing an 8-core box.
# Parallel clip renders per shorts job. Default 2 (was up to 4): on a shared
# box, 4 parallel x264 encodes saturate every core. Tunable via env.
_MAX_WORKERS = max(1, int(os.getenv("SHORTS_MAX_WORKERS", "2")))
# Threads per ffmpeg encode, so a single render can't grab all cores.
_FFMPEG_THREADS = max(1, int(os.getenv("FFMPEG_THREADS", "2")))


@dataclass
class ShortsRequest:
    video_input: str
    deepgram_key: str
    nvidia_key: str
    nvidia_url: str = "https://integrate.api.nvidia.com/v1/chat/completions"
    clip_model: str = DEFAULT_CLIP_MODEL
    title_model: str = DEFAULT_TITLE_MODEL
    # Visual selection (optional; falls back to NIM text selection).
    selector: str = "nim"             # "nim" (text, default) | "gemini" (visual)
    gemini_key: Optional[str] = None
    gemini_model: str = "gemini-2.5-flash"
    media_resolution: str = "low"
    judge: bool = True                # score + standalone-comprehension filter
    num_clips: int = 3
    min_seconds: int = 90
    max_seconds: int = 120
    aspect: str = "9:16"
    crop_focus: str = "auto"          # auto (face) | center | left | right
    speed: float = 1.0                # playback speed of the final clip (e.g. 1.4)
    language: str = "en"
    source_type: str = "url"
    cookies_file: Optional[str] = None
    captions: bool = True
    overlay_url: Optional[str] = None
    transition_url: Optional[str] = None
    endcard_url: Optional[str] = None
    # Optional reference-face image URL. When set (with crop_focus="auto"), the
    # reframer tracks the person matching this face instead of the largest face.
    reference_face_url: Optional[str] = None
    settings: dict = field(default_factory=dict)
    workspace: str = "workspace"
    job_id: str = "job"


@dataclass
class ShortsResult:
    clips: list


ProgressCb = Callable[[StageEvent], None]


def _x_offset(width_expr: str, focus: str) -> str:
    """Horizontal crop offset for the focus: left edge, right edge, or centered."""
    if focus == "left":
        return "0"
    if focus == "right":
        return f"iw-{width_expr}"
    return f"(iw-{width_expr})/2"


def _dims(aspect: str, focus: str = "center") -> tuple[str, int, int]:
    if aspect == "1:1":
        s = "min(iw\\,ih)"
        x = _x_offset(s, focus)
        return f"crop={s}:{s}:{x}:0,scale=1080:1080", 1080, 1080
    if aspect == "16:9":
        # Letterboxed — no horizontal crop, so focus doesn't apply.
        return ("scale=1920:1080:force_original_aspect_ratio=decrease,"
                "pad=1920:1080:-1:-1"), 1920, 1080
    w = "ih*9/16"
    x = _x_offset(w, focus)
    return f"crop={w}:ih:{x}:0,scale=1080:1920", 1080, 1920


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


def _probe_dims(path: str) -> tuple[int, int]:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path],
        capture_output=True, text=True,
    )
    try:
        w, h = r.stdout.strip().split("x")
        return int(w), int(h)
    except ValueError:
        return 0, 0


def _atempo(speed: float) -> str:
    """ffmpeg atempo chain (each stage valid 0.5–2.0) for an arbitrary factor."""
    parts, r = [], speed
    while r > 2.0:
        parts.append("atempo=2.0")
        r /= 2.0
    while r < 0.5:
        parts.append("atempo=0.5")
        r /= 0.5
    parts.append(f"atempo={r:.4f}")
    return ",".join(parts)


def _render_single_pass(video, start, end, crop, overlay_png, ass_path, out,
                        speed=1.0) -> bool:
    """Extract [start,end], crop to aspect, overlay PNG, burn captions, and apply
    the speed factor — all in ONE ffmpeg pass. setpts retimes the (already
    caption-burned) frames and atempo speeds the audio by the same factor, so
    they stay in sync."""
    args = ["ffmpeg", "-y", "-ss", str(start), "-t", str(end - start), "-i", video]
    if overlay_png:
        args += ["-i", overlay_png]
    parts = [f"[0:v]{crop}[s0]"]
    last = "s0"
    if overlay_png:
        parts.append(f"[{last}][1:v]overlay=0:0:format=auto[s1]")
        last = "s1"
    if ass_path:
        parts.append(f"[{last}]ass={ass_path}[s2]")
        last = "s2"
    sped = speed and abs(speed - 1.0) > 0.01
    if sped:
        parts.append(f"[{last}]setpts=PTS/{speed:.4f}[v]")
        parts.append(f"[0:a]{_atempo(speed)}[a]")
        vmap, amap = "[v]", "[a]"
    else:
        parts.append(f"[{last}]null[v]")
        vmap, amap = "[v]", "0:a?"
    args += [
        "-filter_complex", ";".join(parts), "-map", vmap, "-map", amap,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-threads", str(_FFMPEG_THREADS),
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
    ]
    subprocess.run(args, capture_output=True)
    return os.path.exists(out) and os.path.getsize(out) > 10000


def _even_clips(duration, num_clips, min_sec, max_sec):
    """Transcript-free fallback (e.g. a song / music video with no speech):
    evenly-spaced clips of a target length across the whole timeline."""
    length = max(float(min_sec), min(float(max_sec),
                                     (float(min_sec) + float(max_sec)) / 2))
    if duration <= length:
        return [{"start_seconds": 0.0, "end_seconds": round(float(duration), 2),
                 "title": "Clip 1", "rank": 1}]
    n = max(1, int(num_clips))
    step = (duration - length) / (n - 1) if n > 1 else 0.0
    clips = []
    for i in range(n):
        start = round(i * step, 2)
        end = round(min(float(duration), start + length), 2)
        clips.append({"start_seconds": start, "end_seconds": end,
                      "title": f"Clip {i + 1}", "rank": i + 1})
    return clips


def _find_candidates(req, video_path, segments, words, duration, candidate_n, emit):
    """Get candidate clips: Gemini visual (if chosen + keyed) → NIM text (needs a
    transcript) → evenly-spaced (no transcript, e.g. a song). Asks for a few
    extra so the judge can filter down."""
    if req.selector == "gemini" and req.gemini_key:
        try:
            from dubber.shorts_gemini import find_clips_gemini

            emit("analyze", 35, "Finding clips (Gemini visual) ...")
            clips = find_clips_gemini(
                video_path, words, num_clips=candidate_n,
                min_sec=req.min_seconds, max_sec=req.max_seconds,
                duration=duration, api_key=req.gemini_key, model=req.gemini_model,
                media_resolution=req.media_resolution, settings=req.settings,
                segments=segments,
                on_log=lambda m: emit("analyze", 40, m),
            )
            if clips:
                return clips
        except Exception as e:  # noqa: BLE001
            emit("analyze", 38, f"Gemini failed ({str(e)[:80]}); using fallback")
    # The text model needs a transcript; a song has none.
    # Text selection (needs a transcript; a song has none). Prefer Gemini TEXT
    # (whole transcript → complete jokes/stories), then fall back to NVIDIA NIM.
    if segments:
        if req.gemini_key:
            try:
                from dubber.shorts_gemini import select_clips_gemini_text

                emit("analyze", 35, "Finding clips (Gemini text) ...")
                clips = select_clips_gemini_text(
                    words, segments, num_clips=candidate_n,
                    min_sec=req.min_seconds, max_sec=req.max_seconds,
                    duration=duration, api_key=req.gemini_key,
                    settings=req.settings,
                    on_log=lambda m: emit("analyze", 40, m),
                )
                if clips:
                    return clips
            except Exception as e:  # noqa: BLE001
                emit("analyze", 41,
                     f"Gemini text failed ({str(e)[:60]}); trying NVIDIA")
        if req.nvidia_key:
            emit("analyze", 42, "Finding clips (NVIDIA text) ...")
            clips = find_clips(
                segments, words=words, num_clips=candidate_n,
                min_sec=req.min_seconds, max_sec=req.max_seconds,
                duration=duration, api_url=req.nvidia_url,
                api_key=req.nvidia_key, model=req.clip_model,
                settings=req.settings,
                on_log=lambda m: emit("analyze", 44, m),
            )
            if clips:
                return clips
    emit("analyze", 44, "No speech transcript — selecting evenly-spaced clips")
    return _even_clips(duration, candidate_n, req.min_seconds, req.max_seconds)


def _select_clips(req, video_path, segments, words, duration, emit):
    """Find candidates, then (optionally) judge them on a standalone/hook/
    completeness rubric and keep the best num_clips. Judging needs a transcript,
    so it's skipped for speechless sources."""
    # The judge runs on the NIM model, so it needs an NVIDIA key. With Gemini
    # selection (which already ranks), it's fine to skip it.
    use_judge = req.judge and bool(segments) and bool(req.nvidia_key)
    candidate_n = req.num_clips + 5 if use_judge else req.num_clips
    clips = _find_candidates(req, video_path, segments, words, duration,
                             candidate_n, emit)
    if not clips:
        return []
    if use_judge:
        emit("analyze", 47, "Scoring & filtering clips ...")
        units = build_sentences(words) if words else segments
        clips = judge_clips(
            clips, units, api_url=req.nvidia_url, api_key=req.nvidia_key,
            model=req.title_model, num_keep=req.num_clips,
            on_log=lambda m: emit("analyze", 48, m),
        )
    return clips[:req.num_clips]


def run_shorts(req: ShortsRequest, on_progress: Optional[ProgressCb] = None) -> ShortsResult:
    def emit(stage, pct, message, **meta):
        if on_progress:
            on_progress(StageEvent(stage=stage, pct=pct, message=message, meta=meta))
        log("SHORTS", f"[{stage}] {message}")

    shutil.rmtree(req.workspace, ignore_errors=True)
    os.makedirs(req.workspace, exist_ok=True)
    vf, rx, ry = _dims(req.aspect, req.crop_focus)

    # 0) Reference face: validate + embed UP FRONT, before the expensive source
    # download / transcription / clip-selection, so a missing model, undownloadable
    # URL, or faceless photo fails fast instead of after billed AI work. The user
    # explicitly asked to track this person, so any failure to lock is fatal.
    # Computed once and reused for every clip's reframing.
    ref_feat = None
    if req.crop_focus == "auto" and req.reference_face_url:
        if not models_available():
            raise RuntimeError(
                "Face re-identification is unavailable — detector models are "
                "missing from this build."
            )
        raw_ref = download_url(
            req.reference_face_url,
            os.path.join(req.workspace, "reference_face.jpg"),
        )
        if not raw_ref:
            raise RuntimeError("Could not download the reference face image.")
        ref_feat = compute_reference_embedding(raw_ref)
        if ref_feat is None:
            raise RuntimeError(
                "No face detected in the reference image — please upload a clear, "
                "front-facing photo of the person to track."
            )
        emit("download", 3, "Reference face locked — tracking this person")

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
    src_w, src_h = _probe_dims(video_path)
    emit("download", 12, f"Source ready ({int(duration)}s, {src_w}x{src_h})")

    # 2) Transcribe (word-level). A song / music video may have no transcribable
    # speech — that's fine; we fall back to visual or evenly-spaced selection and
    # skip captions, rather than failing the whole job.
    emit("transcribe", 18, "Transcribing (Deepgram) ...")
    try:
        segments, words = transcribe_with_words(
            video_path, req.workspace, api_key=req.deepgram_key,
            language=req.language,
        )
        emit("transcribe", 30, f"{len(segments)} segments, {len(words)} words")
    except RuntimeError as e:
        if "no transcribable speech" in str(e).lower():
            segments, words = [], []
            emit("transcribe", 30,
                 "No speech detected — selecting clips by video / timing")
        else:
            raise

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
        # Auto reframing: centre the crop on the speaker's face for this clip;
        # fall back to the fixed (center/left/right) crop if no face is found.
        clip_vf = vf
        if req.crop_focus == "auto" and src_w and src_h:
            auto = auto_crop_filter(video_path, start, end, clips_dir,
                                    req.aspect, src_w, src_h, rx, ry,
                                    ref_feat=ref_feat)
            if auto:
                clip_vf = auto
        ass_path = None
        if req.captions and words:
            ass_path = f"{base}.ass"
            if not make_ass_file(words, start, end, rx, ry, req.settings, ass_path):
                ass_path = None
        cur = f"{base}_a.mp4"
        if not _render_single_pass(video_path, start, end, clip_vf, overlay_png,
                                   ass_path, cur, speed=req.speed):
            log("SHORTS", f"clip {i} render failed, skipping")
            return None
        if extras:
            joined = f"{base}_final.mp4"
            if concat_with(cur, extras, joined, rx, ry):
                cur = joined
        up = upload_clip(cur, f"shorts/{req.job_id}/{i}.mp4")
        sp = req.speed if req.speed and req.speed > 0 else 1.0
        return {
            "idx": i, "title": c.get("title", f"Clip {i}"),
            "core_teaching": c.get("core_teaching", ""), "hook": c.get("hook", ""),
            "closing_line": c.get("closing_line", ""),
            "caption_text": c.get("caption_text", ""),
            "start_seconds": start, "end_seconds": end,
            "duration": int(round((end - start) / sp)),
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

    # 5) Titles & descriptions (NIM text) — only with a transcript. For a
    # speechless source there's nothing to title from, so name clips after the
    # source video and let the user edit them in the publish table.
    if segments:
        emit("titles", 88, "Generating titles & descriptions ...")
        generate_titles(
            out_clips, segments, api_url=req.nvidia_url, api_key=req.nvidia_key,
            model=req.title_model, settings=req.settings,
            gemini_key=req.gemini_key,
            on_log=lambda m: emit("titles", 92, m),
        )
    else:
        emit("titles", 92, "No transcript — naming clips after the source")
        base = (req.settings.get("video_title") or "").strip()
        for c in out_clips:
            c["title"] = f"{base} — Part {c['idx']}" if base else f"Clip {c['idx']}"

    emit("done", 100, f"{len(out_clips)} clips ready", count=len(out_clips))
    return ShortsResult(clips=out_clips)
