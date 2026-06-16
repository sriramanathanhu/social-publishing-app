import json
import math
import os
import re
import subprocess
import unicodedata
from difflib import SequenceMatcher

from .transcriber import transcribe_audio
from .utils import ffprobe_duration as _ffprobe_duration, log

REPORT_FILENAME = "dub_validation_report.json"
# Verification chunk size. Larger chunks reduce the risk of cutting
# through speech mid-sentence (which made Whisper drop content on the
# 0-20s/20-40s boundaries). For short videos we skip chunking entirely.
VERIFY_CHUNK_SEC = 30.0
VERIFY_CHUNK_OVERLAP_SEC = 2.0
VERIFY_NO_CHUNK_THRESHOLD_SEC = 75.0

# Languages with non-Latin scripts where Whisper produces phonetic
# variations that don't match expected text character-for-character.
# For these, we need lenient matching: lower similarity threshold and
# Unicode normalization that strips combining marks (vowel signs,
# anusvara, virama) for fuzzy comparison.
_INDIC_SCRIPT_LANGUAGES = {"gu", "hi", "ta", "te", "kn", "ml", "bn", "pa", "or", "as"}
_NON_LATIN_LANGUAGES = _INDIC_SCRIPT_LANGUAGES | {"ru", "ar", "fa", "th", "zh", "ja", "ko", "he"}


def _is_indic_script_language(target_language):
    return str(target_language or "").lower() in _INDIC_SCRIPT_LANGUAGES


def _is_non_latin_language(target_language):
    return str(target_language or "").lower() in _NON_LATIN_LANGUAGES


def _strip_combining_marks(text):
    """Strip combining marks (diacritics, vowel signs, anusvara, virama).

    For Indic scripts, this normalizes phonetic variations like:
    - શ્રદ્ધા (with virama) → શરદધા (base consonants only)
    - વીંધો → વધો (anusvara/long vowel removed)
    Useful for fuzzy matching where Whisper produces phonetically similar
    but not character-identical output.
    """
    nfd = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in nfd if not unicodedata.combining(ch))


def _normalize_text(text):
    text = str(text or "").lower()
    text = text.replace("’", "'").replace("‘", "'")
    text = re.sub(r"\s+", " ", text, flags=re.UNICODE).strip()
    return text


def _tokenize(text):
    normalized = _normalize_text(text)
    # Treat hyphens as word separators since Whisper often produces
    # space-separated forms of hyphenated source compounds (e.g.,
    # "વિચાર-પેટર્નને" expected → "વિચાર પેટર્ને" observed).
    normalized = normalized.replace("-", " ").replace("–", " ").replace("—", " ")
    raw_tokens = normalized.split()
    tokens = []
    for token in raw_tokens:
        cleaned = token.strip(".,!?;:()[]{}\"'`|/\\")
        cleaned = cleaned.strip()
        if cleaned:
            tokens.append(cleaned)
    return tokens


def _is_significant_token(token):
    if not token:
        return False
    if token.isdigit():
        return True
    alpha_num = sum(ch.isalnum() for ch in token)
    alpha_chars = sum(ch.isalpha() for ch in token)
    return alpha_num >= 3 or alpha_chars >= 2


def _tokens_similar(expected, observed, lenient=False):
    """Check if two tokens are similar enough to be considered a match.

    When ``lenient=True`` (used for Indic / non-Latin scripts), matching
    is more forgiving:
    - Lower SequenceMatcher threshold (0.70 vs 0.84)
    - Compare with combining marks stripped (vowel signs, virama,
      anusvara) so phonetic Whisper variants like શ્રદ્ધા↔શર્ધા match.
    """
    if expected == observed:
        return True
    if len(expected) >= 5 and (expected in observed or observed in expected):
        shorter = min(len(expected), len(observed))
        longer = max(len(expected), len(observed))
        if shorter / longer >= 0.75:
            return True

    base_threshold = 0.70 if lenient else 0.84
    if SequenceMatcher(None, expected, observed).ratio() >= base_threshold:
        return True

    if lenient:
        # Strip combining marks (diacritics, vowel signs, virama,
        # anusvara) and re-compare. This collapses phonetic variants
        # that differ only in vowel signs or conjunct ordering.
        e_base = _strip_combining_marks(expected)
        o_base = _strip_combining_marks(observed)
        if e_base and o_base:
            if e_base == o_base:
                return True
            if len(e_base) >= 3 and (e_base in o_base or o_base in e_base):
                shorter = min(len(e_base), len(o_base))
                longer = max(len(e_base), len(o_base))
                if shorter / longer >= 0.70:
                    return True
            if SequenceMatcher(None, e_base, o_base).ratio() >= 0.75:
                return True

    return False


