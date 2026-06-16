import os, json, re, subprocess
from .utils import ffprobe_duration as _ffprobe_duration, log

# Audio chunking safety net so wav files for very long videos stream in
# bounded pieces — keeps any single ffmpeg/Whisper step from spiking memory.
MAX_FILE_MB = 100

# Module-level cache for faster-whisper models. Loading Whisper-large from
# disk costs ~5–10s per instantiation; the dub verifier calls
# _local_transcribe once per chunk and was paying that cost 5× per run.
# Keyed by (model_size, device, compute_type) so a dub + verify in
# different sizes (rare) doesn't collide.
_WHISPER_MODEL_CACHE = {}
MIN_GAP_PROBE_SEC = 0.75
MIN_EDGE_GAP_PROBE_SEC = 0.2
MIN_PROBE_AUDIO_BYTES = 1000
PROBE_AUDIO_SAMPLE_RATE = "16000"
PROBE_AUDIO_CHANNELS = "1"
OPENING_RECOVERY_WINDOW_SEC = 12.0
OPENING_PRESERVE_WINDOW_SEC = 18.0
# Whisper routinely mis-detects accented or fast English speech as a different
# language and transliterates it into that language's script (e.g. English
# narration coming back as Telugu/Devanagari). Those false detections carry a
# low language_probability, whereas a genuine foreign-language opening (a real
# Sanskrit invocation, etc.) detects with high confidence. The generic
# non-Latin opening-preserve heuristic must only fire above this confidence
# floor, otherwise mis-transcribed English gets left undubbed in the source
# language while the rest of the video is dubbed — producing a jarring
# language switch a few seconds in.
OPENING_PRESERVE_MIN_LANG_PROB = 0.85
SANSKRIT_LANG_CODES = {"sa", "san", "sanskrit"}
SANSKRIT_TOKEN_MARKERS = {
    "atma",
    "atman",
    "brahma",
    "bhuta",
    "chinna",
    "dvaidha",
    "hite",
    "kalmasha",
    "kalmashah",
    "kshina",
    "mantra",
    "mantram",
    "moksha",
    "narayana",
    "nirvanam",
    "paramashivoham",
    "ratah",
    "sarva",
    "shloka",
    "sloka",
    "suktam",
    "svaha",
    "yatatmana",
    "yatatmanah",
    "yatendriya",
}
# Words that signal a spoken scripture *citation* opening (e.g. "In Bhagavad
# Gita 5th chapter ... 25th verse"), which we leave in the original voice.
# Deliberately excludes ordinary content words like "yoga": these channels
# dub yoga/spirituality talks where "yoga" is said constantly, so including it
# caused normal English openings (e.g. "Chick Yoga, Cook Yoga") to be
# mis-flagged as scripture and left undubbed. The remaining markers are
# specific enough that two hits genuinely indicate a verse citation.
SCRIPTURE_OPENING_MARKERS = {
    "bhagavad",
    "gita",
    "chapter",
    "verse",
    "shloka",
    "sloka",
    "translation",
}
SCRIPTURE_TRANSLATION_CUES = {
    "translation",
    "meaning",
    "commentary",
}
PROTECTED_PHRASE_PATTERNS = {
    r"\bsovereign order of kailashas nithyananda\b": "Sovereign Order of KAILASA's Nithyananda",
    r"\bsovereign order of kailasa(?:'s|s)? nithyananda\b": "Sovereign Order of KAILASA's Nithyananda",
}
NON_SPEECH_PHRASE_PATTERNS = (
    r"\bsubtitles by the amara\.org community\b",
    r"\bamara\.org\b",
    # Whisper hallucinates caption/transcription credit lines over trailing
    # silence or background music (e.g. "© transcript Emily Beynon",
    # "Subtitles by ...", "Transcribed by ..."). These are never spoken
    # content; left in, they get translated and dubbed as a stray clip at the
    # end of the video. Drop any segment that looks like such a credit.
    r"©",                                  # copyright glyph never occurs in real speech
    r"\bemily beynon\b",                   # notorious Whisper credit hallucination
    r"\btranscri\w*\s+by\b",               # "transcript by" / "transcribed by"
    r"\b(?:sub(?:title)?s?|captions?)\s+by\b",  # "subtitles by" / "captions by"
)


def _looks_like_spoken_text(text):
    """Heuristic to distinguish likely speech from punctuation/noise-only output."""
    cleaned = re.sub(r"\s+", " ", str(text or "")).strip(" \t\r\n-–—_")
    if not cleaned:
        return False
    lowered = cleaned.lower()
    if any(re.search(pattern, lowered, flags=re.IGNORECASE) for pattern in NON_SPEECH_PHRASE_PATTERNS):
        return False
    if re.fullmatch(r"[^\w]+", cleaned, flags=re.UNICODE):
        return False
    tokens = re.findall(r"[^\W_]+(?:['’-][^\W_]+)?|\d+", cleaned, flags=re.UNICODE)
    if not tokens:
        return False

    meaningful = [tok for tok in tokens if sum(ch.isalnum() for ch in tok) >= 2]
    if not meaningful:
        return False

    filler_tokens = {"uh", "um", "hmm", "hm", "mm", "mmm", "ah"}
    if all(tok.lower() in filler_tokens for tok in meaningful):
        return False

    return True


