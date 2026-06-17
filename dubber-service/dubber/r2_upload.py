"""
Upload rendered short clips to Cloudflare R2 (S3-compatible) and return their
public URL. The bucket is private; clips are served via a custom domain set as
R2_PUBLIC_BASE_URL (e.g. https://media.example.com). Config mirrors the app's
lib/r2.ts but lives here so the sidecar — which produces the files — uploads
them directly instead of streaming many clips back through the app.
"""

from __future__ import annotations

import os
import threading

from .utils import log

_client = None
_lock = threading.Lock()


def _r2():
    global _client
    if _client is not None:
        return _client
    with _lock:
        if _client is not None:
            return _client
        endpoint = os.environ.get("R2_ENDPOINT")
        key = os.environ.get("R2_ACCESS_KEY_ID")
        secret = os.environ.get("R2_SECRET_ACCESS_KEY")
        bucket = os.environ.get("R2_BUCKET")
        if not (endpoint and key and secret and bucket):
            return None
        import boto3
        from botocore.config import Config

        _client = {
            "bucket": bucket,
            "client": boto3.client(
                "s3",
                endpoint_url=endpoint,
                aws_access_key_id=key,
                aws_secret_access_key=secret,
                region_name="auto",
                config=Config(signature_version="s3v4"),
            ),
        }
        return _client


def r2_enabled() -> bool:
    return _r2() is not None


def public_url(key: str) -> str | None:
    base = os.environ.get("R2_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not base:
        return None
    if not base.startswith(("http://", "https://")):
        base = f"https://{base}"
    return f"{base}/{key}"


def upload_clip(local_path: str, key: str) -> dict:
    """Upload a clip to R2 under ``key``. Returns {key, publicUrl}. Raises if
    R2 isn't configured (Phase 1 stores clips in R2 — config is required)."""
    r = _r2()
    if not r:
        raise RuntimeError(
            "R2 is not configured (R2_ENDPOINT/R2_BUCKET/R2_ACCESS_KEY_ID/"
            "R2_SECRET_ACCESS_KEY) — required to store shorts clips."
        )
    r["client"].upload_file(
        local_path, r["bucket"], key,
        ExtraArgs={"ContentType": "video/mp4"},
    )
    log("R2", f"uploaded {key}")
    return {"key": key, "publicUrl": public_url(key)}
