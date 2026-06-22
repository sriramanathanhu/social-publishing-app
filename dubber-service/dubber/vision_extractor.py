import os, json, time, re
from .utils import log, track_api_call, track_api_success
from .runtime_config import is_economy_mode
from .config import (
    get_active_gemini_api_key,
    mark_gemini_key_exhausted,
)

LANGUAGE_META = {
    "gu": ("Gujarati", "Gujarati script"),
    "hi": ("Hindi", "Devanagari script"),
    "ta": ("Tamil", "Tamil script"),
    "te": ("Telugu", "Telugu script"),
    "kn": ("Kannada", "Kannada script"),
    "ml": ("Malayalam", "Malayalam script"),
    "bn": ("Bengali", "Bengali script"),
    "es": ("Spanish", "Spanish"),
    "ru": ("Russian", "Cyrillic Russian"),
    "en": ("English", "English"),
}


def _build_vision_prompt(target_language, transcript):
    language_name, script_hint = LANGUAGE_META.get(
        str(target_language or "").lower(), ("target language", "the target script")
    )
    return (
        "You are a content intelligence engine. Analyze this transcript and extract the core message.\n\n"
        f"TRANSCRIPT ({language_name}):\n"
        f"{transcript}\n\n"
        "Return ONLY valid JSON with exactly these keys:\n"
        "{\n"
        f'  "main_topic": "short subject in {language_name} (max 80 chars)",\n'
        f'  "core_conflict": "central tension or teaching in {language_name} (1-2 sentences)",\n'
        f'  "provocative_angle": "most surprising statement in {language_name} (1 sentence)",\n'
        '  "festival": "festival name if mentioned, else null",\n'
        '  "location": "location if mentioned, else null",\n'
        '  "date": "date if mentioned, else null",\n'
        '  "theme": "one of: victory | celebration | devotional | teaching | announcement"\n'
        "}\n\n"
        "Rules:\n"
        f"- Write main_topic, core_conflict, provocative_angle in {script_hint}.\n"
        "- Base everything strictly on the transcript. No fabrication.\n"
        "- theme must be exactly one of the 5 options."
    )


def _call_gemini(api_key, prompt, max_retries=6):
    from google import genai
    from google.genai import types

    # Track the currently-active key inside this call so we can rotate to
    # ``GEMINI_API_KEY_2/3/...`` on daily-quota exhaustion without bubbling
    # all the way back up to the empty fallback path.
    current_key = api_key
    client = genai.Client(api_key=current_key)
    retries = min(max_retries, 2) if is_economy_mode() else max_retries
    for attempt in range(1, retries + 1):
        try:
            track_api_call("gemini")
            resp = client.models.generate_content(
                model="gemini-2.5-flash-lite",
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.3,
                    top_p=0.8,
                    max_output_tokens=1024,
                ),
            )
            result = resp.text.strip()
            track_api_success("gemini")
            return result
        except Exception as e:
            err = str(e)
            err_l = err.lower()
            if "429" in err or "resource_exhausted" in err_l:
                if (
                    "limit: 0" in err_l
                    or "quota exceeded for metric" in err_l
                    or "free_tier_requests" in err_l
                    or "generaterequestsperday" in err_l
                ):
                    # Burn the current key in the shared rotation state and
                    # try the next one if any are configured. Only hand off
                    # to the empty fallback when every key is spent.
                    mark_gemini_key_exhausted(current_key)
                    next_key = get_active_gemini_api_key()
                    if next_key and next_key != current_key:
                        log(
                            "VISION",
                            "  Daily quota exhausted for current Gemini key — rotating to next key.",
                        )
                        current_key = next_key
                        client = genai.Client(api_key=current_key)
                        continue
                    log(
                        "VISION",
                        "  Daily quota exhausted (all keys) — skipping retries, using fallback.",
                    )
                    raise RuntimeError(
                        "Daily Gemini quota exhausted. Add billing or use a second key."
                    )
                wait = 5 * attempt if is_economy_mode() else 20 * attempt
                m = re.search(r"retryDelay.*?(\d+)s", err)
                if m:
                    wait = int(m.group(1)) + 5
                log(
                    "VISION",
                    f"  429 rate limit — waiting {wait}s (attempt {attempt}/{retries}) ...",
                )
                time.sleep(wait)
                continue
            if "503" in err or "unavailable" in err_l:
                wait = 2**attempt
                log(
                    "VISION",
                    f"  503 service unavailable — waiting {wait}s (attempt {attempt}/{retries}) ...",
                )
                time.sleep(wait)
                continue
            raise
    raise RuntimeError(f"Gemini rate-limited after {retries} retries.")


def extract_vision(
    segments, api_key, output_dir="workspace", return_meta=False, target_language="gu"
):
    os.makedirs(output_dir, exist_ok=True)
    meta = {
        "used_fallback": False,
        "reason": "",
        "provider": "gemini_vision",
    }
    transcript = " ".join(
        (s.get("translated") or s.get("text", "")).strip() for s in segments
    ).strip()
    log("VISION", f"Transcript ({len(transcript)} chars) preview: {transcript[:120]}")
    if not transcript:
        log("VISION", "Empty transcript — fallback.")
        meta["used_fallback"] = True
        meta["reason"] = "Empty transcript"
        data = _fallback_extract(
            segments, transcript=transcript, target_language=target_language
        )
        return (data, meta) if return_meta else data
    # Prefer the current active rotation key: the translator may have
    # already burned the primary key earlier in the pipeline, and
    # ``app.py`` captures ``gemini_vision_key`` once upfront. Falling back
    # to ``get_active_gemini_api_key()`` keeps vision on a live key when
    # one is available.
    active_key = get_active_gemini_api_key()
    if active_key and active_key != api_key:
        api_key = active_key
    if not api_key:
        log("VISION", "No key — fallback.")
        meta["used_fallback"] = True
        meta["reason"] = "No Gemini Vision API key"
        data = _fallback_extract(
            segments, transcript=transcript, target_language=target_language
        )
        return (data, meta) if return_meta else data
    prompt = _build_vision_prompt(target_language, transcript)
    try:
        raw = _call_gemini(api_key, prompt)
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        data = json.loads(raw.strip())
        valid_themes = {
            "victory",
            "celebration",
            "devotional",
            "teaching",
            "announcement",
        }
        if data.get("theme") not in valid_themes:
            data["theme"] = "teaching"
        log(
            "VISION",
            f"Topic: {data.get('main_topic', '?')} | Theme: {data.get('theme', '?')}",
        )
        with open(os.path.join(output_dir, "vision.json"), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return (data, meta) if return_meta else data
    except Exception as e:
        log("VISION", f"Failed: {e} — fallback.")
        meta["used_fallback"] = True
        meta["reason"] = str(e)
        data = _fallback_extract(
            segments, transcript=transcript, target_language=target_language
        )
        meta["provider"] = "empty_fallback"
        return (data, meta) if return_meta else data


def _fallback_extract(segments, transcript=None, target_language=None):
    """Fallback when Gemini vision is unavailable — return an empty-but-valid
    structure so caption generation still runs (captions then lean on the
    transcript prompt instead of extracted anchors)."""
    return {
        "main_topic": "",
        "core_conflict": "",
        "provocative_angle": "",
        "theme": "teaching",
        "festival": None,
        "location": None,
        "date": None,
    }