def _looks_like_probe_speech(text, duration_sec=0.0):
    """Stricter speech gate for coverage probes to avoid dubbing music/noise gaps."""
    cleaned = re.sub(r"\s+", " ", str(text or "")).strip(" \t\r\n-–—_")
    if not _looks_like_spoken_text(cleaned):
        return False

    normalized = re.sub(r"[^\w\s']", "", cleaned.lower(), flags=re.UNICODE).strip()
    tokens = re.findall(r"[^\W_]+(?:['’-][^\W_]+)?|\d+", cleaned, flags=re.UNICODE)
    meaningful = [tok for tok in tokens if sum(ch.isalnum() for ch in tok) >= 2]
    alnum_count = sum(ch.isalnum() for ch in cleaned)
    generic_probe_phrases = {
        "i dont know",
        "i don't know",
        "you know",
        "okay",
        "ok",
        "yeah",
        "yes",
        "no",
    }
    repetitive_interjections = {"oh", "ah", "ha", "hey"}

    if normalized in generic_probe_phrases and len(meaningful) <= 3 and duration_sec <= 2.5:
        return False
    if meaningful and all(tok.lower() in repetitive_interjections for tok in meaningful):
        return False

    if len(meaningful) >= 2:
        return True
    if alnum_count >= 6 and duration_sec >= 0.45:
        return True
    return False


def _normalize_protected_phrases(text):
    normalized = str(text or "")
    for pattern, replacement in PROTECTED_PHRASE_PATTERNS.items():
        normalized = re.sub(pattern, replacement, normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\bswayambhag(?:a|ha)\b", "Swayambhaga", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\bswayambaha\b", "Swayambhaga", normalized, flags=re.IGNORECASE)
    return normalized


def _normalize_language_code(language):
    value = str(language or "").strip().lower()
    if not value:
        return ""
    if "-" in value:
        value = value.split("-", 1)[0]
    if "_" in value:
        value = value.split("_", 1)[0]
    return value


def _tokenize_text(text):
    return re.findall(r"[^\W_]+(?:['’-][^\W_]+)?|\d+", str(text or "").lower(), flags=re.UNICODE)


def _looks_like_sanskrit_recitation(text, detected_language=""):
    normalized_language = _normalize_language_code(detected_language)
    if normalized_language in SANSKRIT_LANG_CODES:
        return True

    tokens = _tokenize_text(text)
    if len(tokens) < 2:
        return False

    marker_hits = sum(1 for token in tokens if token in SANSKRIT_TOKEN_MARKERS)
    if marker_hits >= 2:
        return True

    transliterated_endings = {"ah", "am", "aya", "ena", "anam", "atma", "bhuta"}
    ending_hits = 0
    for token in tokens:
        if len(token) < 4:
            continue
        if any(token.endswith(ending) for ending in transliterated_endings):
            ending_hits += 1
    return ending_hits >= 3


def _looks_like_scripture_opening_intro(text):
    tokens = _tokenize_text(text)
    if len(tokens) < 1:
        return False
    marker_hits = sum(1 for token in tokens if token in SCRIPTURE_OPENING_MARKERS)
    return marker_hits >= 2


def _contains_non_latin_letters(text):
    for char in str(text or ""):
        if not char.isalpha():
            continue
        if ord(char) > 127:
            return True
    return False


def _annotate_opening_language_segments(segments, source_language=""):
    # When the user has pinned a concrete source language (not "auto"), we trust
    # it: a divergent language guess on the isolated opening slice is almost
    # always a mis-transcription (e.g. English health-talk audio over music
    # mis-detected as Tamil/Telugu at high confidence), not a genuine foreign
    # intro. In that case the broad "non-Latin opening" preservation branch is
    # disabled — genuine Sanskrit/scripture intros are still caught by the
    # content-marker branches, which don't rely on Whisper's language guess.
    source_is_pinned = _normalize_language_code(source_language) not in ("", "auto")
    annotated = []
    previous_preserved = False
    for seg in segments:
        enriched = dict(seg)
        start = float(enriched.get("start", 0.0))
        text = enriched.get("text", "")
        detected_language = enriched.get("detected_language", "")
        normalized_language = _normalize_language_code(detected_language)
        normalized_tokens = set(_tokenize_text(text))
        preserve_original_audio = (
            start <= OPENING_PRESERVE_WINDOW_SEC
            and _looks_like_sanskrit_recitation(text, detected_language)
        )
        if not preserve_original_audio and start <= OPENING_PRESERVE_WINDOW_SEC:
            preserve_original_audio = _looks_like_scripture_opening_intro(text)
        if (
            not preserve_original_audio
            and previous_preserved
            and start <= OPENING_PRESERVE_WINDOW_SEC
        ):
            preserve_original_audio = bool(
                normalized_tokens and normalized_tokens.issubset(SCRIPTURE_TRANSLATION_CUES)
            )
        detected_language_probability = float(
            enriched.get("detected_language_probability", 0.0) or 0.0
        )
        if (
            not preserve_original_audio
            and not source_is_pinned
            and enriched.get("is_opening_recovery")
            and start <= OPENING_PRESERVE_WINDOW_SEC
            and normalized_language
            and normalized_language not in {"en", "english"}
            and _contains_non_latin_letters(text)
            # Only trust a non-English opening detection enough to leave the
            # audio undubbed when Whisper is genuinely confident about the
            # language. Low-confidence detections here are almost always
            # mis-transcribed English (see OPENING_PRESERVE_MIN_LANG_PROB).
            and detected_language_probability >= OPENING_PRESERVE_MIN_LANG_PROB
        ):
            preserve_original_audio = True
        enriched["preserve_original_audio"] = preserve_original_audio
        annotated.append(enriched)
        previous_preserved = preserve_original_audio
    return annotated


