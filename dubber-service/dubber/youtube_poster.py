"""Direct YouTube publishing helpers."""

import os
from pathlib import Path

from .utils import log

YOUTUBE_UPLOAD_SCOPE = ["https://www.googleapis.com/auth/youtube.upload"]
TOKEN_DIR = Path(__file__).resolve().parent.parent / ".youtube_tokens"

YOUTUBE_ACCOUNT_CONFIGS = {
    "youtube_hdh_gujarati": {
        "label": "YouTube (HDH Gujarati)",
        "client_id_env": "YOUTUBE_HDH_GUJARATI_CLIENT_ID",
        "client_secret_env": "YOUTUBE_HDH_GUJARATI_CLIENT_SECRET",
        "token_file": "youtube_hdh_gujarati_token.json",
    },
    "youtube_kailaasa_gujarati": {
        "label": "YouTube (Kailaasa Gujarati)",
        "client_id_env": "YOUTUBE_KAILAASA_GUJARATI_CLIENT_ID",
        "client_secret_env": "YOUTUBE_KAILAASA_GUJARATI_CLIENT_SECRET",
        "token_file": "youtube_kailaasa_gujarati_token.json",
    },
}


def get_selected_youtube_targets(selected_platforms):
    if "youtube" not in (selected_platforms or []):
        return []
    return list(YOUTUBE_ACCOUNT_CONFIGS.keys())


def _get_account_config(alias):
    config = YOUTUBE_ACCOUNT_CONFIGS.get(alias, {})
    client_id = str(os.getenv(config.get("client_id_env", ""), "")).strip()
    client_secret = str(os.getenv(config.get("client_secret_env", ""), "")).strip()
    merged = dict(config)
    merged["client_id"] = client_id
    merged["client_secret"] = client_secret
    return merged


def _build_client_config(client_id, client_secret):
    return {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }


def _get_credentials(alias, account_config):
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
    except Exception as exc:
        raise RuntimeError(
            "Missing YouTube dependencies. Install google-api-python-client, google-auth-oauthlib, and google-auth-httplib2."
        ) from exc

    client_id = account_config.get("client_id", "")
    client_secret = account_config.get("client_secret", "")
    if not client_id or not client_secret:
        raise RuntimeError(f"Missing OAuth credentials for {account_config.get('label', alias)}")

    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    token_path = TOKEN_DIR / account_config["token_file"]
    creds = None

    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), YOUTUBE_UPLOAD_SCOPE)

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())

    if not creds or not creds.valid:
        log("YOUTUBE", f"OAuth login required for {account_config.get('label', alias)}")
        flow = InstalledAppFlow.from_client_config(
            _build_client_config(client_id, client_secret),
            YOUTUBE_UPLOAD_SCOPE,
        )
        creds = flow.run_local_server(port=0, authorization_prompt_message="")
        token_path.write_text(creds.to_json(), encoding="utf-8")
        log("YOUTUBE", f"Saved token -> {token_path.name}")

    return creds


def _build_youtube_service(alias, account_config):
    try:
        from googleapiclient.discovery import build
    except Exception as exc:
        raise RuntimeError(
            "Missing YouTube dependencies. Install google-api-python-client."
        ) from exc

    creds = _get_credentials(alias, account_config)
    return build("youtube", "v3", credentials=creds)


def _normalize_title(title, fallback_title):
    candidate = (str(title or "").strip() or str(fallback_title or "").strip() or "AutoDub upload").strip()
    return candidate[:100].rstrip()


def _normalize_description(description):
    return str(description or "").strip()[:5000]


