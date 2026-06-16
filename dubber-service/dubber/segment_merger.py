import re

from .utils import log

MIN_THOUGHT_DURATION = 2.2
MAX_THOUGHT_DURATION = 12.0
SOFT_GAP = 0.55
HARD_GAP = 1.1
# Absolute ceiling for the scaled HARD_GAP; larger pauses almost always
# represent a scene/thought break and should never be merged.
HARD_GAP_MAX = 2.0
# Fraction of the max segment duration used to scale HARD_GAP. For long
# thoughts (slow pacing, meditative content) this allows larger pauses
# between continuation clauses to still merge into one thought group.
HARD_GAP_DURATION_SCALE = 0.15
MIN_STANDALONE_DUB_DURATION = 0.45
LOW_INFO_FRAGMENT_MAX_WORDS = 2

INCOMPLETE_ENDINGS = (
    ",",
    ":",
    ";",
    "-",
    " and",
    " or",
    " but",
    " so",
    " because",
    " that",
    " which",
    " who",
    " where",
    " when",
    " while",
    " if",
    " then",
    " than",
    " the",
    " a",
    " an",
    " to",
    " of",
    " in",
    " on",
    " for",
    " with",
    " from",
    " by",
    " is",
    " are",
    " was",
    " were",
    " be",
    " it",
    " there",
    " this",
)

CONTINUATION_STARTS = {
    "and",
    "or",
    "but",
    "so",
    "because",
    "that",
    "which",
    "who",
    "where",
    "when",
    "while",
    "then",
    "than",
    "if",
    "to",
    "of",
    "for",
    "with",
    "in",
    "on",
    "by",
    "it",
    "there",
    "this",
    "these",
    "those",
    "he",
    "she",
    "they",
    "you",
    "we",
}

LOW_INFO_STANDALONE_WORDS = CONTINUATION_STARTS | {
    "yes",
    "no",
    "okay",
    "ok",
    "well",
    "also",
}

TRAILING_GARBAGE_KEEP_PATTERNS = (
    r"\bnithyanandam\b",
    r"\bnithyananda\b",
)
TRAILING_GARBAGE_PATTERNS = (
    r"\bsubtitles?\s+by\s+the\s+amara(?:\.org)?\s+community\b",
    r"\bamara(?:\.org)?\b",
    r"\bdubbing\s+(?:done|complete|completed)\b",
    r"\bdubbing\s+was\s+done\b",
    r"\bdubbed\s+by\b",
    r"\bcaption(?:s)?\s+(?:done|generated|complete|completed)\b",
)


def _first_word(text):
    cleaned = (text or "").strip().lower()
    if not cleaned:
        return ""
    return cleaned.split()[0].strip("\"'([{")


def _word_tokens(text):
    cleaned = (text or "").strip().lower()
    if not cleaned:
        return []
    return [token.strip("\"'()[]{}.,!?;:-") for token in cleaned.split() if token.strip("\"'()[]{}.,!?;:-")]


def _is_complete_thought(text):
    cleaned = (text or "").strip()
    if not cleaned:
        return False
    lower = cleaned.lower().rstrip()
    if lower.endswith(("...", ",")):
        return False
    if cleaned.endswith((".", "!", "?")):
        return True
    return not any(lower.endswith(token) for token in INCOMPLETE_ENDINGS)


def _effective_hard_gap(cur_dur, nxt_dur):
    """Pace-aware HARD_GAP.

    Longer segments indicate slower delivery; the natural pause between
    continuation clauses scales with overall pace. Scale HARD_GAP by the
    max segment duration, floored at the base HARD_GAP and capped at
    HARD_GAP_MAX so we never merge across true scene/thought breaks.
    """
    scaled = HARD_GAP_DURATION_SCALE * max(float(cur_dur), float(nxt_dur))
    return min(HARD_GAP_MAX, max(HARD_GAP, scaled))


def _should_merge(current, nxt):
    cur_dur = current["end"] - current["start"]
    nxt_dur = nxt["end"] - nxt["start"]
    combined_dur = nxt["end"] - current["start"]
    gap = nxt["start"] - current["end"]
    protected = current.get("is_gap_probe") or nxt.get("is_gap_probe")

    if combined_dur > MAX_THOUGHT_DURATION:
        return False
    effective_hard_gap = _effective_hard_gap(cur_dur, nxt_dur)
    if gap >= effective_hard_gap:
        return False
    if protected and gap > 0.18:
        return False

    current_complete = current.get("is_complete_thought", _is_complete_thought(current.get("text")))
    next_starts_like_continuation = _first_word(nxt.get("text")) in CONTINUATION_STARTS
    short_group = cur_dur < MIN_THOUGHT_DURATION or nxt_dur < MIN_THOUGHT_DURATION

    if gap <= 0.12:
        return True
    if (not current_complete or next_starts_like_continuation) and gap <= SOFT_GAP:
        return True
    if short_group and gap <= 0.22:
        return True
    return False


