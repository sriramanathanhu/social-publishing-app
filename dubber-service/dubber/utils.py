import datetime
import json
import os
import subprocess
import sys
import glob
import logging
from logging.handlers import RotatingFileHandler
from dubber.config import get_platform_accounts

# Sentinel when source fps cannot be probed; preserves historical default
# behavior instead of leaving -r unset (which can produce VFR on ffmpeg).
FPS_FALLBACK = "30"

_LOG_SUBSCRIBERS = []
_FILE_LOGGER = None
_LOG_DIR = None
_API_CALL_COUNTS = {"gemini": 0, "nvidia": 0, "glm": 0, "total": 0}


def get_log_dir():
    """Get the logs directory path."""
    global _LOG_DIR
    if _LOG_DIR is None:
        _LOG_DIR = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs"
        )
    return _LOG_DIR


def _init_file_logger():
    """Initialize rotating file logger with 7-day retention."""
    global _FILE_LOGGER, _LOG_DIR, _API_CALL_COUNTS

    log_dir = get_log_dir()
    os.makedirs(log_dir, exist_ok=True)

    today = datetime.date.today().strftime("%Y%m%d")
    log_file = os.path.join(log_dir, f"dubber_{today}.log")

    _FILE_LOGGER = logging.getLogger("dubber")
    _FILE_LOGGER.setLevel(logging.INFO)

    if not _FILE_LOGGER.handlers:
        handler = RotatingFileHandler(
            log_file, maxBytes=10 * 1024 * 1024, backupCount=7, encoding="utf-8"
        )
        formatter = logging.Formatter(
            "%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S"
        )
        handler.setFormatter(formatter)
        _FILE_LOGGER.addHandler(handler)

    _API_CALL_COUNTS = {"gemini": 0, "nvidia": 0, "glm": 0, "total": 0}
    _clean_old_logs(log_dir, keep_days=7)

    return log_file


def _clean_old_logs(log_dir, keep_days=7):
    """Remove log files older than keep_days."""
    try:
        pattern = os.path.join(log_dir, "dubber_*.log")
        for log_file in glob.glob(pattern):
            file_time = os.path.getmtime(log_file)
            file_date = datetime.datetime.fromtimestamp(file_time).date()
            if (datetime.date.today() - file_date).days > keep_days:
                try:
                    os.remove(log_file)
                except Exception:
                    pass
    except Exception:
        pass


def track_api_call(provider="gemini"):
    """Track an API call attempt."""
    global _API_CALL_COUNTS
    provider = provider.lower()
    if provider in _API_CALL_COUNTS:
        _API_CALL_COUNTS[provider] += 1
        _API_CALL_COUNTS["total"] += 1


def track_api_success(provider="gemini"):
    """Track a successful API call (increments success counter)."""
    global _API_CALL_COUNTS
    provider = provider.lower()
    if f"{provider}_success" not in _API_CALL_COUNTS:
        _API_CALL_COUNTS[f"{provider}_success"] = 0
    _API_CALL_COUNTS[f"{provider}_success"] += 1


def get_api_call_counts():
    """Return current API call counts."""
    return _API_CALL_COUNTS.copy()


def reset_api_call_counts():
    """Reset API call counts (typically called at start of new pipeline run)."""
    global _API_CALL_COUNTS
    _API_CALL_COUNTS = {"gemini": 0, "nvidia": 0, "glm": 0, "total": 0}


def add_log_subscriber(callback):
    if callback and callback not in _LOG_SUBSCRIBERS:
        _LOG_SUBSCRIBERS.append(callback)


def remove_log_subscriber(callback):
    if callback in _LOG_SUBSCRIBERS:
        _LOG_SUBSCRIBERS.remove(callback)


def log(tag, msg):
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] [{tag:<12}] {msg}"

    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "utf-8"
        safe = line.encode(enc, errors="replace").decode(enc, errors="replace")
        print(safe, flush=True)

    if _FILE_LOGGER:
        _FILE_LOGGER.info(f"[{tag}] {msg}")

    for callback in list(_LOG_SUBSCRIBERS):
        try:
            callback(line=line, tag=tag, msg=msg)
        except Exception:
            continue


