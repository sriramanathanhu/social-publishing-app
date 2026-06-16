import os, json, re, time, tempfile, threading
from .utils import log, track_api_call, track_api_success
from .runtime_config import is_economy_mode
from .config import (
    get_active_gemini_api_key,
    get_gemini_api_key,
    gemini_key_rotation_stats,
    mark_gemini_key_exhausted,
    reset_gemini_key_rotation,
)

# Serialize cache writes within the process. Translation currently runs on a
# single worker thread, but the cache file is also loaded at module import on
# the main thread, so a lock is cheap insurance.
_CACHE_WRITE_LOCK = threading.Lock()

LANGUAGE_SPECS = {
    "en": {
        "name": "English",
        "script_ranges": [
            (0x0041, 0x005A),
            (0x0061, 0x007A),
            (0x00C0, 0x00FF),
        ],
        "strict_script_validation": False,
        "pivot_via_english": False,
    },
    "hi": {
        "name": "Hindi",
        "script_ranges": [(0x0900, 0x097F)],
        "strict_script_validation": True,
        "pivot_via_english": False,
    },
    "gu": {
        "name": "Gujarati",
        "script_ranges": [(0x0A80, 0x0AFF)],
        "strict_script_validation": True,
        "pivot_via_english": True,
    },
    "ta": {
        "name": "Tamil",
        "script_ranges": [(0x0B80, 0x0BFF)],
        "strict_script_validation": True,
        "pivot_via_english": False,
    },
    "te": {
        "name": "Telugu",
        "script_ranges": [(0x0C00, 0x0C7F)],
        "strict_script_validation": True,
        "pivot_via_english": False,
    },
    "kn": {
        "name": "Kannada",
        "script_ranges": [(0x0C80, 0x0CFF)],
        "strict_script_validation": True,
        "pivot_via_english": False,
    },
    "ml": {
        "name": "Malayalam",
        "script_ranges": [(0x0D00, 0x0D7F)],
        "strict_script_validation": True,
        "pivot_via_english": False,
    },
    "bn": {
        "name": "Bengali",
        "script_ranges": [(0x0980, 0x09FF)],
        "strict_script_validation": True,
        "pivot_via_english": False,
    },
    "es": {
        "name": "Spanish",
        "script_ranges": [
            (0x0041, 0x005A),
            (0x0061, 0x007A),
            (0x00C0, 0x00FF),
        ],
        "strict_script_validation": False,
        "pivot_via_english": False,
    },
    "ru": {
        "name": "Russian",
        "script_ranges": [(0x0400, 0x04FF)],
        "strict_script_validation": True,
        "pivot_via_english": False,
    },
}

LANGUAGE_NAMES = {
    code: spec["name"] for code, spec in LANGUAGE_SPECS.items()
}

# Translation cache
_cache_file = "translation_cache.json"
_translation_cache = {}

# Runtime state for a single translate_segments invocation.
_gemini_quota_exhausted = False
_gemini_quota_reason = ""
_gemini_skip_logged = False
_last_runtime_meta = {
    "used_fallback": False,
    "reason": "",
}
PROTECTED_PHRASES = {
    "Sovereign Order of KAILASA's Nithyananda": "Sovereign Order of KAILASA's Nithyananda",
}
OMISSION_CHECK_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "had",
    "has",
    "have",
    "he",
    "her",
    "his",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "me",
    "my",
    "of",
    "on",
    "or",
    "our",
    "she",
    "that",
    "the",
    "their",
    "them",
    "there",
    "they",
    "this",
    "to",
    "was",
    "we",
    "were",
    "will",
    "with",
    "you",
    "your",
    "whole",
    "all",
    "every",
    "then",
    "than",
    "just",
    "only",
    "about",
    "what",
    "when",
    "where",
    "who",
    "why",
    "how",
    "past",
    "today",
    "start",
}
SHORT_LIST_TAIL_MARKERS = {"all that", "etc", "and all that"}


def _reset_runtime_state():
    global \
        _gemini_quota_exhausted, \
        _gemini_quota_reason, \
        _gemini_skip_logged, \
        _last_runtime_meta
    _gemini_quota_exhausted = False
    _gemini_quota_reason = ""
    _gemini_skip_logged = False
    _last_runtime_meta = {"used_fallback": False, "reason": ""}
    # Fresh run → every configured key gets another shot. The free-tier cap
    # is per-project-per-day, so a key that was exhausted during a previous
    # run may still be over its daily quota, but advertising it as available
    # is fine: the first attempt will 429 and we'll re-flag it immediately.
    reset_gemini_key_rotation()


def get_translation_runtime_meta():
    """Return metadata from the latest translate_segments run."""
    return dict(_last_runtime_meta)


def _is_quota_exhausted_error(err_text):
    s = str(err_text or "").lower()
    # Daily free-tier exhaustion patterns from Gemini responses.
    quota_tokens = (
        "resource_exhausted",
        "quota exceeded",
        "free_tier_requests",
        "generaterequestsperday",
        "perdayperproject",
        "limit: 20",
    )
    return any(t in s for t in quota_tokens)