def _merge_opening_recovery_segments(existing_segments, recovered_segments, total_duration, source_language=""):
    existing = _normalize_segments(existing_segments, total_duration)
    recovered = _normalize_segments(recovered_segments, total_duration)
    recovered = _annotate_opening_language_segments(recovered, source_language)
    preserved_recovered = [
        seg for seg in recovered if seg.get("preserve_original_audio")
    ]
    if not preserved_recovered:
        return existing

    replacement_end = max(float(seg["end"]) for seg in preserved_recovered)
    replacement_segments = [
        seg for seg in recovered if float(seg["start"]) < (replacement_end + 0.05)
    ]
    if not replacement_segments:
        return existing

    remaining_segments = [
        seg for seg in existing if float(seg["start"]) >= (replacement_end - 0.05)
    ]
    merged = _normalize_segments(replacement_segments + remaining_segments, total_duration)
    log(
        "TRANSCRIBE",
        f"Opening recovery replaced leading transcript up to {replacement_end:.2f}s with {len(replacement_segments)} recovered segment(s)",
    )
    return merged


# Post-processing dictionary for common transcription errors
# Maps incorrect words (lowercase) to correct words
TRANSCRIPTION_FIXES = {
    # Sanskrit terms
    "avyakta": "avyakta",
    "object": "avyakta",  # Common mishearing of avyakta
    "samadhi": "Samadhi",
    "turiyatita": "Turiyatita",
    "brahman": "Brahman",
    "atman": "Atman",
    "nirvikalpa": "Nirvikalpa",
    # Proper names
    "lithyananda": "Nithyananda",
    "lithuania": "Nithyananda",
    "lithuanian": "Nithyananda",
    "nithyananda": "Nithyananda",
    "kailasa": "KAILASA",
    "paramashiva": "Paramashivam",
    "swayambhaga": "Swayambhaga",
    "swayambaha": "Swayambhaga",
    # Common words
    "uncertainity": "uncertainty",
    "avyaktha": "avyakta",
    "shit": "chit",  # common ASR mishearing of "chit"
}

# Known words and their common mishearings for auto-learn pattern matching
# Format: correct_word -> list of common mishearings
KNOWN_WORDS_MISHEARINGS = {
    # Sanskrit terms
    "avyakta": ["object", "obstruct", "abject", "a vyakta", "avyak tha"],
    "samadhi": ["somebody", "sam ahi", "some ahi", "sama dhi"],
    "turiyatita": ["turkey tita", "turi ya tita", "turi ya teeta"],
    "brahman": ["brahmin", "broad man", "bra man", "brah man"],
    "atman": ["at man", "adman", "atman", "at man"],
    "nirvikalpa": ["near vikalpa", "nir vikalpa", "near vikal fa"],
    "paramashiva": ["parama shiva", "parama sheva", "parama sheeba"],
    "paramashivam": ["parama shivam", "parama shevam", "parama sheebam"],
    # Proper names
    "nithyananda": [
        "lithyananda",
        "lithuania",
        "lithuanian",
        "nithya nanda",
        "with yananda",
        "nit ya nanda",
        "nith yananda",
    ],
    "kailasa": ["kyle asa", "kai lasa", "kai lasa", "ky lasa"],
    "kailaas": ["kyle as", "kai las", "kai laas"],
    "spH": ["s p h", "sph", "s. p. h."],
    "bhagavan": ["bhagwan", "bhagawaan", "bhag van"],
    "paramashivatma": ["parama shivatma", "parama shiva atma"],
    "swayambhaga": ["swayambaha", "svayambaha", "svayambhaga", "swayambaga"],
    # English words commonly mismisheard
    "chit": ["shit", "spit"],
}

# File to store user-approved transcription fixes
TRANSCRIPTION_FIXES_FILE = os.path.join(
    os.path.expanduser("~"), ".video_dubber_transcription_fixes.json"
)
TRANSCRIPTION_PENDING_FIXES_FILE = TRANSCRIPTION_FIXES_FILE.replace(
    ".json", "_pending.json"
)
TRANSCRIPTION_REJECTED_FIXES_FILE = TRANSCRIPTION_FIXES_FILE.replace(
    ".json", "_rejected.json"
)

# Common English words that happen to overlap with ``KNOWN_WORDS_MISHEARINGS``.
# Without this guard, auto-learn would flag legitimate English usage of these
# words as needing correction (e.g. "object" → "avyakta") and surface them as
# pending fixes the user has to review every run.
#
# Keep this list tight — only English words that appear verbatim as a listed
# mishearing. Sanskrit-in-English terms like "atman" or "brahmin" are harder
# judgement calls and are intentionally *not* allow-listed: the speaker may
# genuinely mean the Sanskrit term, and letting the user approve/reject per
# occurrence is the right move.
KNOWN_WORDS_ALLOWLIST = {
    "object",
    "objects",
    "obstruct",
    "obstructs",
    "abject",
    "somebody",
    "lithuania",
    "lithuanian",
}

