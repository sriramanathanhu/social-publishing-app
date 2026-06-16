import os, subprocess, json
from .utils import log

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

def _fetch_source_metadata(url):
    r = subprocess.run(
        [
            "yt-dlp",
            "--dump-single-json",
            "--no-playlist",
            "--no-warnings",
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


def download_video(url, output_dir="workspace"):
    os.makedirs(output_dir, exist_ok=True)
    out_path = os.path.join(output_dir, "source.mp4")
    metadata_path = os.path.join(output_dir, "source_metadata.json")
    log("DOWNLOAD", f"Fetching {url}")
    source_metadata = {}
    try:
        source_metadata = _fetch_source_metadata(url)
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
                "yt-dlp",
                "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
                "--merge-output-format", "mp4",
                "-o", out_path,
                "--no-playlist",
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
        raise RuntimeError(f"yt-dlp failed:\n{r.stderr[-600:]}")
    log("DOWNLOAD", f"Saved -> {out_path}")
    return {
        "video_path": out_path,
        "source_metadata": source_metadata,
    }