def _mark_quota_exhausted(reason):
    """Record that the active Gemini key hit its daily quota.

    If additional keys are configured (``GEMINI_API_KEY_1..N``), the current
    key is marked exhausted and subsequent calls transparently rotate to the
    next one — the run stays on Gemini instead of flipping to the Google
    Translate fallback. Only when every configured key is exhausted do we
    set the run-scoped ``_gemini_quota_exhausted`` flag.
    """
    global _gemini_quota_exhausted, _gemini_quota_reason
    burned_key = get_active_gemini_api_key()
    mark_gemini_key_exhausted(burned_key)
    stats = gemini_key_rotation_stats()
    if stats["remaining_keys"] > 0:
        log(
            "TRANSLATE",
            f"  Gemini key quota exhausted — rotating "
            f"({stats['exhausted_keys']}/{stats['total_keys']} used, "
            f"{stats['remaining_keys']} remaining).",
        )
        return
    if not _gemini_quota_exhausted:
        _gemini_quota_exhausted = True
        _gemini_quota_reason = str(reason or "")
        if stats["total_keys"] > 1:
            log(
                "TRANSLATE",
                f"  All {stats['total_keys']} Gemini keys quota-exhausted. "
                "Switching to Google Translate fallback for remaining segments in this run.",
            )
        else:
            log(
                "TRANSLATE",
                "  Gemini quota exhausted. Switching to Google Translate fallback for remaining segments in this run.",
            )


def _log_skip_once():
    global _gemini_skip_logged
    if _gemini_quota_exhausted and not _gemini_skip_logged:
        _gemini_skip_logged = True
        reason = _gemini_quota_reason or "quota exhausted"
        log(
            "TRANSLATE",
            f"  Gemini disabled for this run ({reason}); skipping further Gemini calls.",
        )