# Optional user-maintained extension file (one lowercased word per line, lines
# starting with "#" ignored). Missing file is fine — built-in list stands.
TRANSCRIPTION_ALLOWLIST_FILE = os.path.join(
    os.path.expanduser("~"), ".video_dubber_transcription_allowlist.txt"
)


def _load_user_allowlist():
    """Load user-maintained allow-list entries, if any. Cached via ``_cached_user_allowlist``."""
    path = TRANSCRIPTION_ALLOWLIST_FILE
    try:
        if not os.path.exists(path):
            return set()
        with open(path, "r", encoding="utf-8") as f:
            entries = set()
            for line in f:
                word = line.strip().lower()
                if not word or word.startswith("#"):
                    continue
                entries.add(word)
            return entries
    except Exception:
        # A malformed allow-list shouldn't break transcription.
        return set()


def _get_effective_allowlist():
    """Return the union of the built-in allow-list and any user entries."""
    user_entries = _load_user_allowlist()
    if not user_entries:
        return KNOWN_WORDS_ALLOWLIST
    return KNOWN_WORDS_ALLOWLIST | user_entries


def _levenshtein_distance(s1, s2):
    """Calculate the Levenshtein distance between two strings."""
    if len(s1) < len(s2):
        return _levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)

    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row

    return previous_row[-1]


def _similar_words(word1, word2, threshold=0.75):
    """Check if two words are similar using Levenshtein distance."""
    if len(word1) < 3 or len(word2) < 3:
        return False

    word1_lower = word1.lower()
    word2_lower = word2.lower()

    # Exact match after lowercase
    if word1_lower == word2_lower:
        return True

    # Check if one contains the other (for compound words)
    if word2_lower in word1_lower or word1_lower in word2_lower:
        # Only if the shorter word is at least 60% of the longer word
        shorter = min(len(word1_lower), len(word2_lower))
        longer = max(len(word1_lower), len(word2_lower))
        if shorter / longer >= 0.6:
            return True

    # Levenshtein distance ratio
    distance = _levenshtein_distance(word1_lower, word2_lower)
    max_len = max(len(word1_lower), len(word2_lower))
    similarity = 1 - (distance / max_len)

    return similarity >= threshold


def _detect_potential_errors(transcribed_text):
    """
    Detect potential transcription errors using pattern matching.
    Returns list of (original_word, suggested_correction) tuples.
    """
    if not transcribed_text:
        return []

    suggestions = []
    words = transcribed_text.split()
    all_fixes = _get_all_fixes()
    allowlist = _get_effective_allowlist()

    for word in words:
        word_lower = word.lower().strip(".,!?;:")

        # Skip if already in fixes
        if word_lower in all_fixes:
            continue

        # Skip very short words
        if len(word_lower) < 4:
            continue

        # Skip words that are on the known-English allow-list. Without this
        # guard, every legitimate use of "object", "somebody", etc. would be
        # flagged as a pending fix requiring user review.
        if word_lower in allowlist:
            continue

        # Check each known word's common mishearings
        for correct_word, mishearings in KNOWN_WORDS_MISHEARINGS.items():
            # Check exact mishearing match
            for mishearing in mishearings:
                if word_lower == mishearing.lower():
                    suggestions.append((word, correct_word))
                    break
            else:
                # Check similarity if no exact match
                if _similar_words(word_lower, correct_word):
                    # Make sure it's not already suggested
                    if not any(s[1] == correct_word for s in suggestions):
                        suggestions.append((word, correct_word))

    return suggestions


def _auto_learn_from_transcription(transcribed_text):
    """
    Auto-learn potential transcription errors and add to pending fixes.
    Returns number of new suggestions added.
    """
    if not transcribed_text:
        return 0

    suggestions = _detect_potential_errors(transcribed_text)
    added_count = 0

    for original, correction in suggestions:
        if _suggest_fix(original, correction):
            added_count += 1

    if added_count > 0:
        log("TRANSCRIBE", f"Auto-learned {added_count} potential transcription fix(es)")

    return added_count


# Module-level cache for the user-editable fix JSON files.
# Key: path (str). Value: ((mtime_ns, size), parsed_dict).
# A missing file is cached as key=None so we don't re-stat endlessly when
# no fixes have ever been approved. Writes through _save_* bump the
# file's mtime, which naturally invalidates the cache on the next read.
_FIX_FILE_CACHE = {}


def _read_json_dict_cached(path):
    """Read a JSON file into a dict, with mtime/size-keyed memoization.

    Under normal transcription load, _get_all_fixes() is called per-word
    per-chunk, which used to reopen and re-parse the same JSON on every
    invocation (tens to hundreds of times per transcribe). Stat'ing the
    file is ~microseconds; parsing it is tens of ms — so we cache by
    (mtime_ns, size) and only re-read when one changes. External editors
    that rewrite the file bump mtime, so user edits mid-session still
    propagate on the next call.
    """
    try:
        stat = os.stat(path)
        key = (stat.st_mtime_ns, stat.st_size)
    except FileNotFoundError:
        key = None
    except Exception:
        # Unexpected stat failure — treat as missing, don't cache.
        return {}

    cached = _FIX_FILE_CACHE.get(path)
    if cached is not None and cached[0] == key:
        return cached[1]

    if key is None:
        data = {}
    else:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                data = {}
        except Exception:
            data = {}

    _FIX_FILE_CACHE[path] = (key, data)
    return data


