import os, subprocess, json, tempfile, concurrent.futures
from .utils import log, PLATFORM_SPECS


def _score_segments(segments, strategy):
    if not segments:
        return 0
    n = len(segments)
    if strategy == "hook_moment":
        subset = segments[: max(1, n // 3)]
        return max(
            range(len(subset)), key=lambda i: subset[i]["end"] - subset[i]["start"]
        )
    elif strategy == "fastest_moment":
        return min(range(n), key=lambda i: segments[i]["end"] - segments[i]["start"])
    elif strategy == "peak_moment":
        lo, hi = n // 3, max(n // 3 + 1, 2 * n // 3)
        subset_idx = list(range(lo, hi)) or list(range(n))
        return max(subset_idx, key=lambda i: segments[i]["end"] - segments[i]["start"])
    elif strategy == "emotional_hook":

        def score(seg):
            t = seg.get("translated", "") + seg.get("text", "")
            return t.count("!") + t.count("?") + t.count(".")

        return max(range(n), key=lambda i: score(segments[i]))
    return 0


def _get_video_duration(video_path):
    r = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", video_path],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        return float(json.loads(r.stdout)["format"]["duration"])
    except Exception:
        return None


def _cut_teaser(
    dubbed_video_path, start, dur, out_path, overlay_text=None, output_dir="workspace"
):
    # TODO: Implement text overlay when Gujarati-capable font is available via ffmpeg CLI
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        str(round(start, 3)),
        "-i",
        dubbed_video_path,
        "-t",
        str(round(dur, 3)),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-c:a",
        "aac",
        out_path,
    ]

    r = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")

    if r.returncode != 0:
        stderr = (r.stderr or "")[-400:]
        log("TEASER", f"  FFmpeg error: {stderr}")
        return False
    return True


def generate_teasers(dubbed_video_path, segments, captions, output_dir="workspace"):
    if not segments:
        log("TEASER", "No segments — skipping teaser generation")
        return {}
    os.makedirs(output_dir, exist_ok=True)
    video_dur = _get_video_duration(dubbed_video_path)

    # Build all teaser tasks first
    tasks = []
    for platform, spec in PLATFORM_SPECS.items():
        strategy = spec["strategy"]
        min_dur = spec["min"]
        max_dur = spec["max"]
        label = spec["label"]

        seg_idx = _score_segments(segments, strategy)
        seg = segments[seg_idx]
        start = seg["start"]

        target_dur = (min_dur + max_dur) / 2
        if video_dur:
            available = video_dur - start
            dur = min(target_dur, available, max_dur)
            dur = max(dur, min(min_dur, available))
        else:
            dur = target_dur

        out_path = os.path.join(output_dir, f"teaser_{platform}.mp4")
        tasks.append((platform, label, strategy, start, dur, out_path))

    # Run FFmpeg cuts in parallel (4 workers)
    teasers = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        future_to_platform = {}
        for platform, label, strategy, start, dur, out_path in tasks:
            log(
                "TEASER",
                f"[{label}] strategy={strategy} start={start:.1f}s dur={dur:.1f}s",
            )
            future = pool.submit(_cut_teaser, dubbed_video_path, start, dur, out_path)
            future_to_platform[future] = (platform, out_path)

        for future in concurrent.futures.as_completed(future_to_platform):
            platform, out_path = future_to_platform[future]
            ok = future.result()
            if ok:
                log("TEASER", f"  -> {out_path}")
                teasers[platform] = out_path
            else:
                log("TEASER", f"  FAILED for {platform}")

    if "instagram" in teasers:
        import shutil as _sh

        _sh.copy(teasers["instagram"], os.path.join(output_dir, "teaser.mp4"))

    return teasers


def generate_teaser(
    dubbed_video_path, segments, output_dir="workspace", min_dur=6.0, max_dur=10.0
):
    teasers = generate_teasers(dubbed_video_path, segments, {}, output_dir)
    return teasers.get("instagram") or (list(teasers.values())[0] if teasers else None)