def _normalize_whitespace(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _cleanup_adjacent_duplicate_words(text):
    parts = re.findall(r"\w+|[^\w\s]+|\s+", str(text or ""), flags=re.UNICODE)
    cleaned = []
    last_word = None
    for part in parts:
        if part.isspace():
            cleaned.append(part)
            continue
        if re.fullmatch(r"\w+", part, flags=re.UNICODE):
            word = part.lower()
            if last_word == word:
                continue
            last_word = word
            cleaned.append(part)
            continue
        cleaned.append(part)
    return "".join(cleaned)


def _cleanup_repeated_short_lists(text):
    source = _normalize_whitespace(text)
    if "," not in source:
        return source

    items = [item.strip() for item in source.split(",")]
    if len(items) < 3:
        return source

    cleaned_items = []
    seen = set()
    changed = False
    for item in items:
        normalized = re.sub(r"[^\w\s]", "", item, flags=re.UNICODE).strip().lower()
        if not normalized:
            continue

        duplicate = normalized in seen
        if duplicate:
            word_count = len(normalized.split())
            if word_count <= 2 and normalized not in SHORT_LIST_TAIL_MARKERS:
                changed = True
                continue

        seen.add(normalized)
        cleaned_items.append(item)

    if not changed or len(cleaned_items) < 2:
        return source

    repaired = ", ".join(cleaned_items)
    repaired = re.sub(r"\s+,", ",", repaired)
    repaired = re.sub(r"\s+\.", ".", repaired)
    return repaired


def _cleanup_source_text(text):
    original = _normalize_whitespace(text)
    cleaned = _cleanup_adjacent_duplicate_words(original)
    cleaned = _cleanup_repeated_short_lists(cleaned)
    cleaned = _normalize_whitespace(cleaned)
    return cleaned or original


def _google_translate_text(text, target_language, source_hint="auto", use_pivot=False):
    """Google Translate helper with optional English pivot for language-specific quality."""
    from deep_translator import GoogleTranslator

    direct = GoogleTranslator(source="auto", target=target_language).translate(text)
    spec = _language_spec(target_language)
    if not spec.get("pivot_via_english"):
        return direct

    if direct and _is_translation_acceptable(direct, target_language):
        return direct

    if use_pivot and source_hint != "en":
        try:
            english = GoogleTranslator(source="auto", target="en").translate(text)
            pivoted = GoogleTranslator(source="en", target=target_language).translate(
                english
            )
            if pivoted and _is_translation_acceptable(pivoted, target_language):
                return pivoted
        except Exception as e:
            log("TRANSLATE", f"  Pivot error: {e}")
    return direct


def _tokenize_for_omission_check(text):
    return re.findall(r"[A-Za-z']+", str(text or "").lower())


def _extract_coverage_terms(text):
    candidates = []
    seen = set()
    for token in _tokenize_for_omission_check(text):
        normalized = token.strip("'")
        if len(normalized) < 5:
            continue
        if normalized in OMISSION_CHECK_STOPWORDS:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        candidates.append(normalized)
    return candidates[:8]


def _find_missing_coverage_terms(source_text, translated_text, target_language, source_hint):
    source_hint = str(source_hint or "auto").lower()
    coverage_source_text = source_text
    if source_hint not in {"en", "auto"}:
        try:
            coverage_source_text = _google_translate_text(
                source_text,
                "en",
                source_hint=source_hint,
                use_pivot=False,
            )
        except Exception as e:
            log("TRANSLATE", f"  Coverage source pivot failed: {e}")
            return []

    source_terms = _extract_coverage_terms(coverage_source_text)
    if not source_terms:
        return []

    try:
        round_trip = _google_translate_text(
            translated_text,
            "en",
            source_hint=target_language,
            use_pivot=False,
        )
    except Exception as e:
        log("TRANSLATE", f"  Coverage back-translation failed: {e}")
        return []

    round_trip_tokens = set(_tokenize_for_omission_check(round_trip))
    missing = [term for term in source_terms if term not in round_trip_tokens]
    significant_missing = [term for term in missing if len(term) >= 6]

    if significant_missing:
        log(
            "TRANSLATE",
            f"  Coverage check missing source terms: {', '.join(significant_missing)}",
        )
    return significant_missing


def _load_cache():
    """Load translation cache from file."""
    global _translation_cache
    if os.path.exists(_cache_file):
        try:
            with open(_cache_file, "r", encoding="utf-8") as f:
                _translation_cache = json.load(f)
            log("TRANSLATE", f"[CACHE] Loaded {len(_translation_cache)} entries")
        except Exception as e:
            log("TRANSLATE", f"[CACHE] Load failed: {e}")
            _translation_cache = {}
    else:
        _translation_cache = {}


def _save_cache():
    """Atomically save translation cache to file.

    Writes to a temp file in the same directory, fsyncs, then os.replaces over
    the real cache. This prevents a crash mid-write from truncating or
    corrupting translation_cache.json (which is slow to rebuild).
    """
    with _CACHE_WRITE_LOCK:
        cache_dir = os.path.dirname(os.path.abspath(_cache_file)) or "."
        tmp_fd = None
        tmp_path = None
        try:
            tmp_fd, tmp_path = tempfile.mkstemp(
                prefix=".translation_cache.",
                suffix=".tmp",
                dir=cache_dir,
            )
            with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                tmp_fd = None  # ownership transferred to the file object
                json.dump(_translation_cache, f, ensure_ascii=False, indent=2)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except Exception:
                    pass
            os.replace(tmp_path, _cache_file)
            tmp_path = None
            log("TRANSLATE", f"[CACHE] Saved {len(_translation_cache)} entries")
        except Exception as e:
            log("TRANSLATE", f"[CACHE] Save failed: {e}")
            if tmp_fd is not None:
                try:
                    os.close(tmp_fd)
                except Exception:
                    pass
            if tmp_path is not None:
                try:
                    os.remove(tmp_path)
                except Exception:
                    pass


def _language_spec(target_language):
    return LANGUAGE_SPECS.get(
        str(target_language or "").lower(),
        {
            "name": str(target_language or "target language"),
            "script_ranges": [],
            "strict_script_validation": False,
            "pivot_via_english": False,
        },
    )


def _normalize_key(text, target_language="en"):
    """Normalize text for cache key, scoped by target language."""
    return f"{target_language}::{text.strip().lower()}"


def _get_cached(text, target_language="en"):
    """Get cached translation if exists."""
    key = _normalize_key(text, target_language)
    cached = _translation_cache.get(key)
    if cached is None:
        return None
    if _is_translation_acceptable(cached, target_language):
        return cached
    log("TRANSLATE", "[CACHE_INVALID] Discarding stale cached translation")
    _translation_cache.pop(key, None)
    return None


def _set_cached(text, translation, target_language="en"):
    """Cache translation if text is short enough."""
    if len(text) < 300 and _is_translation_acceptable(translation, target_language):
        key = _normalize_key(text, target_language)
        _translation_cache[key] = translation


# Load cache on module import
_load_cache()


def _count_alpha_chars(text):
    return sum(1 for c in text if str(c).isalpha())


def _count_chars_in_ranges(text, ranges):
    count = 0
    for c in text:
        code = ord(c)
        if any(start <= code <= end for start, end in ranges):
            count += 1
    return count


def _is_expected_script(text, target_language):
    if not text:
        return False
    spec = _language_spec(target_language)
    ranges = spec.get("script_ranges") or []
    if not ranges:
        return True
    alpha_chars = _count_alpha_chars(text)
    if alpha_chars == 0:
        return True
    return (_count_chars_in_ranges(text, ranges) / alpha_chars) > 0.25


def _has_unexpected_script(text, target_language):
    if not text:
        return False
    spec = _language_spec(target_language)
    expected_ranges = spec.get("script_ranges") or []
    if not expected_ranges:
        return False

    unexpected_ranges = []
    for code, other_spec in LANGUAGE_SPECS.items():
        if code == str(target_language or "").lower():
            continue
        unexpected_ranges.extend(other_spec.get("script_ranges") or [])

    alpha_chars = _count_alpha_chars(text)
    if alpha_chars == 0:
        return False
    return (_count_chars_in_ranges(text, unexpected_ranges) / alpha_chars) > 0.10


def _is_translation_acceptable(text, target_language):
    spec = _language_spec(target_language)
    if not spec.get("strict_script_validation"):
        return bool(text)
    return bool(text) and _is_expected_script(text, target_language) and not _has_unexpected_script(
        text, target_language
    )


def _restore_protected_phrases(text):
    restored = str(text or "")
    for phrase in PROTECTED_PHRASES.values():
        escaped = re.escape(phrase)
        restored = re.sub(escaped, phrase, restored, flags=re.IGNORECASE)
    return restored


def _protect_text_for_translation(text):
    protected = str(text or "")
    for phrase in PROTECTED_PHRASES.values():
        protected = protected.replace(phrase, f"[[{phrase}]]")
    return protected


def _gemini_translate(text, source_hint="auto", target_language="en"):
    from google import genai
    from google.genai import types

    if _gemini_quota_exhausted:
        raise RuntimeError(
            f"Gemini disabled for this run: {_gemini_quota_reason or 'quota exhausted'}"
        )

    # Use the currently-active key from the rotation pool so we transparently
    # move to GEMINI_API_KEY_2/3/... after the primary key hits its daily cap.
    api_key = get_active_gemini_api_key()
    if not api_key:
        raise RuntimeError("No Gemini API key found.")

    client = genai.Client(api_key=api_key)

    lang_names = {**LANGUAGE_NAMES, "auto": "the detected language"}

    source_lang = lang_names.get(source_hint, source_hint)
    target_lang = lang_names.get(target_language, target_language)

    prompt = f"""Translate the following text from {source_lang} to {target_lang}.

Context: This is a spiritual/Vedantic teaching by a Hindu monk about Hindu deities, traditions, and sacred places.

RULES:
1. PROPER NOUNS: If a name seems clearly misheard (e.g., "Allama" in a Tamil spiritual context likely means "ella malla"), correct it. Otherwise, transliterate names as-is.
1a. PROTECTED PHRASE: Keep `Sovereign Order of KAILASA's Nithyananda` exactly as written. Do not translate it, paraphrase it, or change its capitalization.
2. SANSKRIT SHLOKAS: If you detect a Sanskrit verse, mantra, or shloka (e.g., "Om Namah Shivaya", "Yada Yada Hi Dharmasya"), keep it in its original form. Do NOT translate shlokas. Only translate the teacher's explanation around them.
3. REVERENCE: Maintain a respectful, devotional tone. Keep sacred terms (e.g., Bhakti, Dharma, Prasad) in their original form if natural in {target_lang}.
4. TTS OPTIMIZED: Use clear punctuation for natural pauses (commas for breaths, periods for full stops). Avoid symbols like *, _, (), or brackets.
5. NATURAL SPEECH: Write for the ear, not the eye. Use conversational {target_lang}, not literary or formal style.

Return ONLY the translation. No explanations.

Text to translate:
{_protect_text_for_translation(text)}"""

    max_attempts = 1 if is_economy_mode() else 3
    for attempt in range(1, max_attempts + 1):
        try:
            track_api_call("gemini")
            response = client.models.generate_content(
                model="gemini-2.5-flash-lite",
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.3,
                    top_p=0.8,
                    max_output_tokens=1024,
                ),
            )
            result = response.text.strip()
            if result:
                track_api_success("gemini")
                return _restore_protected_phrases(result.replace("[[", "").replace("]]", ""))
        except Exception as e:
            log("TRANSLATE", f"  Gemini attempt {attempt} failed: {e}")
            if _is_quota_exhausted_error(e):
                _mark_quota_exhausted(e)
                raise RuntimeError(f"Gemini quota exhausted: {e}")
            if attempt == max_attempts:
                raise RuntimeError(
                    f"Gemini translation failed after {max_attempts} attempts: {e}"
                )
            time.sleep((1 if is_economy_mode() else 3) * attempt)

    raise RuntimeError(f"Gemini translation failed after {max_attempts} attempts.")


