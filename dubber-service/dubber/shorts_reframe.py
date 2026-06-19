"""
Subject-aware reframing: find the speaker's face and centre the vertical crop on
it, so split-layout sources (speaker on one side, a slide on the other) frame the
speaker instead of a fixed centre strip. CPU-only via OpenCV Haar detection on a
few sampled frames; returns None when no face is found so the caller centres.
"""

from __future__ import annotations

import os
import subprocess

from .utils import log

_N_SAMPLES = 5


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


def face_center_x(video: str, start: float, end: float, work_dir: str,
                  n: int = _N_SAMPLES) -> float | None:
    """Median horizontal centre (in source pixels) of the largest detected face
    across n frames sampled within [start, end]. None if no face is found."""
    try:
        import cv2  # noqa: F401
        import numpy as np
    except Exception:  # noqa: BLE001
        return None

    cascade = _cascade()
    dur = max(end - start, 1.0)
    centers = []
    for i in range(n):
        t = start + dur * (i + 0.5) / n
        p = _sample_frame(video, t, os.path.join(work_dir, f"_fr{i}.jpg"))
        if not p:
            continue
        try:
            import cv2

            img = cv2.imread(p)
            if img is not None:
                gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                faces = cascade.detectMultiScale(
                    gray, scaleFactor=1.1, minNeighbors=5, minSize=(80, 80)
                )
                if len(faces):
                    x, _y, w, _h = max(faces, key=lambda f: f[2] * f[3])
                    centers.append(x + w / 2.0)
        finally:
            try:
                os.remove(p)
            except OSError:
                pass

    if not centers:
        return None
    import numpy as np

    return float(np.median(centers))


def auto_crop_filter(video, start, end, work_dir, aspect, src_w, src_h, rx, ry) -> str | None:
    """Build a numeric ffmpeg crop filter centred on the speaker's face for this
    clip. Returns None if face detection is unavailable (caller falls back)."""
    if aspect == "16:9":
        return None  # letterboxed — no horizontal crop to steer
    if aspect == "1:1":
        cw = ch = min(src_w, src_h)
    else:  # 9:16
        cw, ch = int(round(src_h * 9 / 16)), src_h

    fx = face_center_x(video, start, end, work_dir)
    if fx is None:
        return None
    x = int(min(max(fx - cw / 2, 0), max(src_w - cw, 0)))
    y = max((src_h - ch) // 2, 0)
    log("REFRAME", f"face_x={int(fx)} -> crop x={x}")
    return f"crop={cw}:{ch}:{x}:{y},scale={rx}:{ry}"