def _build_group(segs):
    start = segs[0]["start"]
    end = segs[-1]["end"]
    text = " ".join((seg.get("text") or "").strip() for seg in segs if (seg.get("text") or "").strip())
    pauses = []
    prev_end = start
    for seg in segs:
        pauses.append(round(max(seg["start"] - prev_end, 0.0), 3))
        prev_end = seg["end"]
    source_segments = [
        {
            "id": seg.get("id"),
            "start": round(seg["start"], 3),
            "end": round(seg["end"], 3),
            "text": seg.get("text", ""),
            "is_gap_probe": bool(seg.get("is_gap_probe")),
            "detected_language": seg.get("detected_language", ""),
            "preserve_original_audio": bool(seg.get("preserve_original_audio", False)),
        }
        for seg in segs
    ]
    detected_languages = [
        str(seg.get("detected_language", "")).strip() for seg in segs if str(seg.get("detected_language", "")).strip()
    ]
    return {
        "start": round(start, 3),
        "end": round(end, 3),
        "group_start": round(start, 3),
        "group_end": round(end, 3),
        "text": text,
        "source_segments": source_segments,
        "pause_before": round(segs[0].get("pause_before", 0.0), 3),
        "source_pauses": pauses,
        "is_gap_probe": any(seg.get("is_gap_probe") for seg in segs),
        "is_complete_thought": _is_complete_thought(text),
        "detected_language": detected_languages[0] if detected_languages else "",
        "preserve_original_audio": any(
            bool(seg.get("preserve_original_audio", False)) for seg in segs
        ),
    }


def _is_tiny_low_information_group(group):
    duration = float(group["end"] - group["start"])
    tokens = _word_tokens(group.get("text", ""))
    if duration >= MIN_STANDALONE_DUB_DURATION:
        return False
    if len(tokens) == 0 or len(tokens) > LOW_INFO_FRAGMENT_MAX_WORDS:
        return False

    if all(token in LOW_INFO_STANDALONE_WORDS for token in tokens):
        return True

    # Very short orphaned fragments like "you" or "and then" are usually ASR debris,
    # especially when they do not form a complete thought of their own.
    if not group.get("is_complete_thought", False) and all(len(token) <= 4 for token in tokens):
        return True

    return False


def _normalized_text(text):
    return re.sub(r"\s+", " ", str(text or "")).strip().lower()


def _is_trailing_garbage_group(group):
    text = _normalized_text(group.get("text", ""))
    if not text:
        return False

    if any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in TRAILING_GARBAGE_KEEP_PATTERNS):
        return False

    return any(re.search(pattern, text, flags=re.IGNORECASE) for pattern in TRAILING_GARBAGE_PATTERNS)


def merge_short_segments(segments):
    if not segments:
        return segments

    segs = []
    prev_end = 0.0
    for seg in sorted(segments, key=lambda s: s["start"]):
        enriched = dict(seg)
        enriched["pause_before"] = round(max(enriched["start"] - prev_end, 0.0), 3)
        enriched["is_complete_thought"] = _is_complete_thought(enriched.get("text", ""))
        segs.append(enriched)
        prev_end = enriched["end"]

    groups = []
    current_group = [segs[0]]
    for nxt in segs[1:]:
        current = _build_group(current_group)
        if _should_merge(current, nxt):
            current_group.append(nxt)
        else:
            groups.append(_build_group(current_group))
            current_group = [nxt]
    groups.append(_build_group(current_group))

    filtered_groups = []
    dropped = 0
    for group in groups:
        if _is_tiny_low_information_group(group):
            log(
                "SEG_MERGE",
                f"Dropping tiny standalone fragment: '{group.get('text', '').strip()}' "
                f"({group['end'] - group['start']:.2f}s)",
            )
            dropped += 1
            continue
        filtered_groups.append(group)

    groups = filtered_groups

    if len(groups) > 1 and _is_trailing_garbage_group(groups[-1]):
        log(
            "SEG_MERGE",
            f"Dropping trailing garbage: '{groups[-1].get('text', '').strip()}'",
        )
        groups = groups[:-1]
        dropped += 1

    for i, seg in enumerate(groups):
        seg["id"] = i

    suffix = f" ({dropped} tiny fragment(s) dropped)" if dropped else ""
    log("SEG_MERGE", f"{len(segs)} -> {len(groups)} thought groups{suffix}")
    return groups