def _gemini_translate_with_coverage_retry(
    text, source_hint="auto", target_language="en", missing_terms=None
):
    from google import genai
    from google.genai import types

    if _gemini_quota_exhausted:
        raise RuntimeError(
            f"Gemini disabled for this run: {_gemini_quota_reason or 'quota exhausted'}"
        )

    # Use the currently-active key from the rotation pool so we transparently
    # move to GEMINI_API_KEY_2/3/... after the primary key hits its daily cap.
    api_key = get_active_gemini_api_key()
    if not api_key:
        raise RuntimeError("No Gemini API key found.")

    client = genai.Client(api_key=api_key)

    lang_names = {**LANGUAGE_NAMES, "auto": "the detected language"}
    source_lang = lang_names.get(source_hint, source_hint)
    target_lang = lang_names.get(target_language, target_language)
    missing_terms = [term for term in (missing_terms or []) if term]
    coverage_note = ", ".join(missing_terms) if missing_terms else "all concrete details"

    prompt = f"""Translate the following text from {source_lang} to {target_lang}.

Context: This is a spiritual/Vedantic teaching by a Hindu monk about Hindu deities, traditions, and sacred places.

RULES:
1. Do not omit any concrete source meaning. Preserve every image, action, and metaphor.
2. If the source contains a vivid word or phrase, keep that meaning explicit in the translation instead of smoothing it away.
3. Pay special attention to these source terms: {coverage_note}
4. PROPER NOUNS: If a name seems clearly misheard, correct it. Otherwise, transliterate names as-is.
5. SANSKRIT SHLOKAS: Keep verses, mantras, and shlokas in their original form.
6. REVERENCE: Maintain a respectful, devotional tone.
7. TTS OPTIMIZED: Use clear punctuation for natural pauses. Avoid symbols like *, _, (), or brackets.
8. NATURAL SPEECH: Write for the ear, not the eye.

Return ONLY the translation. No explanations.

Text to translate:
{_protect_text_for_translation(text)}"""

    track_api_call("gemini")
    response = client.models.generate_content(
        model="gemini-2.5-flash-lite",
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.1,
            top_p=0.8,
            max_output_tokens=1024,
        ),
    )
    result = (response.text or "").strip()
    if not result:
        raise RuntimeError("Gemini coverage retry returned empty output.")
    track_api_success("gemini")
    return _restore_protected_phrases(result.replace("[[", "").replace("]]", ""))


