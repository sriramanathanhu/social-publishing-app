"""Pre-flight API validation — checks all configured APIs before pipeline starts."""

import concurrent.futures
from .utils import log


def _validate_gemini(api_key):
    """Ping Gemini with a minimal request."""
    if not api_key or not api_key.strip():
        return {"status": "missing", "message": "No Gemini API key configured"}
    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key.strip())
        resp = client.models.generate_content(
            model="gemini-2.5-flash-lite",
            contents="Reply with OK",
            config=types.GenerateContentConfig(max_output_tokens=5),
        )
        if resp.text:
            return {"status": "ok", "message": "Connected successfully"}
        return {"status": "error", "message": "Empty response from Gemini"}
    except Exception as e:
        err = str(e)
        if "401" in err or "API_KEY_INVALID" in err:
            return {"status": "error", "message": "Invalid API key"}
        if "429" in err or "quota" in err.lower():
            return {"status": "error", "message": "Quota exceeded"}
        return {"status": "error", "message": f"Connection failed: {err[:80]}"}


def _validate_zernio(api_key):
    """Check Zernio SDK initialization."""
    if not api_key or not api_key.strip():
        return {"status": "missing", "message": "No Zernio API key configured"}
    try:
        from zernio import Zernio

        client = Zernio(api_key=api_key.strip(), timeout=10.0)
        return {"status": "ok", "message": "SDK initialized successfully"}
    except Exception as e:
        err = str(e)
        if "401" in err or "unauthorized" in err.lower() or "invalid" in err.lower():
            return {"status": "error", "message": "Invalid API key"}
        return {"status": "error", "message": f"Connection failed: {err[:80]}"}


_VALIDATORS = {
    "gemini": _validate_gemini,
    "zernio": _validate_zernio,
}


def validate_all_keys(
    gemini_key=None,
    zernio_key=None,
    need_captions=False,
    need_publish=False,
):
    """
    Validate all configured APIs in parallel.
    Returns dict: {"gemini": {...}, "zernio": {...}}
    """
    key_map = {
        "gemini": gemini_key,
        "zernio": zernio_key,
    }

    # Determine which APIs to validate based on pipeline mode
    required = {"gemini"}  # Always needed (translation)
    if need_publish:
        required.add("zernio")

    results = {}

    def _check(name):
        try:
            return name, _VALIDATORS[name](key_map.get(name))
        except Exception as e:
            return name, {
                "status": "error",
                "message": f"Validation error: {str(e)[:80]}",
            }

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(required)) as pool:
        futures = {pool.submit(_check, name): name for name in required}
        for future in concurrent.futures.as_completed(futures):
            name, result = future.result()
            results[name] = result
            log("VALIDATE", f"  {name}: {result['status']} — {result['message']}")

    return results
