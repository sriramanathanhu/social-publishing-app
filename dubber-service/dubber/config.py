"""Shared environment/config helpers for runtime modules."""

import os
from pathlib import Path
from typing import Dict

ENV_FILE = ".env"

PLATFORM_ACCOUNT_ENV_MAP = {
    "instagram": "ZERNIO_INSTAGRAM_ACCOUNT_ID",
    "facebook": "ZERNIO_FACEBOOK_ACCOUNT_ID",
    "threads": "ZERNIO_THREADS_ACCOUNT_ID",
    "twitter": "ZERNIO_TWITTER_ACCOUNT_ID",
    "tiktok": "ZERNIO_TIKTOK_ACCOUNT_ID",
    "bluesky": "ZERNIO_BLUESKY_ACCOUNT_ID",
}


def _clean(value):
    if value is None:
        return ""
    return str(value).strip()


def read_env_file(path=ENV_FILE) -> Dict[str, str]:
    env = {}
    env_path = Path(path)
    if not env_path.exists():
        return env

    try:
        from dotenv import dotenv_values

        parsed = dotenv_values(env_path)
        for key, value in parsed.items():
            key = str(key or "").strip()
            value = _clean(value)
            if key and value:
                env[key] = value
        return env
    except Exception:
        pass

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key and value:
            env[key] = value
    return env


def sync_process_env(values: Dict[str, str]) -> None:
    for key, value in values.items():
        clean_key = _clean(key)
        clean_value = _clean(value)
        if clean_key and clean_value:
            os.environ[clean_key] = clean_value


def load_env_into_process(path=ENV_FILE) -> Dict[str, str]:
    env = read_env_file(path)
    sync_process_env(env)
    return env


def save_env_updates(updates: Dict[str, str], path=ENV_FILE) -> Dict[str, str]:
    merged = read_env_file(path)
    for key, value in updates.items():
        clean_key = _clean(key)
        clean_value = _clean(value)
        if clean_key and clean_value:
            merged[clean_key] = clean_value

    env_path = Path(path)
    existing_lines = []
    if env_path.exists():
        existing_lines = env_path.read_text(encoding="utf-8").splitlines()

    emitted = set()
    output_lines = []
    for raw_line in existing_lines:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#") or "=" not in raw_line:
            output_lines.append(raw_line)
            continue
        key, _ = raw_line.split("=", 1)
        clean_key = key.strip()
        if clean_key in merged:
            output_lines.append(f"{clean_key}={merged[clean_key]}")
            emitted.add(clean_key)
        else:
            output_lines.append(raw_line)

    missing_keys = [key for key in sorted(merged.keys()) if key not in emitted]
    if missing_keys and output_lines and output_lines[-1].strip():
        output_lines.append("")
    for key in missing_keys:
        output_lines.append(f"{key}={merged[key]}")

    env_path.write_text("\n".join(output_lines).rstrip() + "\n", encoding="utf-8")
    sync_process_env(merged)
    return merged


def first_env(*names, default="") -> str:
    for name in names:
        value = _clean(os.getenv(name))
        if value:
            return value
    return default


def get_gemini_api_key(explicit=None) -> str:
    explicit_value = _clean(explicit)
    if explicit_value:
        return explicit_value
    return first_env("GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_VISION_KEY")


def get_gemini_api_keys() -> list:
    """Return all configured Gemini API keys in priority order.

    Starts with the primary key (``get_gemini_api_key()``), then appends
    ``GEMINI_API_KEY_1`` through ``GEMINI_API_KEY_10``. Duplicates are
    removed while preserving order. Used by the translator to rotate on
    per-key quota exhaustion — free-tier Gemini is capped at 20
    requests/day/project, so each extra key effectively extends the daily
    translation budget by another 20.
    """
    keys = []
    seen = set()

    def _add(candidate):
        cleaned = _clean(candidate)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            keys.append(cleaned)

    _add(get_gemini_api_key())
    for idx in range(1, 11):
        _add(os.getenv(f"GEMINI_API_KEY_{idx}"))
    return keys


# Runtime rotation state. Callers import and mutate these via the helpers
# below; keep the set here so both translator and vision paths see a shared
# view of which keys have been burned today.
_gemini_exhausted_keys: set = set()


def mark_gemini_key_exhausted(key: str) -> None:
    """Record that the given key has hit its daily quota.

    No-op on empty keys. Idempotent — safe to call multiple times.
    """
    cleaned = _clean(key)
    if cleaned:
        _gemini_exhausted_keys.add(cleaned)