def _mistral_translate_with_coverage_retry(
    text, source_hint="auto", target_language="en", missing_terms=None
):
    """Mistral-based coverage retry — used when Gemini's daily quota is exhausted.

    Without this fallback, every segment's coverage retry is silently dropped
    for the rest of the day after the 20-req Gemini free tier cap is hit,
    which can silently drop concrete details (proper nouns, vivid verbs) from
    the translation. Mistral handles the same prompt shape well enough to
    recover most omitted terms.
    """
    from .config import get_mistral_api_key
    import httpx

    api_key = get_mistral_api_key()
    if not api_key:
        raise RuntimeError("No Mistral API key available for coverage retry.")

    lang_names = {**LANGUAGE_NAMES, "auto": "the detected language"}
    source_lang = lang_names.get(source_hint, source_hint)
    target_lang = lang_names.get(target_language, target_language)
    missing_terms = [term for term in (missing_terms or []) if term]
    coverage_note = ", ".join(missing_terms) if missing_terms else "all concrete details"

    prompt = f"""Translate the following text from {source_lang} to {target_lang}.

Context: This is a spiritual/Vedantic teaching by a Hindu monk about Hindu deities, traditions, and sacred places.

RULES:
1. Do not omit any concrete source meaning. Preserve every image, action, and metaphor.
2. If the source contains a vivid word or phrase, keep that meaning explicit in the translation instead of smoothing it away.
3. Pay special attention to these source terms: {coverage_note}
4. PROPER NOUNS: If a name seems clearly misheard, correct it. Otherwise, transliterate names as-is.
5. SANSKRIT SHLOKAS: Keep verses, mantras, and shlokas in their original form.
6. REVERENCE: Maintain a respectful, devotional tone.
7. TTS OPTIMIZED: Use clear punctuation for natural pauses. Avoid symbols like *, _, (), or brackets.
8. NATURAL SPEECH: Write for the ear, not the eye.

Return ONLY the translation. No explanations.

Text to translate:
{_protect_text_for_translation(text)}"""

    url = "https://api.mistral.ai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json; charset=utf-8",
    }
    payload = {
        "model": "mistral-large-latest",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "max_tokens": 1024,
    }

    track_api_call("mistral")
    r = httpx.post(url, headers=headers, json=payload, timeout=60)
    r.raise_for_status()
    result = (r.json()["choices"][0]["message"]["content"] or "").strip()
    if not result:
        raise RuntimeError("Mistral coverage retry returned empty output.")
    track_api_success("mistral")
    return _restore_protected_phrases(result.replace("[[", "").replace("]]", ""))


def _retry_translation_for_coverage(text, target_language, source_hint, missing_terms):
    gemini_err = None
    if not _gemini_quota_exhausted:
        try:
            retried = _gemini_translate_with_coverage_retry(
                text,
                source_hint=source_hint,
                target_language=target_language,
                missing_terms=missing_terms,
            )
            if _is_translation_acceptable(retried, target_language):
                return retried
        except Exception as e:
            gemini_err = e
            if _is_quota_exhausted_error(e):
                _mark_quota_exhausted(e)
            if not _gemini_quota_exhausted:
                log("TRANSLATE", f"  Coverage retry failed: {e}")

    # Gemini disabled (either from the start of this call or after a 429
    # mid-call). Fall through to Mistral so we don't silently drop missing
    # source terms for the rest of the run.
    if _gemini_quota_exhausted:
        try:
            retried = _mistral_translate_with_coverage_retry(
                text,
                source_hint=source_hint,
                target_language=target_language,
                missing_terms=missing_terms,
            )
            if _is_translation_acceptable(retried, target_language):
                log("TRANSLATE", "  Coverage retry via Mistral succeeded")
                return retried
        except Exception as e:
            log("TRANSLATE", f"  Coverage retry via Mistral failed: {e}")

    return None


def _gemini_translate_batch(texts, source_hint, target_language):
    """Translate multiple texts in a single Gemini API call"""
    from google import genai
    from google.genai import types

    if _gemini_quota_exhausted:
        raise RuntimeError(
            f"Gemini disabled for this run: {_gemini_quota_reason or 'quota exhausted'}"
        )

    # Use the currently-active key from the rotation pool so we transparently
    # move to GEMINI_API_KEY_2/3/... after the primary key hits its daily cap.
    api_key = get_active_gemini_api_key()
    if not api_key:
        raise RuntimeError("No Gemini API key found.")

    client = genai.Client(api_key=api_key)

    lang_names = {**LANGUAGE_NAMES, "auto": "the detected language"}
    target_name = lang_names.get(target_language, target_language)
    source_name = lang_names.get(source_hint, source_hint)

    # Create numbered list of texts to translate
    numbered_texts = "\n".join([f"{i + 1}. {text}" for i, text in enumerate(texts)])

    prompt = f"""Translate the following numbered list of texts from {source_name} to {target_name}.

Context: This is a spiritual/Vedantic teaching by a Hindu monk about Hindu deities, traditions, and sacred places.

RULES:
1. PROPER NOUNS: If a name seems clearly misheard (e.g., "Allama" in a Tamil spiritual context likely means "ella malla"), correct it. Otherwise, transliterate names as-is.
2. SANSKRIT SHLOKAS: If you detect a Sanskrit verse, mantra, or shloka (e.g., "Om Namah Shivaya", "Yada Yada Hi Dharmasya"), keep it in its original form. Do NOT translate shlokas. Only translate the teacher's explanation around them.
3. REVERENCE: Maintain a respectful, devotional tone. Keep sacred terms (e.g., Bhakti, Dharma, Prasad) in their original form if natural in {target_name}.
4. TTS OPTIMIZED: Use clear punctuation for natural pauses (commas for breaths, periods for full stops). Avoid symbols like *, _, (), or brackets.
5. NATURAL SPEECH: Write for the ear, not the eye. Use conversational {target_name}, not literary or formal style.

Return ONLY a numbered list of translations in the same order.
Format each line as: "number. translation"
No explanations, no notes, no extra text.

Texts to translate:
{numbered_texts}"""

    max_attempts = 1 if is_economy_mode() else 3
    for attempt in range(1, max_attempts + 1):
        try:
            track_api_call("gemini")
            response = client.models.generate_content(
                model="gemini-2.5-flash-lite",
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.3,
                    top_p=0.8,
                    max_output_tokens=4096,
                ),
            )
            result = response.text.strip()
            if result:
                translations = _parse_batch_response(result, len(texts))
                if translations is not None:
                    track_api_success("gemini")
                    return translations
                else:
                    return None
        except Exception as e:
            log("TRANSLATE", f"  Gemini batch attempt {attempt} failed: {e}")
            if _is_quota_exhausted_error(e):
                _mark_quota_exhausted(e)
                raise RuntimeError(f"Gemini batch quota exhausted: {e}")
            time.sleep((1 if is_economy_mode() else 3) * attempt)

    raise RuntimeError(
        f"Gemini batch translation failed after {max_attempts} attempts."
    )