def _invalidate_fix_cache(path):
    """Drop a file from the fix cache after a write, so the next read is fresh.

    mtime-based invalidation already handles this on most filesystems, but
    same-second writes on coarse-mtime systems (FAT, some Windows fs)
    could otherwise serve stale data. An explicit drop on write is free
    insurance.
    """
    _FIX_FILE_CACHE.pop(path, None)
    _ALL_FIXES_CACHE["key"] = _ALL_FIXES_CACHE_SENTINEL


def _load_user_fixes():
    """Load user-approved transcription fixes from file."""
    return _read_json_dict_cached(TRANSCRIPTION_FIXES_FILE)


def _save_user_fixes(fixes):
    """Save user-approved transcription fixes to file."""
    try:
        with open(TRANSCRIPTION_FIXES_FILE, "w", encoding="utf-8") as f:
            json.dump(fixes, f, indent=2, ensure_ascii=False)
        _invalidate_fix_cache(TRANSCRIPTION_FIXES_FILE)
    except Exception as e:
        log("TRANSCRIBE", f"Failed to save transcription fixes: {e}")


def _load_rejected_fixes():
    """Load user-rejected transcription fix suggestions."""
    return _read_json_dict_cached(TRANSCRIPTION_REJECTED_FIXES_FILE)


def _save_rejected_fixes(rejections):
    """Save rejected transcription fix suggestions."""
    try:
        with open(TRANSCRIPTION_REJECTED_FIXES_FILE, "w", encoding="utf-8") as f:
            json.dump(rejections, f, indent=2, ensure_ascii=False)
        _invalidate_fix_cache(TRANSCRIPTION_REJECTED_FIXES_FILE)
    except Exception as e:
        log("TRANSCRIBE", f"Failed to save rejected transcription fixes: {e}")


def _load_pending_fixes():
    """Load pending transcription fix suggestions."""
    return _read_json_dict_cached(TRANSCRIPTION_PENDING_FIXES_FILE)


def _save_pending_fixes(pending):
    """Persist pending transcription fix suggestions."""
    try:
        with open(TRANSCRIPTION_PENDING_FIXES_FILE, "w", encoding="utf-8") as f:
            json.dump(pending, f, indent=2, ensure_ascii=False)
        _invalidate_fix_cache(TRANSCRIPTION_PENDING_FIXES_FILE)
    except Exception as e:
        log("TRANSCRIBE", f"Failed to save pending transcription fixes: {e}")


# _get_all_fixes() returns TRANSCRIPTION_FIXES merged with user fixes. The
# merge itself is cheap, but it sits inside per-word hot loops during
# transcription. Cache the merged dict keyed on user-fix mtime/size so we
# only rebuild when user fixes change. A sentinel ensures the first call
# always materializes (since "no key" would otherwise collide with a
# missing-file key of None).
_ALL_FIXES_CACHE_SENTINEL = object()
_ALL_FIXES_CACHE = {"key": _ALL_FIXES_CACHE_SENTINEL, "value": None}


def _get_all_fixes():
    """Get combined fixes from built-in and user-approved (memoized)."""
    try:
        stat = os.stat(TRANSCRIPTION_FIXES_FILE)
        key = (stat.st_mtime_ns, stat.st_size)
    except FileNotFoundError:
        key = None
    except Exception:
        key = None

    if _ALL_FIXES_CACHE["key"] is not _ALL_FIXES_CACHE_SENTINEL and _ALL_FIXES_CACHE["key"] == key:
        return _ALL_FIXES_CACHE["value"]

    all_fixes = dict(TRANSCRIPTION_FIXES)
    all_fixes.update(_load_user_fixes())
    _ALL_FIXES_CACHE["key"] = key
    _ALL_FIXES_CACHE["value"] = all_fixes
    return all_fixes


def _apply_transcription_fixes(text):
    """Apply post-processing fixes to transcription text."""
    if not text:
        return text

    all_fixes = _get_all_fixes()
    words = text.split()
    fixed_words = []
    for word in words:
        # Check if word (lowercase) is in fixes
        word_lower = word.lower().strip(".,!?;:")
        if word_lower in all_fixes:
            # Preserve original capitalization pattern
            fixed = all_fixes[word_lower]
            if word[0].isupper():
                fixed = fixed.capitalize()
            fixed_words.append(fixed)
        else:
            fixed_words.append(word)

    return _normalize_protected_phrases(" ".join(fixed_words))


def _suggest_fix(original_word, suggested_word):
    """Suggest a transcription fix for user approval."""
    user_fixes = _load_user_fixes()
    rejected_fixes = _load_rejected_fixes()

    # Check if already in built-in or user fixes
    word_lower = original_word.lower()
    if word_lower in TRANSCRIPTION_FIXES or word_lower in user_fixes:
        return False  # Already have a fix for this word

    rejected_for_word = rejected_fixes.get(word_lower, [])
    if suggested_word in rejected_for_word:
        return False

    # Add to pending suggestions
    pending = _load_pending_fixes()

    if word_lower not in pending:
        pending[word_lower] = suggested_word
        try:
            _save_pending_fixes(pending)
            log(
                "TRANSCRIBE", f"  Suggested fix: '{original_word}' → '{suggested_word}'"
            )
            return True
        except Exception:
            pass

    return False