def get_active_gemini_api_key() -> str:
    """Return the first non-exhausted Gemini key, or ``""`` if all exhausted."""
    for candidate in get_gemini_api_keys():
        if candidate not in _gemini_exhausted_keys:
            return candidate
    return ""


def reset_gemini_key_rotation() -> None:
    """Clear the exhausted-key tracking. Called at the start of each run."""
    _gemini_exhausted_keys.clear()


def gemini_key_rotation_stats() -> dict:
    """Return a snapshot of rotation state for diagnostic logging."""
    total = len(get_gemini_api_keys())
    exhausted = len(_gemini_exhausted_keys)
    return {
        "total_keys": total,
        "exhausted_keys": exhausted,
        "remaining_keys": max(0, total - exhausted),
    }


def get_glm_api_key(explicit=None) -> str:
    explicit_value = _clean(explicit)
    if explicit_value:
        return explicit_value
    return first_env("GLM_API_KEY")


def get_glm_base_url(explicit=None) -> str:
    explicit_value = _clean(explicit)
    if explicit_value:
        return explicit_value
    return first_env("GLM_BASE_URL", default="https://api.modal.com/v1/glm-5")


def get_glm_model(explicit=None) -> str:
    explicit_value = _clean(explicit)
    if explicit_value:
        return explicit_value
    return first_env("GLM_MODEL", default="zai-org/GLM-5.1-FP8")


def get_glm_max_tokens(explicit=None) -> int:
    explicit_value = _clean(explicit)
    if explicit_value:
        try:
            return max(1, int(explicit_value))
        except Exception:
            pass
    raw = first_env("GLM_MAX_TOKENS", default="")
    if raw:
        try:
            return max(1, int(raw))
        except Exception:
            pass
    return 2048


def is_glm_caption_eval_enabled(explicit=None) -> bool:
    explicit_value = _clean(explicit)
    if explicit_value:
        return explicit_value.lower() in {"1", "true", "yes", "on"}
    return first_env("GLM_CAPTION_EVAL", default="").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def is_dub_verification_enabled(explicit=None) -> bool:
    """Whether to run the post-build QA re-transcription of the dubbed output.

    Off by default: the verifier re-transcribes the entire dub with the large
    Whisper model on CPU (minutes of runtime) and only ever produces a
    non-blocking, frequently-inconclusive warning. Set DUB_VERIFICATION=on to
    re-enable it when you specifically want the sanity check.
    """
    explicit_value = _clean(explicit)
    if explicit_value:
        return explicit_value.lower() in {"1", "true", "yes", "on"}
    return first_env("DUB_VERIFICATION", default="").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def get_zernio_api_key(explicit=None) -> str:
    explicit_value = _clean(explicit)
    if explicit_value:
        return explicit_value
    return first_env("ZERNIO_API_KEY")


def get_sheet_id(explicit=None) -> str:
    explicit_value = _clean(explicit)
    if explicit_value:
        return explicit_value
    return first_env("GOOGLE_SHEET_ID", "SHEET_ID")


def get_credentials_file(default="credentials.json") -> str:
    return first_env("GOOGLE_CREDENTIALS_FILE", default=default)


def get_platform_accounts(explicit=None) -> Dict[str, str]:
    accounts = {}
    provided = explicit or {}
    for platform, env_name in PLATFORM_ACCOUNT_ENV_MAP.items():
        explicit_value = _clean(provided.get(platform))
        env_value = first_env(env_name)
        value = explicit_value or env_value
        if value:
            accounts[platform] = value
    return accounts


def get_missing_platform_account_envs(platforms) -> Dict[str, str]:
    missing = {}
    for platform in platforms or []:
        env_name = PLATFORM_ACCOUNT_ENV_MAP.get(platform)
        if not env_name:
            continue
        if not first_env(env_name):
            missing[platform] = env_name
    return missing


def get_dub_source_lang(explicit=None) -> str:
    explicit_value = _clean(explicit)
    if explicit_value:
        return explicit_value
    return first_env("DUB_SOURCE_LANG", default="en")


def get_dub_target_lang(explicit=None) -> str:
    explicit_value = _clean(explicit)
    if explicit_value:
        return explicit_value
    return first_env("DUB_TARGET_LANG", default="")


def get_dub_voice(explicit=None) -> str:
    explicit_value = _clean(explicit)
    if explicit_value:
        return explicit_value
    return first_env("DUB_VOICE", default="")