def _mistral_translate(text, source_hint="auto", target_language="en"):
    """Translate using Mistral API as fallback when Gemini fails."""
    from .config import get_mistral_api_key
    import httpx

    api_key = get_mistral_api_key()
    if not api_key:
        raise RuntimeError("No Mistral API key available for fallback translation.")

    lang_names = {**LANGUAGE_NAMES, "auto": "English"}

    target_lang = lang_names.get(target_language, target_language)
    source_lang = lang_names.get(source_hint, "English")

    prompt = f"""Translate the following text from {source_lang} to {target_lang}.

Context: This is a spiritual/Vedantic teaching by a Hindu monk about Hindu deities, traditions, and sacred places.

RULES:
1. PROPER NOUNS: Transliterate names as-is.
2. SANSKRIT SHLOKAS: Keep Sanskrit verses in original form.
3. REVERENCE: Maintain devotional tone.
4. TTS OPTIMIZED: Use clear punctuation for natural pauses.
5. NATURAL SPEECH: Write for the ear, not the eye.

Return ONLY the translation. No explanations.

Text to translate:
{text}"""

    url = "https://api.mistral.ai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json; charset=utf-8",
    }
    payload = {
        "model": "mistral-small-latest",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
        "max_tokens": 1024,
    }

    try:
        track_api_call("mistral")
        r = httpx.post(url, headers=headers, json=payload, timeout=60)
        r.raise_for_status()
        result = r.json()["choices"][0]["message"]["content"].strip()
        track_api_success("mistral")
        log("TRANSLATE", f"  Mistral translation successful")
        return result
    except Exception as e:
        log("TRANSLATE", f"  Mistral translation failed: {e}")
        raise RuntimeError(f"Mistral translation failed: {e}")


def _mistral_translate_batch(texts, source_hint, target_language):
    """Translate multiple texts using Mistral API."""
    from .config import get_mistral_api_key
    import httpx

    api_key = get_mistral_api_key()
    if not api_key:
        raise RuntimeError("No Mistral API key available for fallback translation.")

    lang_names = {**LANGUAGE_NAMES, "auto": "English"}

    target_name = lang_names.get(target_language, target_language)
    source_name = lang_names.get(source_hint, "English")

    numbered_texts = "\n".join([f"{i + 1}. {text}" for i, text in enumerate(texts)])

    prompt = f"""Translate the following numbered list of texts from {source_name} to {target_name}.

RULES:
1. PROPER NOUNS: Transliterate names as-is.
2. SANSKRIT SHLOKAS: Keep Sanskrit verses in original form.
3. REVERENCE: Maintain devotional tone.
4. TTS OPTIMIZED: Use clear punctuation for natural pauses.
5. NATURAL SPEECH: Write for the ear, not the eye.

Return ONLY a numbered list of translations. Format: "number. translation"

Texts to translate:
{numbered_texts}"""

    url = "https://api.mistral.ai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json; charset=utf-8",
    }
    payload = {
        "model": "mistral-small-latest",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
        "max_tokens": 4096,
    }

    try:
        track_api_call("mistral")
        r = httpx.post(url, headers=headers, json=payload, timeout=120)
        r.raise_for_status()
        result = r.json()["choices"][0]["message"]["content"].strip()
        track_api_success("mistral")

        translations = _parse_batch_response(result, len(texts))
        if translations is not None:
            track_api_success("mistral")
            return translations
        return None
    except Exception as e:
        log("TRANSLATE", f"  Mistral batch translation failed: {e}")
        return None


def _translate_segments_per_segment(texts, source_hint, target_language):
    """Fallback: translate texts one by one (original behavior)"""
    log(
        "TRANSLATE",
        f"  Falling back to per-segment translation for {len(texts)} texts...",
    )

    translations = []
    for i, text in enumerate(texts):
        try:
            translated = _translate_with_policy(text, target_language, source_hint)
        except Exception as e:
            log("TRANSLATE", f"  ERROR on text {i + 1}: {e} — using source text")
            translated = text

        translations.append(translated)

    return translations


def _detect_source_hint(text):
    text = text or ""
    alpha_chars = _count_alpha_chars(text)
    if alpha_chars == 0:
        return "auto"

    best_code = "en"
    best_ratio = 0.0
    for code, spec in LANGUAGE_SPECS.items():
        ranges = spec.get("script_ranges") or []
        if not ranges:
            continue
        ratio = _count_chars_in_ranges(text, ranges) / alpha_chars
        if ratio > best_ratio:
            best_ratio = ratio
            best_code = code
    return best_code if best_ratio > 0.10 else "en"