def get_pending_fixes():
    """Get pending transcription fixes for user review."""
    return _load_pending_fixes()


def approve_fixes(fixes_to_approve):
    """Approve pending transcription fixes and add to permanent dictionary."""
    pending = get_pending_fixes()
    user_fixes = _load_user_fixes()

    approved_count = 0
    for word, correction in fixes_to_approve.items():
        if word in pending:
            user_fixes[word.lower()] = correction
            approved_count += 1

    if approved_count > 0:
        _save_user_fixes(user_fixes)
        # Clear approved items from pending
        remaining = {k: v for k, v in pending.items() if k not in fixes_to_approve}
        _save_pending_fixes(remaining)
        log("TRANSCRIBE", f"Approved {approved_count} transcription fixes")

    return approved_count


def reject_fixes(fixes_to_reject):
    """Reject pending transcription fixes so they stop reappearing."""
    pending = get_pending_fixes()
    rejected = _load_rejected_fixes()
    rejected_count = 0

    for word, correction in fixes_to_reject.items():
        word_lower = str(word or "").lower()
        correction = str(correction or "").strip()
        if word_lower not in pending:
            continue
        rejected[word_lower] = list(
            dict.fromkeys(list(rejected.get(word_lower, [])) + [correction])
        )
        rejected_count += 1

    if rejected_count > 0:
        remaining = {k: v for k, v in pending.items() if k not in fixes_to_reject}
        _save_rejected_fixes(rejected)
        _save_pending_fixes(remaining)
        log("TRANSCRIBE", f"Rejected {rejected_count} transcription fixes")

    return rejected_count


def clear_pending_fixes():
    """Clear all pending transcription fixes."""
    try:
        if os.path.exists(TRANSCRIPTION_PENDING_FIXES_FILE):
            os.remove(TRANSCRIPTION_PENDING_FIXES_FILE)
    except Exception:
        pass


def _extract_audio(video_path, out_wav):
    r = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            video_path,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-f",
            "wav",
            out_wav,
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if r.returncode != 0 or not os.path.exists(out_wav):
        raise RuntimeError(
            f"Audio extraction failed for {video_path}: {r.stderr[-400:]}"
        )


def _split_audio(wav_path, output_dir, chunk_sec=600):
    """Split audio into chunks if over 25MB."""
    size_mb = os.path.getsize(wav_path) / (1024 * 1024)
    if size_mb <= MAX_FILE_MB:
        return [wav_path]
    chunks = []
    i = 0
    while True:
        chunk_path = os.path.join(output_dir, f"chunk_{i:03d}.wav")
        r = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                wav_path,
                "-ss",
                str(i * chunk_sec),
                "-t",
                str(chunk_sec),
                "-ar",
                "16000",
                "-ac",
                "1",
                chunk_path,
            ],
            capture_output=True,
        )
        if r.returncode != 0 or not os.path.exists(chunk_path):
            break
        if os.path.getsize(chunk_path) < 1000:
            break
        chunks.append(chunk_path)
        i += 1
    return chunks


def _local_transcribe(
    audio_path, language, model_size, output_dir, vad_filter=True, beam_size=2
):
    lang_code = language if language and language != "auto" else None

    try:
        from faster_whisper import WhisperModel

        # Device is env-configurable so the same code runs CPU on the desktop
        # (default) and GPU on a CUDA host (e.g. Colab). Set WHISPER_DEVICE=cuda
        # to enable the GPU; compute_type defaults sensibly per device but can
        # be overridden with WHISPER_COMPUTE_TYPE.
        device = (os.getenv("WHISPER_DEVICE", "cpu").strip().lower() or "cpu")
        default_compute = "float16" if device == "cuda" else "int8"
        compute_type = (
            os.getenv("WHISPER_COMPUTE_TYPE", default_compute).strip().lower()
            or default_compute
        )
        cache_key = (model_size, device, compute_type)
        model = _WHISPER_MODEL_CACHE.get(cache_key)
        if model is None:
            log(
                "TRANSCRIBE",
                f"Local Whisper (faster-whisper): {model_size} "
                f"on {device}/{compute_type} (loading model)",
            )
            model = WhisperModel(model_size, device=device, compute_type=compute_type)
            _WHISPER_MODEL_CACHE[cache_key] = model
        else:
            log(
                "TRANSCRIBE",
                f"Local Whisper (faster-whisper): {model_size} (cached)",
            )
        fw_segments, info = model.transcribe(
            audio_path,
            language=lang_code,
            beam_size=beam_size,
            vad_filter=vad_filter,
        )
        detected = getattr(info, "language", language)
        detected_prob = float(getattr(info, "language_probability", 0.0) or 0.0)
        segments = []
        for i, seg in enumerate(fw_segments):
            text = (getattr(seg, "text", "") or "").strip()
            if not text:
                continue
            # Apply transcription fixes to correct common errors
            fixed_text = _apply_transcription_fixes(text)
            segments.append(
                {
                    "id": i,
                    "start": round(float(seg.start), 3),
                    "end": round(float(seg.end), 3),
                    "text": fixed_text,
                    "detected_language": detected,
                    "detected_language_probability": detected_prob,
                }
            )
        log(
            "TRANSCRIBE",
            f"Lang: {detected} p={getattr(info, 'language_probability', 0):.2f}",
        )
        return segments, detected
    except Exception as e:
        raise RuntimeError(
            "Local transcription failed. Install faster-whisper "
            "(pip install faster-whisper) and ensure model weights are reachable."
        ) from e


