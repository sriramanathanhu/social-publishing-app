"""
Subject-aware reframing: TRACK the speaker's face across the clip and pan the
vertical crop to follow them, so split-layout sources (speaker on one side, a
slide on the other) and moving / multi-shot speakers stay framed for the WHOLE
clip — not just the middle.

Earlier this computed one static crop from the median of 5 samples, so the crop
was wrong wherever the speaker wasn't at that median (typically the first and
last seconds). Now we sample faces along the clip, reject outliers, fill gaps,
smooth + velocity-limit the path, and emit a time-varying ffmpeg crop expression.

CPU-only via OpenCV Haar detection on sampled frames; returns None when no face
is found anywhere, so the caller falls back to a fixed crop.
"""

from __future__ import annotations

import os
import subprocess

from .utils import log

# Sample roughly every this many seconds, clamped to [_MIN, _MAX] samples.
_SAMPLE_EVERY = 2.0
_MIN_SAMPLES = 5
_MAX_SAMPLES = 16


def _cascade():
    import cv2

    return cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )


def _sample_frame(video: str, t: float, out: str) -> str | None:
    subprocess.run(
        ["ffmpeg", "-y", "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1",
         "-q:v", "3", out],
        capture_output=True,
    )
    return out if os.path.exists(out) and os.path.getsize(out) > 1000 else None


def _detect_center_x(cascade, img) -> float | None:
    """Horizontal centre (source px) of the largest detected face, or None."""
    import cv2

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(80, 80)
    )
    if not len(faces):
        return None
    x, _y, w, _h = max(faces, key=lambda f: f[2] * f[3])
    return x + w / 2.0


def _smooth(ts: list[float], xs: list[float], src_w: int) -> list[float]:
    """Moving-average + per-second velocity clamp so the crop pans gently and
    doesn't chase jitter or a brief mis-detection."""
    win = 1
    avg = []
    for i in range(len(xs)):
        lo, hi = max(0, i - win), min(len(xs), i + win + 1)
        avg.append(sum(xs[lo:hi]) / (hi - lo))
    max_v = src_w * 0.18  # max horizontal pan, px per second
    out = [avg[0]]
    for i in range(1, len(avg)):
        dt = max(ts[i] - ts[i - 1], 0.1)
        dx = avg[i] - out[-1]
        lim = max_v * dt
        dx = max(-lim, min(lim, dx))
        out.append(out[-1] + dx)
    return out


def face_track(video: str, start: float, end: float, work_dir: str,
               src_w: int) -> list[tuple[float, float]]:
    """Sample faces across [start, end] and return a smoothed path of
    ``(t_relative, face_center_x)`` keyframes (t measured from the clip start, to
    match the seeked render input). Empty list if no face is found at all."""
    try:
        import cv2  # noqa: F401
        import numpy as np
    except Exception:  # noqa: BLE001
        return []

    cascade = _cascade()
    dur = max(end - start, 1.0)
    n = int(min(_MAX_SAMPLES, max(_MIN_SAMPLES, dur / _SAMPLE_EVERY)))

    raw: list[tuple[float, float | None]] = []
    for i in range(n):
        t_rel = dur * (i + 0.5) / n
        p = _sample_frame(video, start + t_rel, os.path.join(work_dir, f"_fr{i}.jpg"))
        x = None
        if p:
            try:
                import cv2

                img = cv2.imread(p)
                if img is not None:
                    x = _detect_center_x(cascade, img)
            finally:
                try:
                    os.remove(p)
                except OSError:
                    pass
        raw.append((t_rel, x))

    detected = [x for _t, x in raw if x is not None]
    if not detected:
        return []

    # Reject samples far from the median (e.g. a face that briefly appears on a
    # slide), then forward/back-fill gaps from the nearest real detection so the
    # crop is pre-positioned where the speaker is even before they first appear.
    med = float(np.median(detected))
    cleaned = [
        (t, (x if x is not None and abs(x - med) <= src_w * 0.35 else None))
        for t, x in raw
    ]
    known = [(t, x) for t, x in cleaned if x is not None]
    if not known:
        known = [(t, x) for t, x in raw if x is not None]
    filled_t, filled_x = [], []
    for t, x in cleaned:
        if x is None:
            x = min(known, key=lambda k: abs(k[0] - t))[1]
        filled_t.append(t)
        filled_x.append(x)

    smoothed = _smooth(filled_t, filled_x, src_w)
    return list(zip(filled_t, smoothed))


def _x_expr(pts: list[tuple[float, int]]) -> str:
    """Piecewise-LINEAR ffmpeg expression for crop x as a function of time ``t``
    (clip-relative seconds), interpolating between the keyframe crop positions."""
    expr = str(pts[-1][1])  # hold last position after the final keyframe
    for i in range(len(pts) - 1, 0, -1):
        t0, x0 = pts[i - 1]
        t1, x1 = pts[i]
        if t1 - t0 <= 0:
            seg = str(x1)
        else:
            seg = f"({x0}+({x1 - x0})*(t-{t0:.3f})/{t1 - t0:.3f})"
        expr = f"if(lt(t,{t1:.3f}),{seg},{expr})"
    # hold first position before the first keyframe
    return f"if(lt(t,{pts[0][0]:.3f}),{pts[0][1]},{expr})"


def auto_crop_filter(video, start, end, work_dir, aspect, src_w, src_h, rx, ry) -> str | None:
    """Build an ffmpeg crop filter that PANS to follow the speaker's face across
    this clip. Returns None if face detection is unavailable / no face is found
    (caller falls back to a fixed crop)."""
    if aspect == "16:9":
        return None  # letterboxed — no horizontal crop to steer
    if aspect == "1:1":
        cw = ch = min(src_w, src_h)
    else:  # 9:16
        cw, ch = int(round(src_h * 9 / 16)), src_h

    track = face_track(video, start, end, work_dir, src_w)
    if not track:
        return None

    y = max((src_h - ch) // 2, 0)
    max_x = max(src_w - cw, 0)
    # Convert each face centre to a clamped crop-x keyframe.
    pts = [(t, int(min(max(fx - cw / 2, 0), max_x))) for t, fx in track]

    if len({x for _t, x in pts}) == 1:
        # Speaker stays put — a single static crop is enough (and cheaper).
        log("REFRAME", f"static crop x={pts[0][1]}")
        return f"crop={cw}:{ch}:{pts[0][1]}:{y},scale={rx}:{ry}"

    log("REFRAME", f"tracking crop, {len(pts)} keyframes "
                   f"x={pts[0][1]}..{pts[-1][1]}")
    return (f"crop=w={cw}:h={ch}:x='{_x_expr(pts)}':y={y},"
            f"scale={rx}:{ry}")
