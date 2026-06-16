import os, sys, subprocess, json
from .utils import log

# Invoke yt-dlp through the *current* interpreter (`python -m yt_dlp`) rather
# than a bare `yt-dlp` binary. yt-dlp is a venv dependency, so this resolves to
# the right executable no matter how the service was launched — it cannot fail
# with "No such file or directory: 'yt-dlp'" the way a PATH-dependent binary can.
_YTDLP_BASE = [sys.executable, "-m", "yt_dlp"]

# Optional authentication for sources that require login or are rate-limited for
# anonymous access (Instagram, age-gated YouTube, private posts, ...). Point
# YTDLP_COOKIES_FILE at a Netscape-format cookies.txt exported from a logged-in
# browser; yt-dlp applies each cookie to its matching domain. YTDLP_COOKIES_FROM_BROWSER
# is supported too but only works where that browser profile exists on the host.
_COOKIES_FILE_ENV = "YTDLP_COOKIES_FILE"
_COOKIES_FROM_BROWSER_ENV = "YTDLP_COOKIES_FROM_BROWSER"

# Substrings in yt-dlp's stderr that mean "this needs authentication", not a
# transient network problem — surfaced to the user as an actionable message.
_AUTH_ERROR_HINTS = (
    "login required",
    "rate-limit",
    "private",
    "cookies",
    "sign in",
    "not available",
)


def _ytdlp_auth_flags(cookies_file=None):
    """yt-dlp auth flags. A per-job cookies_file (if it exists) takes priority
    over the env-configured cookies; otherwise fall back to the env settings."""
    flags = []
    # Per-job cookies uploaded by the user win over the host-wide env file.
    if cookies_file and os.path.exists(cookies_file):
        return ["--cookies", cookies_file]
    env_cookies = os.environ.get(_COOKIES_FILE_ENV, "").strip()
    if env_cookies:
        if os.path.exists(env_cookies):
            flags += ["--cookies", env_cookies]
        else:
            log("DOWNLOAD", f"WARNING: {_COOKIES_FILE_ENV}={env_cookies} not found; continuing without cookies")
    browser = os.environ.get(_COOKIES_FROM_BROWSER_ENV, "").strip()
    if browser:
        flags += ["--cookies-from-browser", browser]
    return flags