# Raw VAD/ASR segments shorter than this are almost always noise (breath,
# click, silence mislabel) and produce chipmunk-TTS artifacts because the
# dub pipeline must time-compress TTS audio to fit the tiny slot. Dropping
# them preserves dubbing quality at the cost of losing genuine sub-100ms
# spoken content, which is rare in natural speech.
MIN_RAW_SEGMENT_DURATION = 0.10  # seconds


def _normalize_segments(segments, total_duration=None):
    normalized = []
    dropped_short = 0
    for seg in sorted(segments, key=lambda s: (float(s.get("start", 0.0)), float(s.get("end", 0.0)))):
        text = (seg.get("text") or "").strip()
        if not _looks_like_spoken_text(text):
            continue
        start = max(float(seg.get("start", 0.0)), 0.0)
        end = max(float(seg.get("end", start)), start)
        if total_duration is not None:
            start = min(start, total_duration)
            end = min(end, total_duration)
        duration = end - start
        # Subtract a small float-tolerance so nominally-100ms segments aren't
        # dropped due to floating-point representation (e.g., 4.1-4.0 = 0.0999…).
        if duration < MIN_RAW_SEGMENT_DURATION - 1e-6:
            dropped_short += 1
            log(
                "TRANSCRIBE",
                f"  Dropping sub-{int(MIN_RAW_SEGMENT_DURATION * 1000)}ms segment "
                f"({duration * 1000:.0f}ms) text={text[:40]!r}",
            )
            continue
        normalized.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
                **{
                    k: v
                    for k, v in seg.items()
                    if k not in {"id", "start", "end", "text"}
                },
            }
        )

    if dropped_short:
        log(
            "TRANSCRIBE",
            f"Dropped {dropped_short} sub-{int(MIN_RAW_SEGMENT_DURATION * 1000)}ms segment(s) "
            "as likely VAD noise",
        )

    for i, seg in enumerate(normalized):
        seg["id"] = i
    return normalized


def _build_uncovered_ranges(segments, total_duration):
    ranges = []
    cursor = 0.0
    for seg in sorted(segments, key=lambda s: s["start"]):
        start = max(0.0, min(float(seg["start"]), total_duration))
        end = max(start, min(float(seg["end"]), total_duration))
        if start > cursor:
            ranges.append((round(cursor, 3), round(start, 3)))
        cursor = max(cursor, end)
    if cursor < total_duration:
        ranges.append((round(cursor, 3), round(total_duration, 3)))
    return ranges


def _should_probe_range(start, end, total_duration):
    gap = end - start
    near_edge = start <= 1.0 or (total_duration - end) <= 1.0
    min_gap = MIN_EDGE_GAP_PROBE_SEC if near_edge else max(MIN_GAP_PROBE_SEC, 1.5)
    return gap >= min_gap


def _extract_audio_range(src_wav, start, end, output_path):
    duration = max(end - start, 0.0)
    if duration <= 0.0:
        return False
    r = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            str(round(start, 3)),
            "-i",
            src_wav,
            "-t",
            str(round(duration, 3)),
            "-ar",
            PROBE_AUDIO_SAMPLE_RATE,
            "-ac",
            PROBE_AUDIO_CHANNELS,
            output_path,
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    return (
        r.returncode == 0
        and os.path.exists(output_path)
        and os.path.getsize(output_path) > MIN_PROBE_AUDIO_BYTES
    )


def _probe_range_for_segments(
    start,
    end,
    wav_path,
    output_dir,
    language,
    model_size,
):
    probe_name = f"probe_{int(start * 1000):010d}_{int(end * 1000):010d}"
    probe_dir = os.path.join(output_dir, "coverage_probes")
    os.makedirs(probe_dir, exist_ok=True)
    probe_audio_path = os.path.join(probe_dir, f"{probe_name}.wav")
    if not _extract_audio_range(wav_path, start, end, probe_audio_path):
        return []

    try:
        raw_segments, _ = _local_transcribe(
            probe_audio_path,
            language,
            model_size,
            probe_dir,
            vad_filter=True,
            beam_size=1,
        )
        if not raw_segments:
            # No-VAD retry. Keep beam_size low: a high beam here made Whisper
            # spend minutes thrashing on intro music/silence for a 12s slice.
            raw_segments, _ = _local_transcribe(
                probe_audio_path,
                language,
                model_size,
                probe_dir,
                vad_filter=False,
                beam_size=1,
            )
    except Exception as e:
        log(
            "TRANSCRIBE",
            f"Coverage probe failed for {start:.2f}s-{end:.2f}s: {e}",
        )
        return []

    discovered = []
    for seg in raw_segments:
        text = (seg.get("text") or "").strip()
        seg_rel_start = float(seg.get("start", 0.0))
        seg_rel_end = float(seg.get("end", seg_rel_start))
        seg_duration = max(seg_rel_end - seg_rel_start, 0.0)
        if not _looks_like_probe_speech(text, seg_duration):
            continue
        seg_start = start + seg_rel_start
        seg_end = start + seg_rel_end
        seg_end = min(seg_end, end)
        if seg_end <= seg_start:
            seg_end = min(end, seg_start + 0.05)
        discovered.append(
            {
                "start": round(seg_start, 3),
                "end": round(seg_end, 3),
                "text": text,
                "is_gap_probe": True,
                "detected_language": seg.get("detected_language", ""),
                "detected_language_probability": float(
                    seg.get("detected_language_probability", 0.0) or 0.0
                ),
                "probe_range_start": round(start, 3),
                "probe_range_end": round(end, 3),
            }
        )

    if discovered:
        log(
            "TRANSCRIBE",
            f"Coverage probe found {len(discovered)} segment(s) in {start:.2f}s-{end:.2f}s",
        )
    else:
        log(
            "TRANSCRIBE",
            f"Coverage probe found no speech in {start:.2f}s-{end:.2f}s",
        )
    return discovered


