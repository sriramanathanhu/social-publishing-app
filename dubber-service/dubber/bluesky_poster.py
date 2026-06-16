"""Direct Bluesky posting helper."""

import os
import subprocess
import tempfile

from .config import load_env_into_process
from .utils import log


def _video_dimensions(path):
    """Return (width, height) from ffprobe, or None."""
    if not path or not os.path.exists(path):
        return None
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0:s=x",
                path,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        line = (result.stdout or "").strip()
        if "x" in line:
            w, _, h = line.partition("x")
            return int(w), int(h)
    except Exception:
        pass
    return None


def _compress_video_for_bluesky(src_path, max_mb=50):
    """Compress video to fit under Bluesky's size limit. Returns compressed path or None."""
    file_size_mb = os.path.getsize(src_path) / (1024 * 1024)
    log(
        "BLUESKY",
        f"  Video too large ({file_size_mb:.1f} MB) — compressing for Bluesky...",
    )

    out_path = src_path.replace(".mp4", "_bluesky_compressed.mp4")

    # Step 1: Try moderate compression — 720p, CRF 28
    cmds = [
        # First attempt: 720p, CRF 28
        [
            "ffmpeg",
            "-y",
            "-i",
            src_path,
            "-vf",
            "scale=-2:720",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "28",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-movflags",
            "+faststart",
            out_path,
        ],
        # Second attempt: 480p, CRF 30 (more aggressive)
        [
            "ffmpeg",
            "-y",
            "-i",
            src_path,
            "-vf",
            "scale=-2:480",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "30",
            "-c:a",
            "aac",
            "-b:a",
            "64k",
            "-movflags",
            "+faststart",
            out_path,
        ],
    ]

    for i, cmd in enumerate(cmds):
        log("BLUESKY", f"  Compression attempt {i + 1}: {' '.join(cmd[3:8])}...")
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if r.returncode != 0 or not os.path.exists(out_path):
            log("BLUESKY", f"  Compression attempt {i + 1} failed")
            continue

        compressed_mb = os.path.getsize(out_path) / (1024 * 1024)
        log("BLUESKY", f"  Compressed to {compressed_mb:.1f} MB")

        if compressed_mb <= max_mb:
            log("BLUESKY", f"  Compression successful — under {max_mb} MB limit")
            return out_path

    # All attempts failed — clean up
    try:
        os.remove(out_path)
    except OSError:
        pass
    log("BLUESKY", f"  Could not compress under {max_mb} MB — will post text-only")
    return None


load_env_into_process()


class BlueskyPoster:
    def __init__(self):
        handle = os.getenv("BLUESKY_HANDLE")
        password = os.getenv("BLUESKY_APP_PASSWORD")
        self.client = None
        self.enabled = False

        try:
            import httpx
            from atproto import Client, Request
        except Exception as exc:
            log(
                "BLUESKY",
                f"atproto not installed — skipping direct Bluesky publish: {exc}",
            )
            return

        if not handle or not password:
            log(
                "BLUESKY",
                "Missing BLUESKY_HANDLE or BLUESKY_APP_PASSWORD — skipping direct Bluesky publish.",
            )
            return

        try:
            # Default httpx timeouts are too low for multi‑MiB video blob uploads to the PDS.
            long_timeout = httpx.Timeout(
                connect=60.0, read=600.0, write=600.0, pool=60.0
            )
            client = Client(request=Request(timeout=long_timeout))
            client.login(handle, password)
            self.client = client
            self.enabled = True
            log("BLUESKY", f"Logged in as {handle}")
        except Exception as exc:
            log("BLUESKY", f"Login failed — skipping direct Bluesky publish: {exc}")

    def post(self, text, image_paths=None, image_alt="", video_path=None):
        if not self.enabled or not self.client:
            raise RuntimeError("BlueskyPoster is not available")
        text = str(text or "").strip()
        from atproto import models

        if video_path and os.path.exists(video_path):
            actual_video_path = video_path
            compressed_path = None
            file_size_mb = os.path.getsize(video_path) / (1024 * 1024)

            # Bluesky PDS typically rejects payloads > 50 MB
            if file_size_mb > 50:
                compressed_path = _compress_video_for_bluesky(video_path, max_mb=50)
                if compressed_path and os.path.exists(compressed_path):
                    actual_video_path = compressed_path
                    dims = _video_dimensions(compressed_path) or _video_dimensions(
                        video_path
                    )
                else:
                    # Compression failed — post text-only
                    log(
                        "BLUESKY",
                        "  Video too large even after compression — posting text-only",
                    )
                    return self.client.send_post(text=text)
            else:
                dims = _video_dimensions(video_path)

            with open(actual_video_path, "rb") as f:
                video_bytes = f.read()

            if dims:
                ar = models.AppBskyEmbedDefs.AspectRatio(width=dims[0], height=dims[1])
            else:
                ar = models.AppBskyEmbedDefs.AspectRatio(width=16, height=9)
            log(
                "BLUESKY",
                f"Posting with video ({len(video_bytes) // 1024 // 1024} MiB approx.)",
            )
            try:
                return self.client.send_video(
                    text=text,
                    video=video_bytes,
                    video_alt=image_alt or "Video",
                    video_aspect_ratio=ar,
                )
            finally:
                # Clean up compressed file
                if compressed_path and os.path.exists(compressed_path):
                    try:
                        os.remove(compressed_path)
                        log("BLUESKY", "  Cleaned up compressed video")
                    except OSError:
                        pass

        valid_images = [
            path for path in (image_paths or []) if path and os.path.exists(path)
        ]
        if not valid_images:
            return self.client.send_post(text=text)

        image_bytes = []
        for path in valid_images[:4]:
            with open(path, "rb") as f:
                image_bytes.append(f.read())

        if len(image_bytes) == 1:
            return self.client.send_image(
                text=text, image=image_bytes[0], image_alt=image_alt or "Flyer image"
            )

        image_alts = [(image_alt or "Flyer image")] * len(image_bytes)
        return self.client.send_images(
            text=text, images=image_bytes, image_alts=image_alts
        )


_BLUESKY_POSTER = None


def get_bluesky_poster():
    global _BLUESKY_POSTER
    if _BLUESKY_POSTER is None:
        _BLUESKY_POSTER = BlueskyPoster()
    return _BLUESKY_POSTER
