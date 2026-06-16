import os, subprocess, shutil
from pydub import AudioSegment
from .utils import FPS_FALLBACK, ffprobe_duration, ffprobe_fps, ffprobe_info, log

# Re-export under their legacy private names so existing imports from
# app.py (and any consumers outside the package) keep working.
_FPS_FALLBACK = FPS_FALLBACK
_ffprobe_duration = ffprobe_duration
_ffprobe_fps = ffprobe_fps

SMALL_GAP_KEEP = 0.08
MEDIUM_GAP_KEEP = 0.18
THOUGHT_PAUSE_KEEP = 0.32


def _cut(src, start, end, dst):
    dur = max(round(end - start, 4), 0.1)
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        str(round(start, 4)),
        "-i",
        src,
        "-t",
        str(dur),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-an",
        dst,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=300)
    except subprocess.TimeoutExpired:
        # Observed in prod (see dubber_20260423.log seg#3 hang): a single
        # ffmpeg cut can wedge for the full timeout and previously took the
        # whole pipeline down with it. Fall back to shutil.copy so BUILD can
        # keep going — downstream audio overlay math uses the source
        # duration anyway, so a raw copy is a safe degraded path.
        log(
            "CUT",
            f"  FFmpeg cut TIMED OUT after 300s for {os.path.basename(dst)} "
            f"(start={start:.2f}s dur={dur:.2f}s) — copying source as fallback",
        )
        try:
            shutil.copy(src, dst)
        except Exception as copy_err:
            log("CUT", f"  Fallback copy also failed: {copy_err}")
        return
    if r.returncode != 0 or not os.path.exists(dst):
        log("CUT", f"  FFmpeg cut failed for {os.path.basename(dst)}, copying source")
        shutil.copy(src, dst)


def _slow(src, dst, pts_factor, fps=_FPS_FALLBACK):
    pts = min(round(pts_factor, 5), 4.0)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        src,
        "-filter:v",
        f"setpts={pts}*PTS",
        "-an",
        "-r",
        str(fps or _FPS_FALLBACK),
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "22",
        dst,
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        # Catch the hung-ffmpeg case (same pattern as _cut). Without this,
        # TimeoutExpired bubbles all the way up through ThreadPoolExecutor
        # and crashes the pipeline mid-BUILD with no useful log.
        log(
            "SLOW",
            f"  FFmpeg stretch TIMED OUT after 300s (pts={pts}x) — "
            f"copying source as fallback (A/V sync will differ)",
        )
        try:
            shutil.copy(src, dst)
        except Exception as copy_err:
            log("SLOW", f"  Fallback copy also failed: {copy_err}")
            return False
        return False
    if r.returncode != 0:
        log(
            "SLOW", f"  FFmpeg failed, copying source as fallback (A/V sync may differ)"
        )
        shutil.copy(src, dst)
        return False
    return True


def _actual_duration(path):
    try:
        return _ffprobe_duration(path)
    except Exception:
        return None


def _target_gap(prev_seg, seg, raw_gap):
    if raw_gap <= 0.05:
        return 0.0

    prev_complete = bool((prev_seg or {}).get("is_complete_thought", False))
    current_pause = float(seg.get("pause_before", raw_gap) or 0.0)

    if raw_gap >= 1.2:
        return raw_gap
    if raw_gap >= 0.7:
        return max(min(raw_gap, 0.55), THOUGHT_PAUSE_KEEP if prev_complete else MEDIUM_GAP_KEEP)
    if prev_complete:
        return min(raw_gap, max(current_pause, THOUGHT_PAUSE_KEEP))
    if raw_gap <= 0.2:
        return min(raw_gap, SMALL_GAP_KEEP)
    return min(raw_gap, MEDIUM_GAP_KEEP)