def _parse_batch_response(response, expected_count):
    """Parse numbered list response back into individual translations"""
    lines = response.strip().split("\n")
    translations = []

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Look for "number. translation" format
        if ". " in line:
            parts = line.split(". ", 1)
            if len(parts) == 2 and parts[0].isdigit():
                text_part = parts[1].strip()
                if text_part:
                    translations.append(text_part)
                else:
                    log(
                        "TRANSLATE",
                        f"  Empty translation at line {parts[0]} — skipping",
                    )
            else:
                # Fallback: take the whole line if format is unexpected
                translations.append(line)
        else:
            translations.append(line)

    # Validate count - if mismatch, return None to trigger fallback
    if len(translations) != expected_count:
        log(
            "TRANSLATE",
            f"  COUNT MISMATCH: expected {expected_count}, got {len(translations)}",
        )
        log(
            "TRANSLATE",
            f"  Gemini may have dropped/merged segments - falling back to per-segment translation",
        )
        return None

    return translations


def _translate_with_policy(text, target_language, source_hint="auto"):
    spec = _language_spec(target_language)
    language_name = spec.get("name", target_language)

    text = _restore_protected_phrases(text)
    cached = _get_cached(text, target_language)
    if cached:
        log("TRANSLATE", "[CACHE_HIT] Using cached translation")
        return cached

    if is_economy_mode():
        result = _google_translate_text(
            text,
            target_language,
            source_hint=source_hint,
            use_pivot=spec.get("pivot_via_english", False),
        )
        final = _restore_protected_phrases(result or text)
        _set_cached(text, final, target_language)
        return final

    result = None
    if _gemini_quota_exhausted:
        _log_skip_once()
    else:
        try:
            result = _gemini_translate(text, source_hint, target_language)
            if _is_translation_acceptable(result, target_language):
                final = _restore_protected_phrases(result)
                _set_cached(text, final, target_language)
                return final
            log(
                "TRANSLATE",
                f"  Gemini output not clean {language_name} — falling back to Google Translate ...",
            )
        except Exception as e:
            if _is_quota_exhausted_error(e):
                _mark_quota_exhausted(e)
            log(
                "TRANSLATE",
                f"  Gemini failed for {target_language}: {e} — falling back to Google Translate ...",
            )

    if not is_economy_mode():
        try:
            result = _mistral_translate(text, source_hint, target_language)
            if _is_translation_acceptable(result, target_language):
                final = _restore_protected_phrases(result)
                _set_cached(text, final, target_language)
                return final
            log(
                "TRANSLATE",
                f"  Mistral output not clean {language_name} — falling back to Google Translate ...",
            )
        except Exception as e:
            log(
                "TRANSLATE",
                f"  Mistral failed for {target_language}: {e} — falling back to Google Translate ...",
            )

    try:
        result = _google_translate_text(
            text, target_language, source_hint=source_hint, use_pivot=False
        )
    except Exception as e:
        log("TRANSLATE", f"  Google Translate failed: {e} — returning original text")
        final = _restore_protected_phrases(text)
        _set_cached(text, final, target_language)
        return final
    if _is_translation_acceptable(result, target_language):
        final = _restore_protected_phrases(result)
        _set_cached(text, final, target_language)
        return final

    if spec.get("pivot_via_english") and source_hint != "en":
        log("TRANSLATE", "  Trying English pivot ...")
        try:
            result2 = _google_translate_text(
                text, target_language, source_hint=source_hint, use_pivot=True
            )
            if _is_translation_acceptable(result2, target_language):
                final = _restore_protected_phrases(result2)
                _set_cached(text, final, target_language)
                return final
        except Exception as e:
            log("TRANSLATE", f"  Pivot error: {e}")

    log(
        "TRANSLATE",
        f"  WARNING: Could not get clean {language_name} — using best available result",
    )
    final = _restore_protected_phrases(result or text)
    _set_cached(text, final, target_language)
    return final


