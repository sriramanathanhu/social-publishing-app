"""
Subject-aware reframing: TRACK the speaker's face across the clip and pan the
vertical crop to follow them, so split-layout sources (speaker on one side, a
slide on the other) and moving / multi-shot speakers stay framed for the WHOLE
clip — not just the middle.

We extract frames DENSELY in a single ffmpeg pass, locate the face per frame,
fill gaps, then drive the crop with an eased motion model (temporal low-pass +
velocity AND acceleration limits) so the camera accelerates and decelerates
gently instead of sliding abruptly between sparse keyframes. The smoothed path
is simplified to a few keyframes and emitted as a time-varying ffmpeg crop
expression.

CPU-only via OpenCV on sampled frames; returns None when no face is found
anywhere, so the caller falls back to a fixed crop.

When a reference-face embedding is supplied (``ref_feat``), detection switches
from the largest-face Haar heuristic to YuNet detection + SFace recognition:
every face in a frame is matched against the reference and we follow the
best-matching person, so the crop locks onto a specific individual even when
several people are on screen.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile

from .utils import log

# Dense sampling → smooth panning. Frames are extracted in ONE ffmpeg pass at
# this fps (downscaled), so the crop follows fine motion instead of sliding
# between sparse keyframes. All knobs are env-tunable.
_SAMPLE_FPS = float(os.getenv("SHORTS_SAMPLE_FPS", "4"))
# Frames are scaled to this width for detection; the face centre is scaled back
# to source px afterwards (keeps detection fast on 1080p+ sources).
_DET_WIDTH = int(os.getenv("SHORTS_DET_WIDTH", "960"))
# Hard cap on sampled frames so a very long clip can't explode the work.
_MAX_FRAMES = int(os.getenv("SHORTS_MAX_FRAMES", "600"))
# Virtual-camera motion model (fractions of source width):
#  • _SMOOTH_SEC  — temporal low-pass window that removes detection jitter.
#  • _DEADZONE    — central safe band; the camera HOLDS while the subject stays
#                   within it, so small head movements don't wobble the frame.
#  • _MAX_PAN     — max pan speed   (px / s).
#  • _MAX_ACC     — max pan accel   (px / s²); this is what makes pans ease in
#                   and out instead of starting/stopping abruptly.
#  • _SNAP        — if the subject jumps farther than this (e.g. a scene cut),
#                   cut the crop instantly instead of sliding the background.
_SMOOTH_SEC = float(os.getenv("SHORTS_SMOOTH_SEC", "1.0"))
_DEADZONE_FRAC = float(os.getenv("SHORTS_DEADZONE_FRAC", "0.06"))
_MAX_PAN_FRAC = float(os.getenv("SHORTS_MAX_PAN_FRAC", "0.09"))
_MAX_ACC_FRAC = float(os.getenv("SHORTS_MAX_ACC_FRAC", "0.22"))
_SNAP_FRAC = float(os.getenv("SHORTS_SNAP_FRAC", "0.45"))
# Simulate the virtual camera at this fps — independent of the (cheaper)
# detection fps — so the emitted motion is smooth at playback rate. Emitted
# keyframes are capped so a very dynamic clip can't produce a huge expression.
_EMIT_FPS = float(os.getenv("SHORTS_EMIT_FPS", "12"))
# The crop path is a NESTED if() expression (one level per keyframe), and ffmpeg's
# expression parser rejects graphs deeper than ~100 nested calls ("Missing ')' or
# too many args" → "all clip renders failed"). Keep this well under that cliff —
# 60 keyframes still pans smoothly for a talking head.
_MAX_KEYFRAMES = int(os.getenv("SHORTS_MAX_KEYFRAMES", "60"))


def _cascade():
    import cv2

    return cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )


# ── YuNet (detect) + SFace (recognise) for reference-face re-identification ───
# Bundled ONNX models live in dubber-service/assets/models. When a reference
# face is supplied we detect ALL faces in a frame and follow the one matching
# the reference embedding, instead of the cascade's largest-face heuristic.
_MODELS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(__file__)), "assets", "models"
)
_YUNET_PATH = os.path.join(_MODELS_DIR, "face_detection_yunet_2023mar.onnx")
_SFACE_PATH = os.path.join(_MODELS_DIR, "face_recognition_sface_2021dec.onnx")
# SFace same-identity cosine threshold (higher = more similar). OpenCV's
# documented default is 0.363; env-tunable, useful range ~0.30–0.36 for the
# off-angle / variable-lighting frames you get inside a real video.
_COSINE_THRESHOLD = float(os.getenv("SFACE_COSINE_THRESHOLD", "0.363"))
# When two faces both match the reference within this cosine margin of each other
# the frame is ambiguous (e.g. a look-alike) — we skip it rather than risk
# locking onto the wrong person; the gap is filled from confident neighbours.
_MATCH_MARGIN = float(os.getenv("SFACE_MATCH_MARGIN", "0.10"))


def models_available() -> bool:
    """True when both re-ID ONNX models are present (bundled in the image)."""
    return os.path.exists(_YUNET_PATH) and os.path.exists(_SFACE_PATH)


def _detector(w: int, h: int, score: float = 0.6, nms: float = 0.3, top_k: int = 50):
    import cv2

    return cv2.FaceDetectorYN.create(_YUNET_PATH, "", (w, h), score, nms, top_k)


def _recognizer():
    import cv2

    return cv2.FaceRecognizerSF.create(_SFACE_PATH, "")


def compute_reference_embedding(image_path: str):
    """SFace embedding of the largest face in the reference image, or None if no
    face is detectable. Computed ONCE per job and reused across all clips."""
    import cv2

    img = cv2.imread(image_path)
    if img is None:
        return None
    h, w = img.shape[:2]
    _, faces = _detector(w, h).detect(img)
    if faces is None or len(faces) == 0:
        return None
    face = max(faces, key=lambda f: f[2] * f[3])  # f[2]=w, f[3]=h
    rec = _recognizer()
    return rec.feature(rec.alignCrop(img, face))


def _detect_center_x_identity(detector, recognizer, ref_feat, img,
                              threshold: float = _COSINE_THRESHOLD,
                              margin: float = _MATCH_MARGIN) -> float | None:
    """Centre-x (source px) of the detected face that matches ``ref_feat``, or
    None if the target isn't clearly present in this frame. Returns None when the
    best match is below ``threshold`` OR a second face scores within ``margin`` of
    it (ambiguous — could be a look-alike), so we never guess the wrong person."""
    import cv2

    h, w = img.shape[:2]
    detector.setInputSize((w, h))
    _, faces = detector.detect(img)
    if faces is None or len(faces) == 0:
        return None
    scored = []
    for face in faces:
        feat = recognizer.feature(recognizer.alignCrop(img, face))
        s = recognizer.match(ref_feat, feat, cv2.FaceRecognizerSF_FR_COSINE)
        scored.append((s, float(face[0] + face[2] / 2.0)))
    scored.sort(key=lambda r: -r[0])  # cosine: higher = more similar
    best_score, best_x = scored[0]
    if best_score < threshold:
        return None
    if len(scored) > 1 and scored[1][0] >= best_score - margin:
        return None  # two comparable matches → ambiguous, skip this frame
    return best_x


def _extract_frames(video: str, start: float, dur: float, work_dir: str,
                    fps: float, det_w: int) -> tuple[list[tuple[float, str]], str]:
    """Extract frames for [start, start+dur] in ONE ffmpeg pass, scaled to
    ``det_w`` wide, into a FRESH per-call temp dir so clips rendered concurrently
    (render_one runs in a ThreadPoolExecutor and shares one work_dir) never
    collide on the f_%05d.jpg filenames. Returns ([(t_relative, frame_path), …],
    frames_dir); the caller must remove frames_dir."""
    import glob

    os.makedirs(work_dir, exist_ok=True)
    out_dir = tempfile.mkdtemp(prefix="_frames_", dir=work_dir)
    subprocess.run(
        ["ffmpeg", "-y", "-ss", f"{start:.2f}", "-t", f"{dur:.2f}", "-i", video,
         "-vf", f"fps={fps:.4f},scale={det_w}:-2", "-q:v", "4",
         os.path.join(out_dir, "f_%05d.jpg")],
        capture_output=True,
    )
    files = sorted(glob.glob(os.path.join(out_dir, "f_*.jpg")))
    return [(i / fps, p) for i, p in enumerate(files)], out_dir


def _detect_center_x(cascade, img, min_size: int = 80) -> float | None:
    """Horizontal centre (frame px) of the largest detected face, or None."""
    import cv2

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(
        gray, scaleFactor=1.1, minNeighbors=5, minSize=(min_size, min_size)
    )
    if not len(faces):
        return None
    x, _y, w, _h = max(faces, key=lambda f: f[2] * f[3])
    return x + w / 2.0


def _smooth(ts: list[float], xs: list[float], src_w: int,
            sample_fps: float) -> list[tuple[float, float]]:
    """Virtual-camera follow → returns a fine ``(t, x)`` path. The crop is a
    camera that HOLDS while the subject stays within a central dead-zone (so small
    head movements don't wobble the frame) and EASES — velocity- and
    acceleration-limited — to re-centre when the subject genuinely moves. A large
    jump (scene cut) snaps instantly.

    Detection happens at ``sample_fps`` but the camera is integrated at the finer
    ``_EMIT_FPS`` so playback motion is smooth, not stepped at the sample rate."""
    n = len(xs)
    if n <= 1:
        return list(zip(ts, xs))

    # 1) Centered moving average over ~_SMOOTH_SEC, applied twice (≈ Gaussian) to
    #    remove per-frame detection jitter before the camera ever reacts to it.
    win = max(1, int(round(_SMOOTH_SEC * sample_fps / 2)))

    def movavg(a: list[float]) -> list[float]:
        out = []
        for i in range(len(a)):
            lo, hi = max(0, i - win), min(len(a), i + win + 1)
            out.append(sum(a[lo:hi]) / (hi - lo))
        return out

    tgt = movavg(movavg(list(xs)))

    # 2) Integrate the dead-zone + accel/velocity-limited camera at _EMIT_FPS.
    # tq increases monotonically and ts is sorted, so we advance one index through
    # ts instead of re-scanning it every step — O(steps + samples), not O(steps×n).
    deadzone = src_w * _DEADZONE_FRAC
    max_v = src_w * _MAX_PAN_FRAC
    max_a = src_w * _MAX_ACC_FRAC
    snap = src_w * _SNAP_FRAC

    t0, t1 = ts[0], ts[-1]
    steps = max(1, int(round((t1 - t0) * _EMIT_FPS)))
    dt = (t1 - t0) / steps
    cam, v = tgt[0], 0.0
    out = [(t0, cam)]
    j = 1  # invariant: ts[j-1] <= tq <= ts[j]
    for k in range(1, steps + 1):
        tq = t0 + k * dt
        while j < len(ts) - 1 and tq >= ts[j]:
            j += 1
        a, b = ts[j - 1], ts[j]
        u = (tq - a) / (b - a) if b > a else 0.0
        u = 0.0 if u < 0.0 else 1.0 if u > 1.0 else u
        target = tgt[j - 1] + (tgt[j] - tgt[j - 1]) * u
        err = target - cam
        if abs(err) >= snap:
            # Scene cut / teleport — jump rather than slide the whole background.
            cam, v = target, 0.0
        else:
            # Inside the dead-zone → coast to a stop (goal = current cam); outside
            # → re-centre on the subject. Either way velocity/accel are bounded.
            goal = cam if abs(err) <= deadzone else target
            desired_v = max(-max_v, min(max_v, (goal - cam) / dt))
            dv = max(-max_a * dt, min(max_a * dt, desired_v - v))
            v += dv
            cam += v * dt
        out.append((tq, cam))
    return out


def _collapse_holds(pts: list[tuple[float, int]]) -> list[tuple[float, int]]:
    """Drop interior keyframes inside a run of EQUAL crop-x (a held shot),
    keeping the run's first and last point so timing is preserved. Moving
    sections keep every point, so the eased path is reproduced faithfully by
    linear interpolation while long holds collapse to two keyframes."""
    if len(pts) <= 2:
        return list(pts)
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        if not (pts[i][1] == pts[i - 1][1] == pts[i + 1][1]):
            out.append(pts[i])
    out.append(pts[-1])
    return out


def _cap_keyframes(pts: list[tuple[float, int]],
                   cap: int) -> list[tuple[float, int]]:
    """Uniformly thin a keyframe list to at most ``cap`` points (keeping the
    endpoints) so a very dynamic clip can't produce an oversized expression.
    Linear interpolation of the eased path stays smooth after thinning."""
    if len(pts) <= cap:
        return pts
    step = (len(pts) - 1) / (cap - 1)
    idx = sorted({int(round(i * step)) for i in range(cap)} | {0, len(pts) - 1})
    return [pts[i] for i in idx]


def face_track(video: str, start: float, end: float, work_dir: str,
               src_w: int, ref_feat=None) -> list[tuple[float, float]]:
    """Sample faces across [start, end] and return a smoothed path of
    ``(t_relative, face_center_x)`` keyframes (t measured from the clip start, to
    match the seeked render input). Empty list if no face is found at all.

    When ``ref_feat`` is given (and the re-ID models are present), follow the
    person matching that reference embedding instead of the largest face."""
    try:
        import cv2  # noqa: F401
        import numpy as np
    except Exception:  # noqa: BLE001
        return []

    identity = ref_feat is not None and models_available()
    det_w = max(1, min(_DET_WIDTH, src_w))
    factor = src_w / float(det_w)  # scaled-frame px → source px

    # Build detector/recognizer (or cascade) ONCE per call — i.e. per clip.
    # render_one() runs clips in a ThreadPoolExecutor and OpenCV DNN nets are not
    # guaranteed thread-safe, so these must never be shared across threads.
    detector = recognizer = cascade = None
    if identity:
        detector, recognizer = _detector(det_w, det_w), _recognizer()
    else:
        cascade = _cascade()
    min_size = max(16, int(80 / factor))  # keep the ~80px-in-source floor

    dur = max(end - start, 1.0)
    fps = _SAMPLE_FPS
    if dur * fps > _MAX_FRAMES:  # cap work on very long clips
        fps = _MAX_FRAMES / dur

    frames, frames_dir = _extract_frames(video, start, dur, work_dir, fps, det_w)
    raw: list[tuple[float, float | None]] = []
    try:
        for t_rel, p in frames:
            x = None
            img = cv2.imread(p)
            if img is not None:
                sx = (
                    _detect_center_x_identity(detector, recognizer, ref_feat, img)
                    if identity
                    else _detect_center_x(cascade, img, min_size)
                )
                if sx is not None:
                    x = sx * factor
            raw.append((t_rel, x))
    finally:
        # Always remove the per-call frame dir (covers empty/exception paths too).
        shutil.rmtree(frames_dir, ignore_errors=True)

    detected = [x for _t, x in raw if x is not None]
    if not detected:
        return []

    if identity:
        # Each detection is the confident, unambiguous target (gated by threshold
        # + margin in _detect_center_x_identity), so keep them all and only
        # gap-fill misses. The median filter below exists for the largest-face
        # heuristic (drop a stray slide face); here it would wrongly discard the
        # target's own legitimate large movements across the frame.
        cleaned = list(raw)
    else:
        # Reject samples far from the median (e.g. a face that briefly appears on
        # a slide), then forward/back-fill gaps from the nearest real detection so
        # the crop is pre-positioned where the speaker is even before they appear.
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

    return _smooth(filled_t, filled_x, src_w, fps)


def _x_expr(pts: list[tuple[float, int]]) -> str:
    """Piecewise-LINEAR ffmpeg expression for crop x vs clip-relative time ``t``.
    The easing already lives in the (densely sampled) keyframes — only the flat
    holds were collapsed — so linear interpolation reproduces the smooth path
    without the velocity kinks that sparse keyframes would introduce."""
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


def auto_crop_filter(video, start, end, work_dir, aspect, src_w, src_h, rx, ry,
                     ref_feat=None) -> str | None:
    """Build an ffmpeg crop filter that PANS to follow a face across this clip.
    With ``ref_feat`` it follows the matching person; otherwise the largest face.
    Returns None if face detection is unavailable / the target is not found
    anywhere in the clip (caller falls back to a fixed centre crop)."""
    if aspect == "16:9":
        return None  # letterboxed — no horizontal crop to steer
    if aspect == "1:1":
        cw = ch = min(src_w, src_h)
    else:  # 9:16
        cw, ch = int(round(src_h * 9 / 16)), src_h

    track = face_track(video, start, end, work_dir, src_w, ref_feat=ref_feat)
    if not track:
        return None

    y = max((src_h - ch) // 2, 0)
    max_x = max(src_w - cw, 0)
    # Convert each face centre to a clamped crop-x keyframe, then collapse the
    # flat (held) runs so the emitted expression stays small while the eased
    # moving sections keep all their points.
    pts = [(t, int(min(max(fx - cw / 2, 0), max_x))) for t, fx in track]
    pts = _cap_keyframes(_collapse_holds(pts), _MAX_KEYFRAMES)

    if len({x for _t, x in pts}) == 1:
        # Speaker stays put — a single static crop is enough (and cheaper).
        log("REFRAME", f"static crop x={pts[0][1]}")
        return f"crop={cw}:{ch}:{pts[0][1]}:{y},scale={rx}:{ry}"

    log("REFRAME", f"tracking crop, {len(pts)} keyframes "
                   f"x={pts[0][1]}..{pts[-1][1]}")
    return (f"crop=w={cw}:h={ch}:x='{_x_expr(pts)}':y={y},"
            f"scale={rx}:{ry}")