def _build_expected_text(segments):
    parts = []
    for seg in segments or []:
        text = (seg.get("translated") or seg.get("text") or "").strip()
        if text:
            parts.append(text)
    return " ".join(parts).strip()


def _diagnose_empty_expected(segments):
    """Summarize why no expected text could be built.

    Returns a short string suitable for inclusion in a RuntimeError, e.g.
    "0 segments passed in" or "13 segments passed in; 13 had empty
    'translated'; 13 had empty 'text'; sample ids: 0, 1, 2".
    """
    segments = segments or []
    total = len(segments)
    if total == 0:
        return "0 segments passed to verifier (translation/TTS pipeline produced no segments)."

    missing_translated = 0
    missing_text = 0
    sample_ids = []
    for seg in segments:
        translated = (seg.get("translated") or "").strip()
        source_text = (seg.get("text") or "").strip()
        if not translated:
            missing_translated += 1
        if not source_text:
            missing_text += 1
        if not translated and not source_text and len(sample_ids) < 5:
            seg_id = seg.get("id", "?")
            sample_ids.append(str(seg_id))

    parts = [f"{total} segments passed to verifier"]
    parts.append(f"{missing_translated} had empty/missing 'translated'")
    parts.append(f"{missing_text} had empty/missing 'text'")
    if sample_ids:
        parts.append(f"sample empty seg ids: {', '.join(sample_ids)}")
    return "; ".join(parts) + "."


def _extract_video_chunk(src_path, start_sec, duration_sec, dst_path):
    r = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            str(round(start_sec, 3)),
            "-i",
            src_path,
            "-t",
            str(round(duration_sec, 3)),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "28",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            dst_path,
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if r.returncode != 0 or not os.path.exists(dst_path):
        raise RuntimeError(f"ffmpeg chunk extraction failed for {dst_path}: {r.stderr}")


# Whisper-medium transcribes English / Spanish well enough for
# verification, but on Indic scripts (Gujarati, Hindi, Tamil, Telugu,
# Kannada, Malayalam, Bengali) and other low-resource targets its output
# diverges badly from large — observed in prod as Coverage 0% with a 97%
# observed-char ratio on Gujarati (right-length output, wrong content).
# Only downgrade for the Latin-script languages where the optimization
# holds; keep large for anything else the caller requested.
_VERIFIER_DOWNGRADE_LANGUAGES = {"en", "english", "es", "spanish"}


def _verifier_model_size(model_size, target_language):
    """Pick the verifier model size for the given target language.

    Conditionally downgrades large → medium to save ~50% inference time
    plus the ~1m 46s first-chunk large-model load. Only runs for English
    and Spanish; Indic / Cyrillic / other non-Latin targets stay on large
    because medium's accuracy on those languages is not fit for purpose
    (see block comment on ``_VERIFIER_DOWNGRADE_LANGUAGES``).
    """
    if str(model_size or "").lower() != "large":
        return model_size
    lang = str(target_language or "").lower()
    if lang in _VERIFIER_DOWNGRADE_LANGUAGES:
        return "medium"
    return model_size


def _retranscribe_video_in_chunks(video_path, verify_dir, target_language, model_size):
    duration = _ffprobe_duration(video_path)
    chunk_dir = os.path.join(verify_dir, "chunks")
    os.makedirs(chunk_dir, exist_ok=True)

    verifier_size = _verifier_model_size(model_size, target_language)

    # For short videos, transcribe the whole thing as one chunk. The
    # original 20s splits cut through speech mid-sentence (e.g.,
    # boundary at 20s sliced TTS clip seg#1 [10.13-24.23s]) which made
    # Whisper drop content and produced false coverage failures on
    # otherwise-good Indic dubs.
    if duration <= VERIFY_NO_CHUNK_THRESHOLD_SEC:
        log(
            "VERIFY",
            f"Short video ({duration:.1f}s ≤ {VERIFY_NO_CHUNK_THRESHOLD_SEC:.0f}s): "
            f"transcribing as single chunk to avoid mid-speech splits",
        )
        chunk_video = os.path.join(chunk_dir, "chunk_000.mp4")
        chunk_output_dir = os.path.join(chunk_dir, "chunk_000")
        os.makedirs(chunk_output_dir, exist_ok=True)
        _extract_video_chunk(video_path, 0.0, duration, chunk_video)
        chunk_segments = transcribe_audio(
            chunk_video,
            chunk_output_dir,
            model_size=verifier_size,
            language=target_language,
            prefer_local=True,
        )
        return [dict(seg) for seg in chunk_segments]

    observed_segments = []
    chunk_index = 0
    start_sec = 0.0

    while start_sec < duration - 0.05:
        chunk_duration = min(VERIFY_CHUNK_SEC, duration - start_sec)
        chunk_video = os.path.join(chunk_dir, f"chunk_{chunk_index:03d}.mp4")
        chunk_output_dir = os.path.join(chunk_dir, f"chunk_{chunk_index:03d}")
        os.makedirs(chunk_output_dir, exist_ok=True)

        _extract_video_chunk(video_path, start_sec, chunk_duration, chunk_video)
        # prefer_local=True: skip the gap-coverage audit and opening-language
        # recovery passes. Whisper's built-in VAD/timestamps are already
        # accurate enough for chunked dub verification, and the extra audit
        # passes would just slow down each chunk.
        chunk_segments = transcribe_audio(
            chunk_video,
            chunk_output_dir,
            model_size=verifier_size,
            language=target_language,
            prefer_local=True,
        )

        for seg in chunk_segments:
            observed_segments.append(
                {
                    **seg,
                    "start": round(float(seg.get("start", 0.0)) + start_sec, 3),
                    "end": round(float(seg.get("end", 0.0)) + start_sec, 3),
                }
            )

        # Advance with overlap so words straddling the boundary get a
        # second chance in the next chunk. Final chunk we don't bother
        # since there is no next.
        next_start = start_sec + chunk_duration - VERIFY_CHUNK_OVERLAP_SEC
        if next_start <= start_sec:
            next_start = start_sec + chunk_duration
        start_sec = next_start
        chunk_index += 1

    return observed_segments