def _translate_batch_with_policy(texts, target_language, source_hint="auto"):
    """Batch translate multiple texts using per-language policy."""
    spec = _language_spec(target_language)
    language_name = spec.get("name", target_language)
    if is_economy_mode():
        log(
            "TRANSLATE",
            f"  Economy mode: using Google Translate-first routing for {language_name} batch.",
        )
        return [_translate_with_policy(t, target_language, source_hint) for t in texts]

    cached_results = [_get_cached(t, target_language) for t in texts]
    uncached_indices = [i for i, c in enumerate(cached_results) if c is None]
    cached_count = len(texts) - len(uncached_indices)

    if cached_count > 0:
        log("TRANSLATE", f"  [CACHE] {cached_count}/{len(texts)} texts already cached")

    if not uncached_indices:
        return cached_results

    uncached_texts = [texts[i] for i in uncached_indices]

    try:
        translations = _gemini_translate_batch(
            uncached_texts, source_hint, target_language
        )
        if translations is not None:
            validated_translations = []
            for translation in translations:
                if _is_translation_acceptable(translation, target_language):
                    validated_translations.append(translation)
                else:
                    validated_translations.append(None)

            if any(t is None for t in validated_translations):
                log(
                    "TRANSLATE",
                    f"  Some Gemini outputs not clean {language_name} — filling with fallback translations...",
                )
                missing_pairs = [
                    (idx, text)
                    for idx, text, translation in zip(
                        uncached_indices, uncached_texts, validated_translations
                    )
                    if translation is None
                ]
                if missing_pairs:
                    try:
                        mistral_results = _mistral_translate_batch(
                            [text for _, text in missing_pairs],
                            source_hint,
                            target_language,
                        )
                        if mistral_results:
                            for (idx, _), result in zip(missing_pairs, mistral_results):
                                local_index = uncached_indices.index(idx)
                                if _is_translation_acceptable(result, target_language):
                                    validated_translations[local_index] = result
                    except Exception as e:
                        log("TRANSLATE", f"  Mistral fallback failed: {e}")

                    for idx, text in missing_pairs:
                        local_index = uncached_indices.index(idx)
                        if validated_translations[local_index] is None:
                            validated_translations[local_index] = _translate_with_policy(
                                text, target_language, source_hint
                            )

            results = list(cached_results)
            for idx, translation, text in zip(
                uncached_indices, validated_translations, uncached_texts
            ):
                results[idx] = translation
                _set_cached(text, translation, target_language)
            return results

        if _gemini_quota_exhausted:
            log("TRANSLATE", "  Gemini quota exhausted — trying Mistral fallback...")
            try:
                mistral_results = _mistral_translate_batch(
                    uncached_texts, source_hint, target_language
                )
                if mistral_results:
                    results = list(cached_results)
                    for idx, translation, text in zip(
                        uncached_indices, mistral_results, uncached_texts
                    ):
                        results[idx] = translation
                        _set_cached(text, translation, target_language)
                    return results
            except Exception as e:
                log(
                    "TRANSLATE",
                    f"  Mistral fallback failed: {e} — using per-segment translation",
                )
                return _translate_segments_per_segment(
                    texts, source_hint, target_language
                )

        return _translate_segments_per_segment(texts, source_hint, target_language)

    except Exception as e:
        if _is_quota_exhausted_error(e):
            _mark_quota_exhausted(e)
        if _gemini_quota_exhausted:
            # _mark_quota_exhausted already logged the one-time switch banner;
            # don't re-dump the full 429 JSON blob here too.
            log(
                "TRANSLATE",
                "  Translation batch failed (Gemini disabled) — using per-segment translation",
            )
        else:
            log(
                "TRANSLATE",
                f"  Translation batch failed: {e} — using per-segment translation",
            )
        return _translate_segments_per_segment(texts, source_hint, target_language)

    except Exception as e:
        log(
            "TRANSLATE",
            f"  Gemini batch failed for {target_language}: {e} — falling back to per-segment translation",
        )
        return _translate_segments_per_segment(texts, source_hint, target_language)


def translate_segments(segments, target_language="en", output_dir="workspace"):
    os.makedirs(output_dir, exist_ok=True)
    _reset_runtime_state()

    prepared_segments = []
    for seg in segments:
        cleaned_text = _cleanup_source_text(seg.get("text", ""))
        if cleaned_text != (seg.get("text", "") or ""):
            log(
                "TRANSLATE",
                f"  Cleaned ASR artifact: '{seg.get('text', '')[:70]}' -> '{cleaned_text[:70]}'",
            )
        prepared_segments.append({**seg, "text": cleaned_text})
    segments = prepared_segments

    source_hint = "auto"
    if segments:
        first_text = segments[0].get("text", "")
        source_hint = _detect_source_hint(first_text)

    log("TRANSLATE", f"Source script hint: {source_hint} | Target: {target_language}")
    log("TRANSLATE", f"Batch translating {len(segments)} segments...")

    # Extract all texts for batch translation
    texts = [seg["text"] for seg in segments]

    try:
        translations = _translate_batch_with_policy(texts, target_language, source_hint)

        log("TRANSLATE", f"Batch translation completed, processing results...")

    except Exception as e:
        log("TRANSLATE", f"  ERROR: {e} — using source text for all segments")
        translations = texts  # Fallback to original texts

    # Process results and validate
    results = []
    for i, (seg, translated) in enumerate(zip(segments, translations)):
        log("TRANSLATE", f"[{i + 1}/{len(segments)}] {texts[i][:70]}")

        missing_terms = _find_missing_coverage_terms(
            texts[i], translated, target_language, source_hint
        )
        if missing_terms:
            log(
                "TRANSLATE",
                f"  Retrying segment {i + 1} to preserve omitted meaning...",
            )
            retried = _retry_translation_for_coverage(
                texts[i], target_language, source_hint, missing_terms
            )
            if retried:
                translated = retried

        if _has_unexpected_script(translated, target_language):
            log("TRANSLATE", f"  !! FOREIGN SCRIPT in output — check segment {i + 1}")

        log("TRANSLATE", f"  -> {translated[:70]}")
        if _language_spec(target_language).get("strict_script_validation"):
            log(
                "TRANSLATE",
                f"     Expected script: {_is_expected_script(translated, target_language)}",
            )
        _set_cached(texts[i], translated, target_language)
        results.append({**seg, "translated": translated})

    with open(
        os.path.join(output_dir, "translation_log.json"), "w", encoding="utf-8"
    ) as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    if _gemini_quota_exhausted:
        global _last_runtime_meta
        _last_runtime_meta = {
            "used_fallback": True,
            "reason": _gemini_quota_reason or "Gemini quota exhausted",
        }
        log(
            "TRANSLATE",
            "Summary: Gemini quota exhausted in this run; Google Translate fallback was used.",
        )

    # Save translation cache
    _save_cache()

    return results