def get_recent_logs(lines=100):
    """Return last N lines of current log file."""
    log_dir = get_log_dir()
    today = datetime.date.today().strftime("%Y%m%d")
    log_file = os.path.join(log_dir, f"dubber_{today}.log")

    if not os.path.exists(log_file):
        return []

    try:
        with open(log_file, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()
        return [l.strip() for l in all_lines[-lines:]]
    except Exception:
        return []


def count_api_calls_from_logs(log_file=None):
    """Count API calls from a specific log file or today's log."""
    if log_file is None:
        log_dir = get_log_dir()
        today = datetime.date.today().strftime("%Y%m%d")
        log_file = os.path.join(log_dir, f"dubber_{today}.log")

    if not os.path.exists(log_file):
        return {"gemini": 0, "nvidia": 0, "glm": 0, "total": 0}

    counts = {"gemini": 0, "nvidia": 0, "glm": 0, "total": 0}

    try:
        with open(log_file, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line_lower = line.lower()
                if (
                    "gemini" in line_lower
                    or "[TRANSLATE" in line
                    or "[VISION" in line
                    or "[TEASER" in line
                    or "[CAPTION" in line
                ):
                    if "api call" in line_lower or "gemini" in line_lower:
                        counts["gemini"] += 1
                        counts["total"] += 1
                elif "nvidia" in line_lower:
                    counts["nvidia"] += 1
                    counts["total"] += 1
                elif "glm" in line_lower or "bigmodel" in line_lower:
                    counts["glm"] += 1
                    counts["total"] += 1
    except Exception:
        pass

    return counts


# Standardized platform definitions
PLATFORMS = [
    "instagram",
    "facebook",
    "youtube",
    "threads",
    "twitter",
    "tiktok",
    "bluesky",
]

# Real platform hard limits (character counts)
PLATFORM_LIMITS = {
    "instagram": 2200,
    "facebook": 63206,
    "threads": 500,
    "bluesky": 300,
    "twitter": 280,
    "tiktok": 2200,
    "youtube": 5000,
}

# Optimal engagement ranges — captions should target these, not get truncated at them
SHORT_MINIMUMS = {"tiktok": 120, "twitter": 80, "threads": 160, "bluesky": 80}

# Optimal engagement ranges for warning system (min, max)
# Adjusted to balance engagement optimization with content preservation
OPTIMAL_RANGES = {
    "twitter": (100, 280),  # Twitter now supports longer posts (280 chars)
    "threads": (160, 300),  # Moderate length
    "bluesky": (100, 200),  # Moderate length
    "instagram": (80, 500),  # Expanded - supports bullet-rich posts
    "tiktok": (120, 250),  # Short form
    "facebook": (30, 600),  # Expanded - supports long devotional posts
    "youtube": (120, 800),  # Expanded - supports structured teachings
}

REQUIRED_PLATFORMS = {
    "instagram",
    "facebook",
    "tiktok",
    "twitter",
    "youtube",
    "threads",
    "bluesky",
}

# Zernio platform account IDs come from environment variables.
# Public repo defaults intentionally remain empty.
PLATFORM_ACCOUNTS = get_platform_accounts()


def _validate_fps(fps):
    """Return a ffmpeg-acceptable fps string, or None if the shape is bad.

    ffprobe emits r_frame_rate as a fraction like "30/1" or "30000/1001"
    (23.976 fps). ffmpeg's -r consumes that format natively, so we keep the
    raw fraction instead of evaluating it and losing precision. Bare ints
    are also accepted.
    """
    fps = (fps or "").strip()
    if not fps:
        return None
    if "/" in fps:
        num, _, den = fps.partition("/")
        if num.isdigit() and den.isdigit() and int(num) > 0 and int(den) > 0:
            return fps
        return None
    if fps.isdigit() and int(fps) > 0:
        return fps
    return None


def ffprobe_info(path, timeout=30):
    """Return {'duration': float|None, 'fps': str|None} in one ffprobe call.

    Batching duration + fps into a single subprocess saves one launch per
    video build (~30-50 ms) vs calling them separately. JSON output is the
    most reliable parse surface — the `default=` format co-mingles values
    from multiple sections.

    Both keys are always present; either may be None on probe failure, so
    callers can decide how to react per-field.
    """
    try:
        r = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "format=duration:stream=r_frame_rate",
                "-of",
                "json",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except Exception:
        return {"duration": None, "fps": None}

    stdout = (r.stdout or "").strip()
    if not stdout:
        return {"duration": None, "fps": None}
    try:
        payload = json.loads(stdout)
    except Exception:
        return {"duration": None, "fps": None}

    duration = None
    try:
        fmt = payload.get("format") or {}
        raw = fmt.get("duration")
        if raw is not None:
            duration = float(raw)
    except Exception:
        duration = None

    fps = None
    try:
        streams = payload.get("streams") or []
        if streams:
            fps = _validate_fps(str(streams[0].get("r_frame_rate", "")))
    except Exception:
        fps = None

    return {"duration": duration, "fps": fps}


def ffprobe_duration(path):
    """Return the media duration in seconds, or raise RuntimeError on failure.

    Backs the historic private `_ffprobe_duration` signature the rest of the
    codebase relies on (it treats unreadable probes as a hard error).
    """
    info = ffprobe_info(path)
    if info["duration"] is None:
        raise RuntimeError(f"ffprobe failed for: {path}")
    return info["duration"]


def ffprobe_fps(path):
    """Return video frame rate string (e.g. '30000/1001'), or FPS_FALLBACK."""
    info = ffprobe_info(path)
    return info["fps"] or FPS_FALLBACK

# Platform-specific teaser generation specs
PLATFORM_SPECS = {
    "instagram": {
        "min": 15,
        "max": 29,
        "strategy": "hook_moment",
        "label": "Instagram Reels",
    },
    "tiktok": {"min": 7, "max": 15, "strategy": "fastest_moment", "label": "TikTok"},
    "youtube": {
        "min": 20,
        "max": 59,
        "strategy": "peak_moment",
        "label": "YouTube Shorts",
    },
    "facebook": {
        "min": 15,
        "max": 44,
        "strategy": "emotional_hook",
        "label": "Facebook",
    },
    "twitter": {
        "min": 7,
        "max": 14,
        "strategy": "fastest_moment",
        "label": "Twitter/X",
    },
    "threads": {"min": 15, "max": 30, "strategy": "hook_moment", "label": "Threads"},
    "bluesky": {"min": 10, "max": 20, "strategy": "hook_moment", "label": "Bluesky"},
}