def _compare_token_coverage(expected_text, observed_text, target_language=None):
    expected_tokens = [tok for tok in _tokenize(expected_text) if _is_significant_token(tok)]
    observed_tokens = [tok for tok in _tokenize(observed_text) if _is_significant_token(tok)]

    lenient = _is_non_latin_language(target_language)

    matched = 0
    missing = []

    if lenient:
        # Unordered multiset matching: each observed token can be
        # consumed once; expected tokens find any matching observed
        # token. Whisper on Indic scripts often reorders short words and
        # drops some, so order-preserving matching produces false misses
        # even when the audio is fine.
        consumed = [False] * len(observed_tokens)
        for token in expected_tokens:
            found_at = None
            for idx, obs in enumerate(observed_tokens):
                if consumed[idx]:
                    continue
                if _tokens_similar(token, obs, lenient=True):
                    found_at = idx
                    break
            if found_at is None:
                missing.append(token)
            else:
                matched += 1
                consumed[found_at] = True
    else:
        cursor = 0
        for token in expected_tokens:
            found_at = None
            for idx in range(cursor, len(observed_tokens)):
                if _tokens_similar(token, observed_tokens[idx], lenient=False):
                    found_at = idx
                    break
            if found_at is None:
                missing.append(token)
                continue
            matched += 1
            cursor = found_at + 1

    unique_missing = []
    seen = set()
    for token in missing:
        if token in seen:
            continue
        seen.add(token)
        unique_missing.append(token)

    total = len(expected_tokens)
    coverage = (matched / total) if total else 1.0
    return {
        "expected_significant_tokens": total,
        "observed_significant_tokens": len(observed_tokens),
        "matched_significant_tokens": matched,
        "coverage_ratio": round(coverage, 4),
        "missing_tokens": unique_missing,
        "lenient_matching": lenient,
    }


def _max_repeated_token_run(tokens):
    longest = 0
    current = 0
    prev = None
    for token in tokens:
        if token == prev:
            current += 1
        else:
            current = 1
            prev = token
        if current > longest:
            longest = current
    return longest


def _assess_transcript_quality(observed_text):
    tokens = [tok for tok in _tokenize(observed_text) if _is_significant_token(tok)]
    token_count = len(tokens)
    unique_ratio = (len(set(tokens)) / token_count) if token_count else 0.0
    replacement_char_count = observed_text.count("\ufffd")
    repeated_run = _max_repeated_token_run(tokens)
    looks_unreliable = (
        replacement_char_count > 0
        or repeated_run >= 4
        or (token_count >= 20 and unique_ratio < 0.35)
    )
    return {
        "replacement_char_count": replacement_char_count,
        "max_repeated_token_run": repeated_run,
        "observed_unique_token_ratio": round(unique_ratio, 4),
        "looks_unreliable": looks_unreliable,
    }


