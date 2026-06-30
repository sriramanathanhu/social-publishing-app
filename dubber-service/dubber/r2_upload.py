"""
Upload rendered short clips to Cloudflare R2 (S3-compatible) and return their
public URL. The bucket is private; clips are served via a custom domain set as
R2_PUBLIC_BASE_URL (e.g. https://media.example.com). Config mirrors the app's
lib/r2.ts but lives here so the sidecar — which produces the files — uploads
them directly instead of streaming many clips back through the app.

Local-dev fallback: when R2 is not configured, clips are copied into
DUBBER_OUTPUT_DIR (a persistent volume) and served by this service at
``/files/<key>`` so a local deployment needs no object storage at all. The
public URL base is DUBBER_PUBLIC_BASE_URL (e.g. http://localhost:8800).
"""

from __future__ import annotations

import os
import shutil
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


def _local_base() -> str:
    """Browser-/app-reachable base for clips served by this service's /files
    mount. Defaults to localhost so a vanilla `docker compose` works."""
    base = os.environ.get("DUBBER_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not base:
        base = "http://localhost:8800"
    if not base.startswith(("http://", "https://")):
        base = f"https://{base}"
    return base


def _store_local(local_path: str, key: str) -> dict:
    """Persist a clip into DUBBER_OUTPUT_DIR (a durable volume) and return a URL
    served by this service at /files/<key>. Used when R2 isn't configured."""
    out_dir = os.environ.get("DUBBER_OUTPUT_DIR", "outputs")
    dest = os.path.join(out_dir, key)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copyfile(local_path, dest)
    log("LOCAL", f"stored {key}")
    return {"key": key, "publicUrl": f"{_local_base()}/files/{key}"}


def upload_clip(local_path: str, key: str) -> dict:
    """Store a clip under ``key`` and return {key, publicUrl}. Uploads to R2
    when configured; otherwise falls back to local disk served at /files/<key>
    (so a local deployment needs no object storage)."""
    r = _r2()
    if not r:
        return _store_local(local_path, key)
    r["client"].upload_file(
        local_path, r["bucket"], key,
        ExtraArgs={"ContentType": "video/mp4"},
    )
    log("R2", f"uploaded {key}")
    return {"key": key, "publicUrl": public_url(key)}