def _pad_audio_with_silence(audio_path, target_dur_ms):
    """Pad audio with silence to reach target duration (in milliseconds)."""
    if not audio_path or not os.path.exists(audio_path):
        return None
    try:
        audio = AudioSegment.from_file(audio_path)
        current_ms = len(audio)
        if target_dur_ms <= current_ms:
            return None
        silence_ms = target_dur_ms - current_ms
        if silence_ms < 50:
            return None
        silence = AudioSegment.silent(duration=silence_ms)
        padded = audio + silence
        padded_path = audio_path.replace(".wav", f"_padded.wav")
        padded.export(padded_path, format="wav")
        return padded_path
    except Exception as e:
        log("BUILD", f"    -> failed to pad audio: {e}")
        return None


def _generate_blank_video(dst, duration_sec, fps=_FPS_FALLBACK, width=1920, height=1080):
    """Generate a blank/black video frame for gaps when source extraction fails."""
    try:
        dur = max(round(duration_sec, 4), 0.1)
        dimensions = f"{width}x{height}"
        cmd = [
            "ffmpeg",
            "-y",
            "-f", "lavfi",
            "-i", f"color=c=black:s={dimensions}:d={dur}",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "23",
            "-an",
            "-r", str(fps or _FPS_FALLBACK),
            dst,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 500:
            return True
    except subprocess.TimeoutExpired:
        log("BUILD", f"    -> blank video generation TIMED OUT after 300s")
    except Exception as e:
        log("BUILD", f"    -> blank video generation failed: {e}")
    return False


def _extract_audio_clip(src, start, end, dst):
    dur = max(round(end - start, 4), 0.1)
    r = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            str(round(start, 4)),
            "-i",
            src,
            "-t",
            str(dur),
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "24000",
            "-ac",
            "1",
            dst,
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    return r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 100


def _segment_audio_strategy(seg, orig_dur, tts_dur):
    if seg.get("preserve_original_audio"):
        return {"mode": "original", "target_dur": orig_dur}
    return {"mode": "tts", "target_dur": tts_dur}


def _concat(parts, dst):
    list_file = dst + "_list.txt"
    with open(list_file, "w", encoding="utf-8") as f:
        for p in parts:
            safe = os.path.abspath(p).replace("\\", "/").replace("'", "'\\''")
            f.write(f"file '{safe}'\n")
    r = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list_file,
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-an",
            dst,
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    try:
        os.remove(list_file)
    except:
        pass
    if r.returncode != 0:
        log("BUILD", f"Concat error:\n{r.stderr[-500:]}")
        return False
    return True


def build_dubbed_video(
    video_path,
    segments,
    output_path,
    bgm_path=None,
    bgm_volume=0.35,
    output_dir="workspace",
):
    os.makedirs(output_dir, exist_ok=True)
    tmp = os.path.join(output_dir, "_tmp")
    try:
        shutil.rmtree(tmp)
    except Exception:
        pass
    os.makedirs(tmp, exist_ok=True)

    # One ffprobe pass for both duration and fps; saves one subprocess
    # launch per build (~30-50 ms on typical hosts). Native fps is
    # preserved across every retimed/rebuilt segment so the final concat
    # stays CFR and matches the original (24p / 25p / 29.97 / 30 / 50 /
    # 59.94 / 60 etc.). Hardcoding 30 drops frames on higher-fps sources
    # and duplicates them on filmic 24p.
    _info = ffprobe_info(video_path)
    if _info["duration"] is None:
        raise RuntimeError(f"ffprobe failed for: {video_path}")
    orig_total = _info["duration"]
    source_fps = _info["fps"] or FPS_FALLBACK
    log("BUILD", f"  source fps: {source_fps}")
    segs = sorted(segments, key=lambda s: s["start"])
    parts = []
    positions = []
    original_audio_ranges = []
    prev = 0.0
    cursor = 0.0
    prev_seg = None

    for i, seg in enumerate(segs):
        seg_start = seg["start"]
        seg_end = min(seg["end"], orig_total)
        orig_dur = max(seg_end - seg_start, 0.1)
        audio_path = seg.get("audio_path")
        audio_dur_ms = seg.get("audio_dur_ms", orig_dur * 1000)
        tts_dur = audio_dur_ms / 1000.0
        audio_strategy = _segment_audio_strategy(seg, orig_dur, tts_dur)
        raw_gap = seg_start - prev
        gap = _target_gap(prev_seg, seg, raw_gap)

        if raw_gap > 0.05 and gap > 0.01:
            gf = os.path.join(tmp, f"gap_{i:04d}.mp4")
            gap_start = max(prev, seg_start - gap)
            _cut(video_path, gap_start, seg_start, gf)
            if os.path.exists(gf) and os.path.getsize(gf) > 500:
                actual_gap = _actual_duration(gf) or gap
                parts.append(gf)
                cursor += actual_gap
            elif gap > 0.1:
                if _generate_blank_video(gf, gap, fps=source_fps):
                    actual_gap = _actual_duration(gf) or gap
                    parts.append(gf)
                    cursor += actual_gap
                    log("BUILD", f"    -> using generated blank video for gap ({gap:.2f}s)")

        seg_raw = os.path.join(tmp, f"seg_{i:04d}_raw.mp4")
        seg_out = os.path.join(tmp, f"seg_{i:04d}.mp4")
        _cut(video_path, seg_start, seg_end, seg_raw)

        log(
            "BUILD",
            f"  seg#{seg['id']}: orig={orig_dur:.2f}s tts={tts_dur:.2f}s gap={gap:.2f}s (raw {raw_gap:.2f}s)",
        )

        target_dur = audio_strategy["target_dur"]
        if audio_strategy["mode"] == "original":
            shutil.copy(seg_raw, seg_out)
            actual_seg_dur = _actual_duration(seg_out) or orig_dur
            log("BUILD", "    → preserving original source audio")
        else:
            # Preserve natural TTS pacing; only retime video to match spoken audio.
            stretch = target_dur / orig_dur

            if stretch > 1.05:  # Stretch video (TTS > Original)
                log("BUILD", f"    → stretch {stretch:.3f}x to match TTS")
                stretched = _slow(seg_raw, seg_out, stretch, fps=source_fps)
                if not stretched:
                    log("BUILD", f"    → WARNING: stretch failed, A/V may be out of sync")
                actual_seg_dur = _actual_duration(seg_out) or target_dur
            elif stretch < 0.95:  # Speed up video (TTS < Original)
                log("BUILD", f"    → speed up {stretch:.3f}x")
                # Use ffmpeg to speed up video
                speedup_cmd = [
                    "ffmpeg",
                    "-y",
                    "-i",
                    seg_raw,
                    "-filter:v",
                    f"setpts={stretch}*PTS",
                    "-an",
                    "-r",
                    str(source_fps or _FPS_FALLBACK),
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-crf",
                    "22",
                    seg_out,
                ]
                speedup_timed_out = False
                try:
                    r = subprocess.run(
                        speedup_cmd,
                        capture_output=True,
                        text=True,
                        timeout=300,
                    )
                except subprocess.TimeoutExpired:
                    # Same rescue as _cut/_slow — don't let a hung ffmpeg
                    # nuke the whole pipeline; copy raw and continue.
                    log(
                        "BUILD",
                        f"    → WARNING: speed up TIMED OUT after 300s for seg#{seg['id']} "
                        f"(stretch={stretch:.3f}x), using original",
                    )
                    speedup_timed_out = True
                if speedup_timed_out or r.returncode != 0:
                    if not speedup_timed_out:
                        log("BUILD", f"    → WARNING: speed up failed, using original")
                    shutil.copy(seg_raw, seg_out)
                    actual_seg_dur = orig_dur
                else:
                    actual_seg_dur = _actual_duration(seg_out) or target_dur
            else:  # No significant difference
                shutil.copy(seg_raw, seg_out)
                actual_seg_dur = _actual_duration(seg_out) or orig_dur

        audio_start = cursor
        parts.append(seg_out)
        cursor += actual_seg_dur
        prev = seg_end
        prev_seg = seg

        if audio_strategy["mode"] == "original":
            source_audio_path = os.path.join(tmp, f"seg_{i:04d}_source.wav")
            if _extract_audio_clip(video_path, seg_start, seg_end, source_audio_path):
                positions.append((audio_start, actual_seg_dur, source_audio_path, "original"))
                original_audio_ranges.append((audio_start, actual_seg_dur))
                log(
                    "BUILD",
                    f"    → original audio preserved at {audio_start:.2f}s for {actual_seg_dur:.2f}s",
                )
            else:
                log("BUILD", f"    → WARNING: Could not extract original audio for seg#{seg['id']}")
        elif audio_path and os.path.exists(audio_path):
            # Trim audio to match video duration to prevent overlap with next segment
            overlay_dur = min(tts_dur, actual_seg_dur)
            positions.append((audio_start, overlay_dur, audio_path, "tts"))
            log(
                "BUILD",
                f"    → audio overlay at {audio_start:.2f}s for {overlay_dur:.2f}s",
            )
        else:
            log("BUILD", f"    → WARNING: No audio path for seg#{seg['id']}")

    # Preserve any silent tail after the final voiced segment so outros are kept intact.
    trailing_gap = orig_total - prev
    if trailing_gap > 0.05:
        tail_file = os.path.join(tmp, "tail_outro.mp4")
        _cut(video_path, prev, orig_total, tail_file)
        if os.path.exists(tail_file) and os.path.getsize(tail_file) > 500:
            actual_tail = _actual_duration(tail_file) or trailing_gap
            parts.append(tail_file)
            cursor += actual_tail
            log("BUILD", f"  preserved trailing outro: {actual_tail:.2f}s")

    if not parts:
        raise RuntimeError("No video parts to concatenate.")

    joined = os.path.join(output_dir, "_joined.mp4")
    log("BUILD", f"Concatenating {len(parts)} parts ...")
    if not _concat(parts, joined):
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError("Concat failed.")

    joined_duration = _actual_duration(joined) or cursor
    total_ms = int(joined_duration * 1000) + 500
    speech_track = AudioSegment.silent(duration=total_ms)
    for audio_start, overlay_dur, cp, audio_mode in positions:
        try:
            tts_audio = AudioSegment.from_file(cp)
            declared_ms = int(overlay_dur * 1000)
            if len(tts_audio) > declared_ms + 100:
                tts_audio = tts_audio[:declared_ms]
            speech_track = speech_track.overlay(tts_audio, position=int(audio_start * 1000))
        except Exception as e:
            log("BUILD", f"  Audio overlay error: {e}")

    if bgm_path and os.path.exists(bgm_path) and bgm_volume > 0.01:
        bgm = AudioSegment.from_file(bgm_path)
        if len(bgm) <= 0:
            log("BUILD", "  BGM track is empty/corrupt — skipping BGM mix")
            mixed = speech_track
        else:
            if len(bgm) < total_ms:
                bgm = bgm * ((total_ms // len(bgm)) + 2)
            bgm = bgm[:total_ms] - int(20 * (1.0 - bgm_volume))
            for audio_start, overlay_dur in original_audio_ranges:
                start_ms = int(audio_start * 1000)
                end_ms = min(total_ms, start_ms + int(overlay_dur * 1000))
                if end_ms > start_ms:
                    bgm = (
                        bgm[:start_ms]
                        + AudioSegment.silent(duration=end_ms - start_ms)
                        + bgm[end_ms:]
                    )
            mixed = bgm.overlay(speech_track)
    else:
        mixed = speech_track

    wav_out = os.path.join(output_dir, "dubbed_audio.wav")
    mixed.export(wav_out, format="wav")

    r = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            joined,
            "-i",
            wav_out,
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-r",
            str(source_fps or _FPS_FALLBACK),
            "-c:a",
            "aac",
            "-shortest",
            output_path,
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if r.returncode != 0:
        raise RuntimeError(f"Audio attach failed:\n{r.stderr[-400:]}")

    shutil.rmtree(tmp, ignore_errors=True)
    try:
        os.remove(joined)
    except:
        pass
    log("BUILD", f"Done -> {output_path}")
    return output_path
