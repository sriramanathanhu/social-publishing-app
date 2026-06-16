"""Local duplicate-protection guard for publish idempotency and ambiguous outcomes."""

import contextlib
import hashlib
import json
import os
import tempfile
import threading
import time
from datetime import datetime, timedelta

GUARD_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".publish_guard.json")
GUARD_LOCK_FILE = GUARD_FILE + ".lock"

# Serialize in-process access. Cross-process safety is handled by the OS file
# lock below; this in-process lock avoids both contention and reentrancy within
# a single Python runtime (e.g., Tk UI thread + publish worker thread).
_GUARD_INPROC_LOCK = threading.RLock()

# Lazy import of platform-specific locking primitives. Wrapped in a helper so
# failure on one platform (or a sandbox without fcntl) falls back gracefully
# to in-process locking only — we still protect against the common case of
# two publish threads inside the same app.
try:  # POSIX
    import fcntl as _fcntl  # type: ignore
    _HAVE_FCNTL = True
except Exception:
    _fcntl = None
    _HAVE_FCNTL = False

try:  # Windows
    import msvcrt as _msvcrt  # type: ignore
    _HAVE_MSVCRT = True
except Exception:
    _msvcrt = None
    _HAVE_MSVCRT = False


@contextlib.contextmanager
def _file_lock(lock_path, timeout=30.0):
    """Cross-platform exclusive file lock with a soft timeout.

    Acquires the in-process RLock first (handles concurrent threads inside
    this Python process), then attempts an OS-level exclusive lock on a
    sidecar lock file (handles concurrent Python processes).
    """
    _GUARD_INPROC_LOCK.acquire()
    fh = None
    try:
        try:
            fh = open(lock_path, "a+b")
        except Exception:
            # If we can't even open the lock file (e.g., read-only FS),
            # proceed with in-process locking only. This is still safer
            # than the unlocked original behavior.
            yield
            return

        deadline = time.time() + max(0.1, float(timeout))
        acquired = False
        while True:
            try:
                if _HAVE_FCNTL:
                    _fcntl.flock(fh.fileno(), _fcntl.LOCK_EX | _fcntl.LOCK_NB)
                    acquired = True
                elif _HAVE_MSVCRT:
                    _msvcrt.locking(fh.fileno(), _msvcrt.LK_NBLCK, 1)
                    acquired = True
                else:
                    # No OS-level locking available; rely on the in-process RLock.
                    acquired = True
                break
            except (OSError, IOError):
                if time.time() >= deadline:
                    # Give up waiting for cross-process lock but still proceed
                    # under the in-process lock. Better than blocking publishing
                    # indefinitely on a stale lock file.
                    break
                time.sleep(0.05)
        try:
            yield
        finally:
            if acquired:
                try:
                    if _HAVE_FCNTL:
                        _fcntl.flock(fh.fileno(), _fcntl.LOCK_UN)
                    elif _HAVE_MSVCRT:
                        # Release the 1-byte region we locked.
                        try:
                            fh.seek(0)
                            _msvcrt.locking(fh.fileno(), _msvcrt.LK_UNLCK, 1)
                        except Exception:
                            pass
                except Exception:
                    pass
    finally:
        try:
            if fh is not None:
                fh.close()
        except Exception:
            pass
        _GUARD_INPROC_LOCK.release()
AMBIGUOUS_STATUSES = {"unconfirmed", "submitted_unconfirmed", "likely_live", "duplicate_live"}
CONFIRMED_STATUSES = {"ok", "published", "success"}
IN_PROGRESS_STATUSES = {"pending", "posting", "in_progress"}
BLOCKING_STATUSES = AMBIGUOUS_STATUSES | CONFIRMED_STATUSES | IN_PROGRESS_STATUSES
SHORT_TTL_HOURS = 36
LONG_TTL_HOURS = 24 * 7
MEDIA_REQUIRED_PLATFORMS = {
    "youtube",
    "youtube_hdh_gujarati",
    "youtube_kailaasa_gujarati",
    "instagram",
    "facebook",
    "threads",
    "twitter",
    "tiktok",
    "bluesky",
}


def _utc_now():
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _parse_utc(ts):
    try:
        return datetime.fromisoformat(str(ts or "").replace("Z", "+00:00"))
    except Exception:
        return None


def _expires_at_for_status(status):
    status_l = str(status or "").lower()
    hours = LONG_TTL_HOURS if status_l in CONFIRMED_STATUSES else SHORT_TTL_HOURS
    return (
        datetime.utcnow().replace(microsecond=0) + timedelta(hours=hours)
    ).isoformat() + "Z"