def _audit_speech_coverage(
    segments,
    total_duration,
    wav_path,
    output_dir,
    language,
    model_size,
):
    normalized = _normalize_segments(segments, total_duration)
    gap_segments = []
    for start, end in _build_uncovered_ranges(normalized, total_duration):
        if not _should_probe_range(start, end, total_duration):
            continue
        gap_segments.extend(
            _probe_range_for_segments(
                start,
                end,
                wav_path,
                output_dir,
                language,
                model_size,
            )
        )

    if gap_segments:
        log(
            "TRANSCRIBE",
            f"Coverage audit recovered {len(gap_segments)} additional speech segment(s)",
        )
    return _normalize_segments(normalized + gap_segments, total_duration)


def _recover_opening_mixed_language(
    segments,
    total_duration,
    wav_path,
    output_dir,
    language,
    model_size,
    detected_language="",
):
    normalized_language = _normalize_language_code(language)
    # When the user chose "auto", fall back to whatever the bulk transcribe
    # pass detected so we still re-probe the opening. Without this, short
    # opening recitations in a different language (e.g., a Sanskrit invocation
    # before the main English talk) never get a second look and stay
    # mis-attached to the surrounding English segment.
    if not normalized_language or normalized_language == "auto":
        normalized_language = _normalize_language_code(detected_language)
    if not normalized_language or normalized_language == "auto":
        return _annotate_opening_language_segments(
            _normalize_segments(segments, total_duration), language
        )

    probe_end = min(total_duration, OPENING_RECOVERY_WINDOW_SEC)
    if probe_end <= 0.5:
        return _annotate_opening_language_segments(
            _normalize_segments(segments, total_duration), language
        )

    # The re-probe itself is still language-free (None): we want Whisper to
    # re-detect on the isolated opening slice. The bulk language above is
    # only the gate that lets us reach this call path under auto-detect.
    recovered = _probe_range_for_segments(
        0.0,
        probe_end,
        wav_path,
        output_dir,
        None,
        model_size,
    )
    if not recovered:
        return _annotate_opening_language_segments(
            _normalize_segments(segments, total_duration), language
        )
    for seg in recovered:
        seg["is_opening_recovery"] = True

    merged = _merge_opening_recovery_segments(segments, recovered, total_duration, language)
    return _annotate_opening_language_segments(merged, language)


def transcribe_audio(
    video_path,
    output_dir,
    model_size="large",
    language="auto",
    prefer_local=False,
):
    """Transcribe ``video_path`` with local Whisper (faster-whisper).

    ``prefer_local`` is retained as a behavioural flag: when True, skip the
    gap-coverage audit and opening-language recovery passes. The dub
    verifier sets it because Whisper's built-in VAD/timestamps are already
    accurate enough for chunked verification and the extra probes would
    waste runtime. For the main pipeline pass we want the full audit, so
    callers there pass ``prefer_local=False``.
    """
    os.makedirs(output_dir, exist_ok=True)
    wav_path = os.path.join(output_dir, "audio.wav")
    _extract_audio(video_path, wav_path)

    log("TRANSCRIBE", f"Using local Whisper (faster-whisper) (lang={language}) ...")
    segments, detected = _local_transcribe(
        wav_path, language, model_size, output_dir
    )

    total_duration = _ffprobe_duration(video_path)
    if prefer_local:
        # Verifier path: trust local Whisper's segmentation as-is — its VAD
        # and timestamp logic is already good enough for coverage
        # comparison and the extra audit/recovery passes are pure overhead.
        segments = _normalize_segments(segments, total_duration)
    else:
        segments = _audit_speech_coverage(
            segments,
            total_duration,
            wav_path,
            output_dir,
            language,
            model_size,
        )
        segments = _recover_opening_mixed_language(
            segments,
            total_duration,
            wav_path,
            output_dir,
            language,
            model_size,
            detected_language=detected,
        )

    # Auto-learn potential transcription errors
    log("TRANSCRIBE", "Running auto-learn for transcription fixes...")
    full_text = " ".join(seg.get("text", "") for seg in segments)
    _auto_learn_from_transcription(full_text)

    out_path = os.path.join(output_dir, "transcript.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(segments, f, ensure_ascii=False, indent=2)
    log("TRANSCRIBE", f"{len(segments)} segments -> {out_path}")
    return segments