def publish_direct_youtube(alias, video_path, title, description, publish_now=True):
    account_config = _get_account_config(alias)
    label = account_config.get("label", alias)

    if not video_path or not os.path.exists(video_path):
        return {
            "status": "error",
            "platform": alias,
            "error": "YouTube upload skipped: local video file is missing.",
            "error_message": "YouTube upload skipped: local video file is missing.",
        }

    if not account_config.get("client_id") or not account_config.get("client_secret"):
        msg = f"Missing OAuth client ID/secret for {label}."
        log("YOUTUBE", msg)
        return {
            "status": "error",
            "platform": alias,
            "error": msg,
            "error_message": msg,
        }

    try:
        from googleapiclient.http import MediaFileUpload
        from googleapiclient.errors import HttpError, ResumableUploadError
    except Exception as exc:
        msg = "Missing googleapiclient dependency for direct YouTube publishing."
        log("YOUTUBE", f"{msg} {exc}")
        return {
            "status": "error",
            "platform": alias,
            "error": msg,
            "error_message": msg,
        }

    try:
        service = _build_youtube_service(alias, account_config)
        body = {
            "snippet": {
                "title": _normalize_title(title, Path(video_path).stem),
                "description": _normalize_description(description),
                "categoryId": "22",
            },
            "status": {
                "privacyStatus": "public" if publish_now else "private",
                "selfDeclaredMadeForKids": False,
            },
        }
        media = MediaFileUpload(video_path, chunksize=-1, resumable=True)
        request = service.videos().insert(
            part="snippet,status",
            body=body,
            media_body=media,
        )

        # Resumable upload loop with bounded retries.
        # - `num_retries=5` asks googleapiclient to handle transient 5xx/429
        #   with internal exponential backoff per chunk.
        # - We still wrap in our own outer retry in case something slips through
        #   (e.g., connection reset between chunks).
        # - A hard iteration cap prevents an infinite loop if next_chunk ever
        #   returns (status, None) indefinitely without raising.
        import time as _time
        import socket as _socket

        RETRYABLE_HTTP_STATUS = {500, 502, 503, 504, 408, 429}
        MAX_OUTER_RETRIES = 5
        # chunksize=-1 means single chunk, so we should never loop more than
        # a small number of iterations even for large files. 2048 is paranoid.
        MAX_TOTAL_ITERATIONS = 2048

        response = None
        outer_attempt = 0
        iterations = 0
        while response is None:
            iterations += 1
            if iterations > MAX_TOTAL_ITERATIONS:
                raise RuntimeError(
                    f"YouTube upload exceeded {MAX_TOTAL_ITERATIONS} chunk iterations without completion."
                )
            try:
                status, response = request.next_chunk(num_retries=5)
                if status is not None:
                    try:
                        pct = int(status.progress() * 100)
                        log("YOUTUBE", f"{label} upload progress: {pct}%")
                    except Exception:
                        pass
            except ResumableUploadError as exc:
                # Non-retryable resumable-protocol error (e.g., 4xx from Google).
                raise RuntimeError(f"YouTube resumable upload failed: {exc}") from exc
            except HttpError as exc:
                status_code = getattr(getattr(exc, "resp", None), "status", None)
                if status_code in RETRYABLE_HTTP_STATUS and outer_attempt < MAX_OUTER_RETRIES:
                    outer_attempt += 1
                    backoff = min(60, 2 ** outer_attempt)
                    log(
                        "YOUTUBE",
                        f"{label} transient HTTP {status_code}; retry {outer_attempt}/{MAX_OUTER_RETRIES} in {backoff}s",
                    )
                    _time.sleep(backoff)
                    continue
                raise
            except (_socket.timeout, ConnectionError, OSError) as exc:
                if outer_attempt < MAX_OUTER_RETRIES:
                    outer_attempt += 1
                    backoff = min(60, 2 ** outer_attempt)
                    log(
                        "YOUTUBE",
                        f"{label} transient network error ({type(exc).__name__}); retry {outer_attempt}/{MAX_OUTER_RETRIES} in {backoff}s",
                    )
                    _time.sleep(backoff)
                    continue
                raise

        video_id = str((response or {}).get("id") or "").strip()
        if not video_id:
            raise RuntimeError("YouTube API response did not include a video ID.")

        video_url = f"https://www.youtube.com/watch?v={video_id}"
        log("YOUTUBE", f"{label} upload successful: {video_id}")
        return {
            "status": "ok",
            "platform": alias,
            "post_id": video_id,
            "url": video_url,
        }
    except Exception as exc:
        log("YOUTUBE", f"{label} upload failed: {exc}")
        return {
            "status": "error",
            "platform": alias,
            "error": str(exc),
            "error_message": str(exc),
        }