def _load_guard():
    if not os.path.exists(GUARD_FILE):
        return {}
    try:
        with open(GUARD_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_guard(data):
    """Atomically replace GUARD_FILE with the serialized guard dict.

    Writes to a temp file in the same directory, then os.replace(). This is
    crash-safe: a partial write never leaves GUARD_FILE truncated.
    """
    guard_dir = os.path.dirname(GUARD_FILE) or "."
    try:
        os.makedirs(guard_dir, exist_ok=True)
    except Exception:
        pass
    fd, tmp_path = tempfile.mkstemp(
        prefix=".publish_guard.", suffix=".tmp", dir=guard_dir
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            try:
                os.fsync(f.fileno())
            except Exception:
                pass
        os.replace(tmp_path, GUARD_FILE)
    except Exception:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise


def _sample_file_signature(path):
    if not path or not os.path.exists(path):
        return "missing"
    h = hashlib.sha256()
    size = os.path.getsize(path)
    h.update(str(size).encode("utf-8"))
    with open(path, "rb") as f:
        head = f.read(65536)
        h.update(head)
        if size > 131072:
            f.seek(max(0, size - 65536))
            h.update(f.read(65536))
    return h.hexdigest()


def _caption_for_platform(captions, platform):
    data = (captions or {}).get(platform, "")
    if isinstance(data, dict):
        title = str(data.get("title", "")).strip()
        caption = str(data.get("caption", "")).strip()
        return f"{title}\n{caption}".strip()
    return str(data or "").strip()


def _normalize_caption_text(text):
    return " ".join(str(text or "").strip().lower().split())


def _fingerprint(video_path, captions, platform):
    h = hashlib.sha256()
    h.update(str(platform or "").lower().encode("utf-8"))
    h.update(_sample_file_signature(video_path).encode("utf-8"))
    h.update(_normalize_caption_text(_caption_for_platform(captions, platform)).encode("utf-8"))
    return h.hexdigest()


def _media_fingerprint(video_path, platform):
    """Platform+media fingerprint (caption-independent) for strict duplicate platforms."""
    h = hashlib.sha256()
    h.update(str(platform or "").lower().encode("utf-8"))
    h.update(_sample_file_signature(video_path).encode("utf-8"))
    return h.hexdigest()


def _content_fingerprint(captions, platform):
    h = hashlib.sha256()
    h.update(str(platform or "").lower().encode("utf-8"))
    h.update(_normalize_caption_text(_caption_for_platform(captions, platform)).encode("utf-8"))
    return h.hexdigest()


def _purge_expired_records(guard):
    changed = False
    now = datetime.utcnow().replace(tzinfo=None)
    expired_keys = []
    for key, record in guard.items():
        if not isinstance(record, dict):
            expired_keys.append(key)
            continue
        expires_at = _parse_utc(record.get("expires_at"))
        if expires_at and expires_at.replace(tzinfo=None) < now:
            expired_keys.append(key)
    for key in expired_keys:
        guard.pop(key, None)
        changed = True
    return changed


def _get_candidate_keys(video_path, captions, platform):
    platform_l = str(platform or "").lower()
    keys = [_fingerprint(video_path, captions, platform_l)]
    if platform_l not in MEDIA_REQUIRED_PLATFORMS:
        keys.append(_content_fingerprint(captions, platform_l))
    if platform_l in {"threads", "bluesky"}:
        keys.append(_media_fingerprint(video_path, platform_l))
    seen = set()
    out = []
    for key in keys:
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out


def reserve_publish_attempt(video_path, captions, platform, note=""):
    """Create a local per-platform publish lock before the outbound API call."""
    with _file_lock(GUARD_LOCK_FILE):
        guard = _load_guard()
        changed = _purge_expired_records(guard)
        candidate_keys = _get_candidate_keys(video_path, captions, platform)
        for key in candidate_keys:
            record = guard.get(key)
            if not isinstance(record, dict):
                continue
            status = str(record.get("status", "")).lower()
            if status in BLOCKING_STATUSES:
                if changed:
                    _save_guard(guard)
                return {
                    "blocked": True,
                    "platform": platform,
                    "status": status,
                    "timestamp": record.get("timestamp", ""),
                    "note": record.get("note", ""),
                }

        payload = {
            "platform": platform,
            "status": "in_progress",
            "timestamp": _utc_now(),
            "expires_at": _expires_at_for_status("in_progress"),
            "note": note or "Reserved before outbound publish call",
        }
        for key in candidate_keys:
            guard[key] = dict(payload)
        _save_guard(guard)
        return {"blocked": False}


def find_ambiguous_repost_blocks(video_path, captions, platforms):
    with _file_lock(GUARD_LOCK_FILE):
        guard = _load_guard()
        changed = _purge_expired_records(guard)
        if changed:
            _save_guard(guard)
        blocked = []
        for platform in platforms or []:
            for key in _get_candidate_keys(video_path, captions, platform):
                record = guard.get(key)
                if not isinstance(record, dict):
                    continue
                status = str(record.get("status", "")).lower()
                if status in BLOCKING_STATUSES:
                    blocked.append(
                        {
                            "platform": platform,
                            "status": status,
                            "timestamp": record.get("timestamp", ""),
                            "note": record.get("note", ""),
                        }
                    )
                    break
        return blocked


def record_ambiguous_publish_results(video_path, captions, publish_results):
    if not isinstance(publish_results, dict):
        return
    with _file_lock(GUARD_LOCK_FILE):
        guard = _load_guard()
        changed = _purge_expired_records(guard)
        for platform, result in publish_results.items():
            if not isinstance(result, dict):
                continue
            status = str(result.get("status", "")).lower()
            candidate_keys = _get_candidate_keys(video_path, captions, platform)
            if status in BLOCKING_STATUSES:
                payload = {
                    "platform": platform,
                    "status": status,
                    "timestamp": _utc_now(),
                    "expires_at": _expires_at_for_status(status),
                    "note": result.get("error") or result.get("error_message") or "",
                }
                for key in candidate_keys:
                    guard[key] = dict(payload)
                changed = True
            elif status in {"error", "failed", "skipped", "skip"}:
                for key in candidate_keys:
                    if key in guard:
                        del guard[key]
                        changed = True
        if changed:
            _save_guard(guard)