def _direct_download(url, output_dir):
    """Stream a direct media URL to source.mp4 (used for user-uploaded files,
    which we host ourselves — no extractor or cookies needed). yt-dlp's generic
    extractor can choke on presigned S3/CDN URLs, so we fetch the bytes plainly."""
    import requests

    out_path = os.path.join(output_dir, "source.mp4")
    log("DOWNLOAD", "Direct download (uploaded file)")
    with requests.get(url, stream=True, timeout=(30, _YTDLP_DOWNLOAD_TIMEOUT_SEC)) as resp:
        if resp.status_code != 200:
            raise RuntimeError(f"Direct download failed: HTTP {resp.status_code}")
        with open(out_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                if chunk:
                    f.write(chunk)
    if not os.path.exists(out_path) or os.path.getsize(out_path) < 1000:
        raise RuntimeError("Direct download produced an empty file.")
    log("DOWNLOAD", f"Saved -> {out_path} ({os.path.getsize(out_path)} bytes)")
    return {"video_path": out_path, "source_metadata": {}}


def _looks_like_auth_error(stderr):
    low = (stderr or "").lower()
    return any(hint in low for hint in _AUTH_ERROR_HINTS)

# Hardened network flags for yt-dlp.
#
# yt-dlp's built-in defaults (20s socket timeout, 10 retries, no
# fragment-level retries, no retry sleep) are too thin for Google's CDN
# on days it routes to a slow edge node — a single stalled read kills
# the whole pipeline with "Read timed out ... Giving up after 10 retries"
# even though the rest of the fragments were fine. We bump each dial and
# add fragment-level retries so a transient stall on one chunk can't
# fail the whole download.
#
# Separately, we cap the subprocess itself at 30 minutes so a true
# network hang surfaces as a clean error instead of freezing the UI
# thread indefinitely.
_YTDLP_NETWORK_FLAGS = [
    "--socket-timeout", "60",
    "--retries", "20",
    "--fragment-retries", "20",
    "--retry-sleep", "exp=1:60",          # exponential backoff, cap 60s
    "--file-access-retries", "5",
    "--concurrent-fragments", "4",        # parallel fragments speed up slow CDN edges
    "--force-ipv4",                       # some IPv6 paths to googlevideo are slower
]
_YTDLP_METADATA_TIMEOUT_SEC = 180
_YTDLP_DOWNLOAD_TIMEOUT_SEC = 30 * 60


def is_url(s):
    return s.startswith("http://") or s.startswith("https://")

def _fetch_source_metadata(url, cookies_file=None):
    r = subprocess.run(
        [
            *_YTDLP_BASE,
            "--dump-single-json",
            "--no-playlist",
            "--no-warnings",
            *_ytdlp_auth_flags(cookies_file),
            *_YTDLP_NETWORK_FLAGS,
            url,
        ],
        capture_output=True,
        text=True,
        timeout=_YTDLP_METADATA_TIMEOUT_SEC,
    )
    if r.returncode != 0:
        raise RuntimeError(f"yt-dlp metadata fetch failed:\n{r.stderr[-600:]}")
    raw = json.loads(r.stdout or "{}")
    return {
        "title": raw.get("title") or "",
        "description": raw.get("description") or "",
        "tags": raw.get("tags") or [],
        "webpage_url": raw.get("webpage_url") or url,
        "uploader": raw.get("uploader") or "",
        "extractor": raw.get("extractor_key") or raw.get("extractor") or "",
        "is_live": bool(raw.get("is_live")),
        "was_live": bool(raw.get("was_live")),
        "availability": raw.get("availability") or "",
        "source_url": url,
    }


def download_video(url, output_dir="workspace", source_type="url", cookies_file=None):
    os.makedirs(output_dir, exist_ok=True)
    # User-uploaded files are hosted by us as a direct media URL — fetch the
    # bytes plainly instead of going through yt-dlp's extractors/cookies.
    if source_type and source_type != "url":
        return _direct_download(url, output_dir)

    out_path = os.path.join(output_dir, "source.mp4")
    metadata_path = os.path.join(output_dir, "source_metadata.json")
    log("DOWNLOAD", f"Fetching {url}")
    source_metadata = {}
    try:
        source_metadata = _fetch_source_metadata(url, cookies_file)
        with open(metadata_path, "w", encoding="utf-8") as f:
            json.dump(source_metadata, f, ensure_ascii=False, indent=2)
        log(
            "DOWNLOAD",
            f"Metadata -> extractor={source_metadata.get('extractor', '?')} title={source_metadata.get('title', '')[:80]}",
        )
    except subprocess.TimeoutExpired:
        log("DOWNLOAD", "Metadata fetch timed out after 3 min; continuing with media download.")
    except Exception as e:
        log("DOWNLOAD", f"Metadata fetch failed, continuing with media download: {e}")

    try:
        r = subprocess.run(
            [
                *_YTDLP_BASE,
                "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
                "--merge-output-format", "mp4",
                "-o", out_path,
                "--no-playlist",
                *_ytdlp_auth_flags(cookies_file),
                *_YTDLP_NETWORK_FLAGS,
                url,
            ],
            capture_output=True,
            text=True,
            timeout=_YTDLP_DOWNLOAD_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(
            f"yt-dlp download exceeded {_YTDLP_DOWNLOAD_TIMEOUT_SEC // 60} min and was killed. "
            "Network or CDN is very slow — try again, or download the video manually and "
            "pass the local file path instead."
        ) from e

    if r.returncode != 0:
        # Distinguish "this source needs login" from a transient failure so the
        # user knows to supply cookies rather than just retrying forever.
        if _looks_like_auth_error(r.stderr) and not _ytdlp_auth_flags(cookies_file):
            raise RuntimeError(
                "This source requires authentication (login required or rate-limited "
                "for anonymous access — common for Instagram/YouTube on a server IP). "
                "Upload a cookies.txt for this platform in Settings → Service keys, or "
                "use the Upload tab to dub a local file instead.\n"
                f"yt-dlp said:\n{r.stderr[-400:]}"
            )
        raise RuntimeError(f"yt-dlp failed:\n{r.stderr[-600:]}")
    log("DOWNLOAD", f"Saved -> {out_path}")
    return {
        "video_path": out_path,
        "source_metadata": source_metadata,
    }