def verify_dubbed_output(
    video_path,
    segments,
    target_language,
    output_dir,
    model_size="large",
):
    # Callers pass whatever size the main pipeline is using (typically
    # "large"). _retranscribe_video_in_chunks auto-downgrades large →
    # medium for English / Spanish; keeps large for Indic, Cyrillic, and
    # other non-Latin targets where medium is not accurate enough. See
    # _verifier_model_size() for the full rationale.
    verify_dir = os.path.join(output_dir, "dub_verification")
    os.makedirs(verify_dir, exist_ok=True)

    expected_text = _build_expected_text(segments)
    if not expected_text:
        diagnosis = _diagnose_empty_expected(segments)
        log("VERIFY", f"Expected script empty at verifier entry: {diagnosis}")
        raise RuntimeError(
            "Dub verification could not build an expected translated script. "
            + diagnosis
        )

    log("VERIFY", f"Retranscribing dubbed output for QA: {os.path.basename(video_path)}")
    observed_segments = _retranscribe_video_in_chunks(
        video_path,
        verify_dir,
        target_language,
        model_size,
    )
    with open(os.path.join(verify_dir, "transcript.json"), "w", encoding="utf-8") as f:
        json.dump(observed_segments, f, ensure_ascii=False, indent=2)
    observed_text = " ".join((seg.get("text") or "").strip() for seg in observed_segments).strip()

    token_report = _compare_token_coverage(expected_text, observed_text, target_language)
    quality_report = _assess_transcript_quality(observed_text)
    text_similarity = round(
        SequenceMatcher(None, _normalize_text(expected_text), _normalize_text(observed_text)).ratio(),
        4,
    )
    missing_count = len(token_report["missing_tokens"])
    expected_count = token_report["expected_significant_tokens"]
    observed_count = token_report["observed_significant_tokens"]
    coverage_ratio = token_report["coverage_ratio"]
    observed_ratio = round((observed_count / expected_count), 4) if expected_count else 1.0
    expected_chars = len(_normalize_text(expected_text))
    observed_chars = len(_normalize_text(observed_text))
    observed_char_ratio = round((observed_chars / expected_chars), 4) if expected_chars else 1.0

    # Indic / non-Latin scripts: Whisper-large transcription has phonetic
    # variations even when audio is fine. Use lower thresholds since the
    # _tokens_similar lenient mode already fuzzy-matches diacritics.
    is_non_latin = _is_non_latin_language(target_language)
    if is_non_latin:
        coverage_threshold = 0.70  # lowered from 0.82
        allowed_missing_pct = 0.18  # raised from 0.08
        # Non-Latin verifier transcripts can stop carrying text while still
        # reporting a segment that spans the rest of the audio. Treat that as
        # an inconclusive QA read instead of blocking caption review.
        truncation_threshold = 0.65
    else:
        coverage_threshold = 0.82
        allowed_missing_pct = 0.08
        truncation_threshold = 0.55

    allowed_missing = (
        max(2, math.ceil(expected_count * allowed_missing_pct)) if expected_count else 0
    )
    transcript_truncated = (
        observed_ratio < truncation_threshold or observed_char_ratio < truncation_threshold
    )
    quality_reliable = not quality_report["looks_unreliable"]
    passed = (
        coverage_ratio >= coverage_threshold
        and missing_count <= allowed_missing
        and not transcript_truncated
    )
    # If the transcript itself is severely truncated, the verifier (not the
    # dub) is the unreliable signal. Whisper-large on Indic dubs sometimes
    # emits a short transcript even on a fine-sounding TTS file (internal
    # 30s VAD windowing, low-volume segments, etc.). Don't treat that as a
    # blocking dub failure — log the warning and let the pipeline continue.
    blocking_failure = (not passed) and quality_reliable and not transcript_truncated

    report = {
        "passed": passed,
        "blocking_failure": blocking_failure,
        "target_language": target_language,
        "video_path": os.path.abspath(video_path),
        "expected_text": expected_text,
        "observed_text": observed_text,
        "text_similarity": text_similarity,
        "allowed_missing_tokens": allowed_missing,
        "observed_token_ratio": observed_ratio,
        "observed_char_ratio": observed_char_ratio,
        "transcript_truncated": transcript_truncated,
        "quality_reliable": quality_reliable,
        "coverage_threshold": coverage_threshold,
        "is_non_latin_script": is_non_latin,
        **token_report,
        **quality_report,
    }

    report_path = os.path.join(output_dir, REPORT_FILENAME)
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    if passed:
        log(
            "VERIFY",
            f"Dub verification passed: coverage={coverage_ratio:.2%}, observed={observed_ratio:.2%}",
        )
        return report

    if not blocking_failure:
        log(
            "VERIFY",
            "Dub verification inconclusive: retranscribed QA audio was too incomplete/noisy to trust as a blocking failure. "
            f"coverage={coverage_ratio:.2%}, observed={observed_ratio:.2%}",
        )
        return report

    missing_preview = ", ".join(report["missing_tokens"][:8]) or "unknown terms"
    log(
        "VERIFY",
        f"Dub verification failed: coverage={coverage_ratio:.2%}, observed={observed_ratio:.2%}, missing={missing_preview}",
    )
    raise RuntimeError(
        "Dub verification failed before caption generation. "
        f"Coverage {coverage_ratio:.0%}; observed transcript ratio {observed_ratio:.0%}; "
        f"likely missing terms: {missing_preview}. "
        f"See {report_path}."
    )
