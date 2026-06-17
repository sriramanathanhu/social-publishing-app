"""
Asset application for short clips: a full-frame PNG overlay, and appending a
transition + end-card. Assets are user-uploaded (hosted as public URLs) and
downloaded once per job. All ffmpeg ops re-encode to the clip's resolution so
mismatched source assets still concatenate cleanly.
"""

from __future__ import annotations

import os
import subprocess

import requests

from .utils import log


def download_url(url: str, dest: str) -> str | None:
    """Download an asset URL to dest. Returns the path, or None on failure."""
    try:
        with requests.get(url, stream=True, timeout=120) as r:
            if r.status_code != 200:
                log("ASSET", f"download {url} -> HTTP {r.status_code}")
                return None
            with open(dest, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    if chunk:
                        f.write(chunk)
        return dest if os.path.getsize(dest) > 100 else None
    except Exception as e:  # noqa: BLE001
        log("ASSET", f"download {url} failed: {str(e)[:120]}")
        return None


def _has_audio(path: str) -> bool:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a",
         "-show_entries", "stream=index", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    )
    return bool(r.stdout.strip())


def normalize_asset(src: str, dst: str, rx: int, ry: int) -> str | None:
    """Re-encode a transition/end-card to rx×ry, 30fps, stereo 44.1k — adding a
    silent track if the source has none — so per-clip concat always succeeds."""
    vf = (f"scale={rx}:{ry}:force_original_aspect_ratio=decrease,"
          f"pad={rx}:{ry}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30")
    if _has_audio(src):
        args = ["ffmpeg", "-y", "-i", src, "-vf", vf,
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", dst]
    else:
        args = ["ffmpeg", "-y", "-i", src,
                "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                "-vf", vf, "-shortest", "-map", "0:v", "-map", "1:a",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                "-c:a", "aac", "-b:a", "128k", dst]
    subprocess.run(args, capture_output=True)
    return dst if os.path.exists(dst) and os.path.getsize(dst) > 5000 else None


def scale_png(src: str, dst: str, rx: int, ry: int) -> str | None:
    subprocess.run(
        ["ffmpeg", "-y", "-i", src, "-vf", f"scale={rx}:{ry}", dst],
        capture_output=True,
    )
    return dst if os.path.exists(dst) else None


def apply_overlay(clip: str, overlay_png: str, out: str) -> bool:
    """Overlay a full-frame PNG (already scaled to the clip size) onto a clip."""
    subprocess.run(
        ["ffmpeg", "-y", "-i", clip, "-i", overlay_png,
         "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto[v]",
         "-map", "[v]", "-map", "0:a?",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
         "-c:a", "copy", "-movflags", "+faststart", out],
        capture_output=True,
    )
    return os.path.exists(out) and os.path.getsize(out) > 5000


def concat_with(clip: str, extras: list[str], out: str, rx: int, ry: int) -> bool:
    """Concatenate clip + extras (transition, end-card) into one video. Each
    input is scaled/padded to rx×ry and re-encoded so sources with different
    resolutions/codecs still join without artefacts."""
    inputs = [clip, *[e for e in extras if e]]
    if len(inputs) == 1:
        return False  # nothing to append
    args = ["ffmpeg", "-y"]
    for p in inputs:
        args += ["-i", p]
    parts, concat = [], ""
    for i in range(len(inputs)):
        parts.append(
            f"[{i}:v]scale={rx}:{ry}:force_original_aspect_ratio=decrease,"
            f"pad={rx}:{ry}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v{i}];"
            f"[{i}:a]aresample=44100,asetpts=N/SR/TB[a{i}]"
        )
        concat += f"[v{i}][a{i}]"
    fc = ";".join(parts) + f";{concat}concat=n={len(inputs)}:v=1:a=1[ov][oa]"
    args += [
        "-filter_complex", fc, "-map", "[ov]", "-map", "[oa]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
    ]
    subprocess.run(args, capture_output=True)
    return os.path.exists(out) and os.path.getsize(out) > 5000
