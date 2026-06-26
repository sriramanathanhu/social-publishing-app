import os, json, time
import httpx
import re
from .config import (
    get_glm_api_key,
    get_glm_base_url,
    get_glm_max_tokens,
    get_glm_model,
    is_glm_caption_eval_enabled,
)
from .runtime_config import is_economy_mode, is_quality_mode
from .utils import (
    log,
    PLATFORM_LIMITS,
    SHORT_MINIMUMS,
    REQUIRED_PLATFORMS,
    PLATFORMS,
    OPTIMAL_RANGES,
    track_api_call,
    track_api_success,
)

TAGS4 = "#KAILASA #Nithyananda"
TAGS3 = "#KAILASA #Nithyananda"
TAGS2 = "#KAILASA"
BULLET = "•"
TARGET_TOTAL_HASHTAGS = 4

# The only hashtags the user wants on every caption — no generated/extra tags,
# no @mentions. Enforced as a post-process so it holds regardless of the model.
FIXED_HASHTAGS = "#nithyananda #kailasa"


def _force_two_hashtags(text: str, append: bool = True) -> str:
    """Remove every hashtag and @mention the model produced; optionally append
    exactly the two fixed tags. Unicode-aware so language hashtags are stripped."""
    if not text:
        return text
    # A hashtag/mention = # or @ (not mid-word, so emails / C# survive) followed
    # by the whole non-space token — works for any script incl. Devanagari/Tamil.
    t = re.sub(r"(?<!\w)[#@]\S+", "", text)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r" *\n", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    return f"{t}\n\n{FIXED_HASHTAGS}" if append else t

MAX_TRANSCRIPT_CHARS = 3000
SAFE_CAPTION_LIMITS = {
    "twitter": 250,
}
MAX_SOURCE_DESCRIPTION_CHARS = 3500

LANGUAGE_META = {
    "gu": {
        "name": "Gujarati",
        "style": "Use devotional Gujarati with natural Sanskrit terms where they fit.",
        "script_hint": "Write in Gujarati script.",
        "script_ranges": [(0x0A80, 0x0AFF)],
    },
    "hi": {
        "name": "Hindi",
        "style": "Use devotional Hindi with natural Sanskrit terms where they fit.",
        "script_hint": "Write in Devanagari script.",
        "script_ranges": [(0x0900, 0x097F)],
    },
    "ta": {
        "name": "Tamil",
        "style": "Use natural spoken Tamil with devotional warmth and Sanskrit terms only where they fit naturally.",
        "script_hint": "Write in Tamil script.",
        "script_ranges": [(0x0B80, 0x0BFF)],
    },
    "te": {
        "name": "Telugu",
        "style": "Use natural spoken Telugu with devotional warmth and Sanskrit terms only where they fit naturally.",
        "script_hint": "Write in Telugu script.",
        "script_ranges": [(0x0C00, 0x0C7F)],
    },
    "kn": {
        "name": "Kannada",
        "style": "Use natural spoken Kannada with devotional warmth and Sanskrit terms only where they fit naturally.",
        "script_hint": "Write in Kannada script.",
        "script_ranges": [(0x0C80, 0x0CFF)],
    },
    "ml": {
        "name": "Malayalam",
        "style": "Use natural spoken Malayalam with devotional warmth and Sanskrit terms only where they fit naturally.",
        "script_hint": "Write in Malayalam script.",
        "script_ranges": [(0x0D00, 0x0D7F)],
    },
    "sw": {
        "name": "Swahili",
        "style": "Use natural spoken Kenyan Swahili with devotional warmth; keep Sanskrit terms only where they fit naturally.",
        "script_hint": "Write in Swahili (Latin script).",
        "script_ranges": [(0x0041, 0x005A), (0x0061, 0x007A), (0x00C0, 0x00FF)],
    },
    "es": {
        "name": "Spanish",
        "style": "Use clear devotional Spanish that sounds natural to a native speaker.",
        "script_hint": "Write in Spanish.",
        "script_ranges": [],
    },
    "ru": {
        "name": "Russian",
        "style": "Use clear devotional Russian that sounds natural to a native speaker.",
        "script_hint": "Write in Cyrillic Russian.",
        "script_ranges": [(0x0400, 0x04FF)],
    },
    "en": {
        "name": "English",
        "style": "Use clear devotional English.",
        "script_hint": "Write in English.",
        "script_ranges": [],
    },
}

CAPTION_PLATFORM_ORDER = list(PLATFORMS)

# Platform-specific caption overrides
PLATFORM_OVERRIDES = {
    "twitter": {"max_hashtags": 2, "hook_ratio": 0.35, "min_body": 30},
    "threads": {"max_hashtags": 4, "hook_ratio": 0.35, "min_body": 30},
    "instagram": {"hook_ratio": 0.45, "min_body": 50},
    "facebook": {"hook_ratio": 0.40, "min_body": 50, "paragraph_spacing": True},
    "tiktok": {"max_hashtags": 5, "hook_ratio": 0.40, "min_body": 30},
    "bluesky": {"max_hashtags": 4, "hook_ratio": 0.35, "min_body": 30},
    "youtube": {"hook_ratio": 0.40, "min_body": 80},
}

# Trim constants
SEPARATOR = "\n\n"
MIN_HOOK_CHARS = 50
MIN_BODY_THRESHOLD = 30

# Words to avoid ending on
STOP_WORDS = {
    "and",
    "but",
    "or",
    "the",
    "a",
    "an",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "shall",
    "can",
    "need",
    "dare",
    "ought",
    "used",
}

# Hashtag pattern - handles #AI-tools, #climate_change
HASHTAG_PATTERN = re.compile(r"#\w[\w\-]*")


def _get_platform_config(platform):
    return PLATFORM_OVERRIDES.get(
        platform, {"hook_ratio": 0.4, "min_body": MIN_BODY_THRESHOLD}
    )


def _language_meta(target_language):
    return LANGUAGE_META.get(
        target_language,
        {
            "name": str(target_language or "target language"),
            "style": f"Use natural devotional {target_language}.",
            "script_hint": f"Write in {target_language}.",
            "script_ranges": [],
        },
    )


def _normalize_target_platforms(target_platforms=None):
    if not target_platforms:
        return list(CAPTION_PLATFORM_ORDER)
    selected = []
    allowed = set(CAPTION_PLATFORM_ORDER)
    for platform in target_platforms:
        key = str(platform or "").strip().lower()
        if key in allowed and key not in selected:
            selected.append(key)
    return selected or list(CAPTION_PLATFORM_ORDER)


def _build_prompt(
    main_topic,
    key_message,
    theme,
    transcript="",
    target_language="gu",
    target_platforms=None,
):
    meta = _language_meta(target_language)
    target_name = meta["name"]
    target_style = meta["style"]
    script_hint = meta["script_hint"]
    selected_platforms = _normalize_target_platforms(target_platforms)
    selected_keys = ", ".join(selected_platforms)
    if len(transcript) > MAX_TRANSCRIPT_CHARS:
        transcript = transcript[:MAX_TRANSCRIPT_CHARS] + "..."
        log("CAPTION", f"  Transcript capped at {MAX_TRANSCRIPT_CHARS} chars")
    transcript_block = (
        f"=== FULL TRANSCRIPT ({target_name}) ===\n{transcript}\n\n"
        if transcript
        else ""
    )
    return f"""SYSTEM: You are a devoted disciple of The Supreme Pontiff of Hinduism, Bhagavan Sri Nithyananda Paramashivam.
Your task is to craft social media captions that transmit sacred spiritual energy, reverence, and the transformative power of His teachings.
Speak as if guiding fellow disciples seeking inner awakening.
Write every caption in {target_name}. {target_style}
Each sentence should feel as if Guru's grace is flowing through it. Convey blessings, truths, and practices as experienced through the Guru's grace.
Do not invent ideas; remain fully faithful to the transcript.
{script_hint}
Generate captions ONLY for these platforms: {selected_keys}.
Adjust tone per platform:
- Instagram = punchy devotional energy, awakening curiosity.
- Facebook = nurturing reflection, guidance for inner peace.
- Threads/Bluesky = concise, spiritually resonant teaching.
- TikTok = energetic, recitable, spiritually uplifting.
- Twitter = declarative, Guru-guided statement.
- YouTube = detailed spiritual insights, structured for blessing, practice, transformation, and key teachings.

=== SOURCE ===
Topic: {main_topic or ""}
Key Message: {key_message or ""}
Theme: {theme or "teaching"}

{transcript_block}=== PLATFORM BRIEFS ===

GLOBAL HASHTAG RULE:
- Aim for 4 total hashtags per platform including the fixed required tags whenever fit and platform rules allow.
- For platforms that allow generated hashtags, add enough relevant devotional hashtags before the fixed required tags to approach that total without breaking trim, tone, or platform limits.

INSTAGRAM (max 1800 chars):
- Hook: one punchy devotional line directly quoting or paraphrasing from transcript, invoking inner awakening or Guru's blessing.
- 4 bullet points (•), each highlighting a blessing, a teaching, or a disciple practice from transcript. Each should connect to inner experience or practice.
- Add relevant devotional hashtags based on video content before the fixed tags so the total hashtag count aims for 4.
- End with: [YOUR_GENERATED_HASHTAGS] #KAILASA #Nithyananda

FACEBOOK (max 1800 chars):
- Hook: speak directly to a disciple seeking peace, reflection, or devotion; different from Instagram. Should feel nurturing and contemplative.
- 4 bullet points (•), each highlighting a different blessing, teaching, or practice from transcript than Instagram bullets.
- Add relevant devotional hashtags based on video content before the fixed tags so the total hashtag count aims for 4.
- End with: [YOUR_GENERATED_HASHTAGS] #KAILASA #Nithyananda

THREADS (max 350 chars including hashtags):
- Hook line from transcript; concise devotional tone.
- 2 complete sentences summarizing key teaching, blessing, or transformative practice for disciples.
- Include EXACTLY 4 total hashtags: 3 relevant devotional ones from video content, then the fixed tag #KAILASA at the end. Do NOT return fewer than 4.
- End with: [YOUR_GENERATED_HASHTAGS] #KAILASA
- Minimum 200 chars. Maximum 350 chars. Count carefully.

TWITTER (target 180-240 chars; hard ceiling 250 including hashtags):
- Hook + one follow-up sentence. Both complete, declarative, and devotional, reflecting Guru's guidance and blessings.
- Prioritize conveying the spiritual essence concisely.
- End with: #KAILASA #Nithyananda
- Minimum 180 chars. Maximum 240 chars preferred. Never exceed 250 chars. Count carefully.

TIKTOK (max 180 chars including hashtags):
- ONE complete punchy devotional sentence directly from transcript; spiritually uplifting, recitable aloud, and energetic.
- Include EXACTLY 4 total hashtags: 2 relevant devotional ones from video content, then the fixed tags #KAILASA #Nithyananda at the end. Do NOT return fewer than 4.
- End with: [YOUR_GENERATED_HASHTAGS] #KAILASA #Nithyananda
- Minimum 120 chars. Maximum 180 chars. Count carefully.

BLUESKY (max 260 chars including hashtags):
- Hook sentence + one follow-up; both complete and devotional.
- Include EXACTLY 4 total hashtags: 3 relevant devotional ones from video content, then the fixed tag #KAILASA at the end. Do NOT return fewer than 4.
- End with: [YOUR_GENERATED_HASHTAGS] #KAILASA
- Minimum 180 chars. Maximum 260 chars. Count carefully.

YOUTUBE (max 4500 chars):
- Hook line from transcript; devotional tone.
- 5 bullet points (•), structured as: 1) Blessing, 2) Practical disciple practice, 3) Transformation, 4-5) Key spiritual insights. Full sentences.
- Leave blank line between sections.
- Add relevant devotional hashtags based on video content before fixed tags so the total hashtag count aims for 4.
- End with: [YOUR_GENERATED_HASHTAGS] #KAILASA #Nithyananda.
- Provide "title" field: max 75 chars, punchy devotional {target_name} title from transcript.

=== CRITICAL RULES ===
1. Every caption must be a COMPLETE thought; no mid-sentence cutoffs.
2. Instagram and Facebook hooks and bullets must be DIFFERENT in content and devotional angle.
3. All platforms with hashtags must end with proper punctuation before hashtags.
4. Respect minimum and maximum character limits on all platforms.
5. Zero English except fixed hashtags; maintain devotional {target_name} throughout.
6. Hashtags must be relevant to video content and spiritually aligned.
7. Aim for 4 total hashtags including fixed required tags, but use fewer whenever platform limits, trim safety, or tone require it.
8. Twitter uses only fixed tags: #KAILASA #Nithyananda.
9. Each bullet or sentence must convey blessing, awakening, or sacred practice as per Guru's teaching.
10. Tone and energy should align with platform guidance as described above.
11. **CRITICAL: ALWAYS include required hashtags - NO EXCEPTIONS:**
   - Instagram, Facebook, YouTube, TikTok: MUST end with #KAILASA #Nithyananda
   - Threads, Bluesky: MUST end with #KAILASA
   - Failure to include required hashtags will cause regeneration

=== OUTPUT ===
Valid JSON only. No markdown fences. Output EXACTLY these keys only: {selected_keys}
Values: {{"caption": "...{target_name.lower()}..."}} — youtube also includes: {{"title": "...max 75 chars...", "caption": "..."}}
"""


_URL_PATTERN = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_YT_VIDEO_ID_PATTERN = re.compile(
    r"(?:youtu\.be/|youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|v/))([A-Za-z0-9_-]{11})",
    re.IGNORECASE,
)


def _strip_urls_for_prompt(text):
    """Remove http(s)/www URLs from text shown to the LLM in the source-first prompt.

    The dubbed video has its own publishing URL; the source video URL must not
    leak into generated captions. Surrounding text is preserved.
    """
    if not text:
        return text
    cleaned = _URL_PATTERN.sub("", text)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r" *\n", "\n", cleaned)
    return cleaned.strip()


def _source_video_url_variants(source_metadata):
    """Return URL patterns that identify the source video.

    For YouTube sources we match all common URL shapes that carry the same
    11-character video id (watch, shorts, embed, youtu.be, m.youtube, etc.)
    so any one of them is stripped. For non-YouTube sources we just match
    the webpage_url verbatim.
    """
    if not source_metadata:
        return []
    webpage_url = _extract_str((source_metadata or {}).get("webpage_url", "")).strip()
    if not webpage_url:
        return []
    patterns = [re.escape(webpage_url)]
    yt_match = _YT_VIDEO_ID_PATTERN.search(webpage_url)
    if yt_match:
        vid = yt_match.group(1)
        patterns.append(
            r"(?:https?://)?(?:www\.|m\.)?youtube\.com/(?:watch\?(?:[^\s]*&)?v="
            + re.escape(vid)
            + r"(?:&[^\s]*)?|shorts/" + re.escape(vid) + r"|embed/" + re.escape(vid)
            + r"|v/" + re.escape(vid) + r")"
        )
        patterns.append(r"(?:https?://)?youtu\.be/" + re.escape(vid) + r"(?:\?[^\s]*)?")
    return patterns


def _strip_source_video_url(caption, source_metadata):
    """Remove the source video URL from a finished caption.

    Strips the URL itself only — does NOT remove surrounding CTA text. The
    caller may end up with a dangling trailing colon like "વિડિયો જુઓ: "
    which is acceptable per product decision; we only collapse whitespace
    artefacts left behind by URL removal.
    """
    if not caption:
        return caption
    patterns = _source_video_url_variants(source_metadata)
    if not patterns:
        return caption
    cleaned = caption
    for pat in patterns:
        cleaned = re.sub(pat, "", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    cleaned = re.sub(r" +\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _extract_source_metadata_parts(source_metadata):
    source_metadata = source_metadata or {}
    description = _extract_str(source_metadata.get("description", "")).strip()
    title = _extract_str(source_metadata.get("title", "")).strip()
    tags = source_metadata.get("tags") or []
    if not isinstance(tags, list):
        tags = [str(tags)]
    clean_tags = [str(tag).strip().lstrip("#") for tag in tags if str(tag).strip()]
    description_body, description_hashtags = _extract_trailing_hashtags(description)
    description_body, description_cta = _extract_cta_links(description_body)
    if not description_body.strip() and description.strip():
        description_body = description.strip()
    if len(description_body) > MAX_SOURCE_DESCRIPTION_CHARS:
        description_body = description_body[:MAX_SOURCE_DESCRIPTION_CHARS] + "..."
    return {
        "title": title,
        "description": description,
        "body": description_body.strip(),
        "cta": description_cta.strip(),
        "hashtags": description_hashtags.strip(),
        "tags": clean_tags,
        "webpage_url": _extract_str(source_metadata.get("webpage_url", "")).strip(),
        "uploader": _extract_str(source_metadata.get("uploader", "")).strip(),
        "extractor": _extract_str(source_metadata.get("extractor", "")).strip(),
    }


def _has_usable_source_metadata(source_metadata):
    parts = _extract_source_metadata_parts(source_metadata)
    body_len = len(parts["body"] or parts["description"])
    has_tags = bool(parts["hashtags"] or parts["tags"])
    has_cta = bool(parts["cta"] or parts["webpage_url"])
    return body_len >= 80 or (body_len >= 40 and (has_tags or has_cta)) or (
        body_len >= 20 and has_tags and has_cta
    )


def _build_source_first_prompt(
    vision_data,
    source_metadata,
    transcript="",
    target_language="gu",
    target_platforms=None,
):
    meta = _language_meta(target_language)
    target_name = meta["name"]
    target_style = meta["style"]
    script_hint = meta["script_hint"]
    selected_platforms = _normalize_target_platforms(target_platforms)
    selected_keys = ", ".join(selected_platforms)
    source_parts = _extract_source_metadata_parts(source_metadata)
    transcript = str(transcript or "").strip()
    if len(transcript) > MAX_TRANSCRIPT_CHARS:
        transcript = transcript[:MAX_TRANSCRIPT_CHARS] + "..."
    transcript_block = (
        f"=== TRANSCRIPT SAFETY CONTEXT ({target_name}) ===\n{transcript}\n\n"
        if transcript
        else ""
    )
    source_tags = ", ".join(f"#{tag}" for tag in source_parts["tags"]) or "(none)"
    source_hashtags = source_parts["hashtags"] or "(none)"
    sanitized_body = _strip_urls_for_prompt(source_parts["body"])
    sanitized_cta = _strip_urls_for_prompt(source_parts["cta"])
    source_cta = sanitized_cta or "(none)"
    return f"""SYSTEM: You are adapting an existing social media post into platform-specific captions for a dubbed spiritual video.
Write every caption in {target_name}. {target_style}
{script_hint}
Preserve the original post's intent and useful hashtags where natural, but adapt them to sound fluent and devotional in {target_name}.
Do not invent claims not supported by the source description or transcript.
Generate captions ONLY for these platforms: {selected_keys}.

=== SOURCE POST METADATA ===
Title: {source_parts["title"]}
Uploader: {source_parts["uploader"]}
Extractor: {source_parts["extractor"]}
Original Description Body:
{sanitized_body}

Original CTA (URLs removed):
{source_cta}

Original Hashtag Block:
{source_hashtags}

Original Tags:
{source_tags}

=== VIDEO CONTEXT ===
Topic: {vision_data.get("main_topic", "")}
Key Message: {(vision_data.get("core_conflict", "") + " | " + vision_data.get("provocative_angle", "")).strip(" |")}
Theme: {vision_data.get("theme", "teaching")}

{transcript_block}=== ADAPTATION RULES ===
1. Source-first: use the original description as the primary basis for hooks, body text, and hashtags.
2. Translate and adapt; do not mechanically copy English phrases unless they are required fixed hashtags.
3. NEVER include the original video's URL or any link to the source video. This caption will be published alongside the dubbed video itself, so a link back to the original is not needed.
4. Preserve relevant source hashtags when useful, aiming for 4 total hashtags including required platform hashtags whenever fit and platform rules allow.
5. If the source description is too sparse for a platform, fill only from transcript/context; do not fabricate.
6. Respect current platform tone and character limits exactly.

=== PLATFORM BRIEFS ===
INSTAGRAM / FACEBOOK:
- Build from the original description.
- Can reuse devotional themes and key phrases, but adapt hooks/body separately per platform.
- Do NOT add a link to the original/source video.

THREADS / BLUESKY / TWITTER:
- Shorter adaptations of the same source message.
- Do NOT add a link to the original/source video.

TIKTOK:
- One punchy source-first devotional sentence.
- Do NOT add a link to the original/source video.

YOUTUBE:
- Use source title as inspiration but rewrite a clean target-language title.
- Caption can be fuller; do NOT include a link to the original/source video.

=== CRITICAL RULES ===
1. Every caption must be a COMPLETE thought.
2. Instagram and Facebook should not be identical.
3. Respect minimum and maximum character limits.
4. Zero English except fixed hashtags when target language requires non-Latin script.
5. Aim for 4 total hashtags including required platform hashtags whenever fit and platform rules allow, but use fewer when necessary.
6. Required hashtags must still be present:
   - Instagram, Facebook, YouTube, TikTok, Twitter: #KAILASA #Nithyananda
   - Threads, Bluesky: #KAILASA
7. Never output an http://, https://, or www. URL pointing to the source video.

=== OUTPUT ===
Valid JSON only. Output EXACTLY these keys only: {selected_keys}
Values: {{"caption": "..."}} — youtube also includes: {{"title": "...", "caption": "..."}}
"""


def _extract_str(val):
    if isinstance(val, str):
        return val
    if isinstance(val, dict):
        for k in ("caption", "text", "content"):
            v = val.get(k)
            if isinstance(v, str):
                return v
            if isinstance(v, dict):
                for k2 in ("caption", "text", "content"):
                    if isinstance(v.get(k2), str):
                        return v[k2]
    return str(val) if val else ""


def _normalize(raw):
    result = {}
    for p, data in raw.items():
        if isinstance(data, str):
            result[p] = {"caption": data}
        elif isinstance(data, dict):
            entry = {"caption": _extract_str(data.get("caption", data))}
            if p == "youtube":
                entry["title"] = _extract_str(data.get("title", ""))
            result[p] = entry
        else:
            result[p] = {"caption": str(data)}
    return result


def _validate_schema(captions, target_platforms=None):
    required = set(_normalize_target_platforms(target_platforms))
    missing = required - set(captions.keys())
    empty = [p for p in required if not captions.get(p, {}).get("caption", "").strip()]
    return missing, empty


# -----------------------------------------------------------------------------
# Length validators — split into two concerns with distinct remediation:
#   * truncated  → LLM cut off mid-generation; retry with an explicit shorter
#                  target so the model can finish cleanly.
#   * expanded   → output exceeds PLATFORM_LIMITS; trim locally with
#                  _priority_aware_trim (preserves hashtags + CTA).
# -----------------------------------------------------------------------------

_TRUNCATION_SENTENCE_ENDINGS = (".", "!", "?", "\"", "'", ")", "]", "”", "’")


def _looks_truncated(caption):
    """Heuristic: caption appears to have been cut off by the LLM mid-output.

    Signs:
      * Ends mid-word (last token is a plain alphanumeric with no terminal
        punctuation and isn't a complete hashtag/emoji).
      * Dangling "..." not preceded by a completed sentence.
      * Ends with an incomplete hashtag token like bare '#' or '#x'.

    False when the caption ends with sentence punctuation, a quote, a bracket,
    a complete hashtag, or a non-ASCII character (emoji, CJK, Indic scripts).
    """
    s = str(caption or "").rstrip()
    if not s:
        return False

    # Dangling trailing ellipsis with no sentence completing before it.
    if s.endswith("..."):
        body = s[:-3].rstrip()
        if not body.endswith(_TRUNCATION_SENTENCE_ENDINGS):
            return True
        # Otherwise the ellipsis is stylistic after a finished sentence.

    last_char = s[-1]
    if last_char in _TRUNCATION_SENTENCE_ENDINGS:
        return False
    # Non-ASCII ending is usually an emoji or script-native char → complete.
    if ord(last_char) > 127:
        return False

    tokens = s.split()
    if not tokens:
        return False
    last_token = tokens[-1]

    # Complete hashtag: '#' + at least one alphanumeric character.
    if last_token.startswith("#"):
        body = last_token[1:].replace("_", "").replace("-", "")
        if body and body.isalnum():
            return False
        # Bare '#' or '#-' etc. is a truncation signal.
        return True

    # Plain word without terminal punctuation → mid-word cut.
    if last_token[-1].isalnum():
        return True

    return False


def _validate_caption_length(captions, target_platforms=None):
    """Split captions into (truncated, expanded) remediation buckets.

    Returns two lists of platform names. A single caption can appear in both
    (e.g., an IG caption that's over-limit AND looks cut off); handled by the
    calling code in order: truncated-retry first, then expansion-trim.
    """
    truncated = []
    expanded = []
    platforms = _normalize_target_platforms(target_platforms) if target_platforms else list(captions.keys())
    for p in platforms:
        data = captions.get(p) or {}
        caption = str(data.get("caption", ""))
        if not caption.strip():
            continue  # empty captions handled by _validate_schema
        hard_lim = PLATFORM_LIMITS.get(p, 2000)
        if len(caption) > hard_lim:
            expanded.append(p)
        if _looks_truncated(caption):
            truncated.append(p)
    return truncated, expanded


def _smart_trim(text, limit, min_words=5):
    """Trim text to limit, preferring sentence/word boundaries.
    Avoids ending on stop words and ensures minimum word count.
    """
    if len(text) <= limit:
        return text

    t = text[:limit]

    # Try sentence boundary first
    for sep in [".", "!", "?", "\n"]:
        idx = t.rfind(sep)
        if idx > limit * 0.5:
            trimmed = t[: idx + 1].strip()
            # Check minimum words
            if len(trimmed.split()) >= min_words:
                # Avoid ending on stop words
                last_word = trimmed.split()[-1].lower().strip(".,!?")
                if last_word not in STOP_WORDS:
                    return trimmed

    # Try word boundary
    idx = t.rfind(" ")
    if idx > limit * 0.7:
        trimmed = t[:idx].strip()
        if len(trimmed.split()) >= min_words:
            last_word = trimmed.split()[-1].lower().strip(".,!?")
            if last_word not in STOP_WORDS:
                return trimmed + "..."

    # Last resort: hard cut, but try to avoid stop words
    words = t.split()
    while (
        words
        and words[-1].lower().strip(".,!?") in STOP_WORDS
        and len(" ".join(words)) > limit * 0.5
    ):
        words.pop()
    trimmed = " ".join(words)
    if trimmed and len(trimmed) < len(text):
        return trimmed.rstrip(".,!?") + "..."

    return t + "..."


def _effective_limit(platform):
    return SAFE_CAPTION_LIMITS.get(platform, PLATFORM_LIMITS.get(platform, 2000))


def _sanitize_caption_text(text, newline_before_tags=True):
    """Normalize generated caption text for publishing."""
    s = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    # Remove stray leading/trailing quotes occasionally produced by LLM output.
    s = re.sub(r'^[\s"“”\'‘’`]+', "", s)
    s = re.sub(r'[\s"“”\'‘’`]+$', "", s)
    # Strip Markdown emphasis markers that should not appear in published captions.
    s = re.sub(r"\*\*(.*?)\*\*", r"\1", s)
    s = re.sub(r"__(.*?)__", r"\1", s)
    # Normalize markdown list bullets to platform-friendly bullet symbol.
    s = re.sub(r"(?m)^\s*[-*]\s+", f"{BULLET} ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)

    if newline_before_tags and "#" in s:
        tag_idx = s.find("#")
        if tag_idx > 0:
            head = s[:tag_idx].rstrip()
            tags = s[tag_idx:].lstrip()
            if head and not head.endswith("\n"):
                s = f"{head}\n\n{tags}"
            elif head:
                s = f"{head}\n{tags}"
            else:
                s = tags
    return s


def _append_required_hashtags(platform, caption):
    text = str(caption or "").strip()
    lower = text.lower()
    needed = []
    if platform in {"instagram", "facebook", "youtube", "tiktok", "twitter"}:
        if "#kailasa" not in lower:
            needed.append("#KAILASA")
        if "#nithyananda" not in lower:
            needed.append("#Nithyananda")
    elif platform in {"threads", "bluesky"}:
        if "#kailasa" not in lower:
            needed.append("#KAILASA")

    if not needed:
        return text
    sep = "\n\n" if text and "#" not in text else " "
    return (text + sep + " ".join(needed)).strip()


def _required_hashtag_list(platform):
    if platform in {"instagram", "facebook", "youtube", "tiktok", "twitter"}:
        return ["#KAILASA", "#Nithyananda"]
    if platform in {"threads", "bluesky"}:
        return ["#KAILASA"]
    return []


def _extract_hashtag_tokens(text):
    return HASHTAG_PATTERN.findall(str(text or ""))


def _build_hashtag_block(required_tags, optional_tags):
    tags = []
    for tag in required_tags + optional_tags:
        if tag and tag not in tags:
            tags.append(tag)
    return " ".join(tags).strip()


def _target_total_hashtags(platform):
    required_count = len(_required_hashtag_list(platform))
    max_hashtags = _get_platform_config(platform).get("max_hashtags")
    target_total = TARGET_TOTAL_HASHTAGS
    if max_hashtags is not None:
        target_total = min(target_total, max_hashtags)
    return max(required_count, target_total)


def _target_optional_hashtags(platform):
    return max(0, _target_total_hashtags(platform) - len(_required_hashtag_list(platform)))


def _hashtag_target_needs_retry(platform, caption):
    target_total = _target_total_hashtags(platform)
    if target_total <= len(_required_hashtag_list(platform)):
        return False
    current_tags = _extract_hashtag_tokens(caption)
    if len(current_tags) >= target_total:
        return False
    hard_limit = _effective_limit(platform)
    return len(caption) < max(0, hard_limit - 24)


def _contains_target_script(text, target_language):
    if not text:
        return False
    ranges = _language_meta(target_language).get("script_ranges", [])
    if not ranges:
        return True
    total = len(text)
    hits = 0
    for c in text:
        code = ord(c)
        if any(start <= code <= end for start, end in ranges):
            hits += 1
    return (hits / max(total, 1)) > 0.2


def _extract_trailing_hashtags(text):
    """Extract trailing hashtag block from caption.
    Handles: #AI #GovTech, #AI-tools, #climate_change, and mixed spacing.
    Detects: Lines with >=2 hashtags OR hashtag density>50%.
    """
    if not text:
        return text, ""

    lines = text.strip().split("\n")
    hashtag_block = []

    # Scan from end to find trailing hashtag block
    for line in reversed(lines):
        stripped = line.strip()
        if not stripped:
            if hashtag_block:
                break
            continue

        # Extract hashtags using regex (handles #-and underscores)
        hashtags_in_line = HASHTAG_PATTERN.findall(stripped)

        # Calculate hashtag density
        hashtag_chars = sum(len(h) for h in hashtags_in_line)
        non_hashtag_chars = len(re.sub(r"#\w[\w\-]*", "", stripped))

        # Check: >=2 hashtags OR hashtag density >50%
        if len(hashtags_in_line) >= 2 or (
            hashtag_chars > non_hashtag_chars and len(hashtags_in_line) > 0
        ):
            hashtag_block.insert(0, stripped)
        else:
            break

    if hashtag_block:
        body = "\n".join(
            lines[: -len(hashtag_block)] if len(hashtag_block) < len(lines) else lines
        )
        return body.strip(), "\n".join(hashtag_block)

    return text, ""


def _extract_cta_links(text):
    """Extract CTA phrases and URLs from caption."""
    if not text:
        return text, ""

    inline_match = re.search(
        r"(?i)(watch the full|link in bio|subscribe|learn more|join us|sign up|full video|click here|follow us).*?(https?://\S+|www\.\S+)?\s*$",
        text.strip(),
    )
    if inline_match:
        cta_text = inline_match.group(0).strip()
        cta_text = re.sub(r"(?:\s+#\w[\w\-]*)+$", "", cta_text).strip()
        body_text = text[: inline_match.start()].rstrip()
        return body_text, cta_text

    lines = text.strip().split("\n")
    cta_lines = []
    body_lines = []

    cta_keywords = [
        "link in bio",
        "watch the full",
        "subscribe",
        "learn more",
        "join us",
        "sign up",
        "full video",
        "click here",
        "follow us",
    ]

    for line in lines:
        stripped = line.strip()
        lower = stripped.lower()
        # URL detection
        if "http://" in lower or "https://" in lower or "www." in lower:
            cta_lines.append(stripped)
        # CTA phrase detection
        elif any(kw in lower for kw in cta_keywords):
            cta_lines.append(stripped)
        else:
            body_lines.append(stripped)

    return "\n".join(body_lines), "\n".join(cta_lines) if cta_lines else ""


def _split_hook_body(text, hook_limit=180):
    """Split caption into hook and body.
    hook_limit is adaptive - should be passed from parent based on available space.
    """
    if not text:
        return "", ""

    text = text.strip()
    if len(text) <= hook_limit:
        return text, ""

    # Try to end at sentence boundary within next 40 chars
    for i in range(hook_limit, min(hook_limit + 40, len(text))):
        if text[i] in ".!?" and (i + 1 >= len(text) or text[i + 1] in " \n"):
            return text[: i + 1].strip(), text[i + 1 :].strip()

    # Fallback: end at word boundary
    space_idx = text.rfind(" ", 0, hook_limit + 20)
    if space_idx > hook_limit * 0.5:  # More permissive for tight limits
        return text[:space_idx].strip(), text[space_idx:].strip()

    return text[:hook_limit].strip(), text[hook_limit:].strip()


def _priority_aware_trim(caption, max_chars, platform):
    """
    Trim caption to a hard platform limit with priority:
    required hashtags > CTA > hook > body > optional hashtags.
    """
    if len(caption) <= max_chars:
        return caption

    config = _get_platform_config(platform)
    min_body = config.get("min_body", MIN_BODY_THRESHOLD)
    hook_ratio = config.get("hook_ratio", 0.4)

    body_no_tags, hashtags = _extract_trailing_hashtags(caption)
    body_clean, cta_block = _extract_cta_links(body_no_tags)
    existing_tag_tokens = _extract_hashtag_tokens(hashtags)
    required_tags = _required_hashtag_list(platform)
    optional_tags = [tag for tag in existing_tag_tokens if tag not in required_tags]
    optional_room = _target_optional_hashtags(platform)
    if optional_room >= 0:
        optional_tags = optional_tags[:optional_room]

    available_for_text = max_chars
    required_block = _build_hashtag_block(required_tags, [])
    if required_block:
        available_for_text -= len(required_block)
    if cta_block:
        available_for_text -= len(cta_block)

    mandatory_sections = sum(1 for item in [required_block, cta_block] if item)
    available_for_text -= mandatory_sections * len(SEPARATOR)
    available_for_text = max(0, available_for_text)

    if available_for_text < MIN_HOOK_CHARS:
        hook_limit = max(12, int(max(available_for_text, 1) * 0.6))
    else:
        hook_limit = max(
            MIN_HOOK_CHARS,
            min(int(available_for_text * hook_ratio), max(available_for_text - min_body, MIN_HOOK_CHARS)),
        )

    hook, body = _split_hook_body(body_clean, hook_limit)
    body_available = max(
        0,
        available_for_text - len(hook) - (len(SEPARATOR) if hook and body else 0),
    )
    trimmed_body = ""
    if body and body_available > 0:
        trimmed_body = _smart_trim(body, body_available) if len(body) > body_available else body

    def assemble(optional_tag_list, cta_text):
        hashtag_block = _build_hashtag_block(required_tags, optional_tag_list)
        parts = [part for part in [hook, trimmed_body, cta_text, hashtag_block] if part]
        return SEPARATOR.join(parts)

    result = assemble(optional_tags, cta_block)

    if len(result) <= max_chars:
        return result

    while trimmed_body and len(result) > max_chars:
        next_limit = max(len(trimmed_body) - max(len(result) - max_chars, 8), 0)
        if next_limit <= 0:
            trimmed_body = ""
        else:
            trimmed_body = _smart_trim(trimmed_body, next_limit, min_words=2)
            if len(trimmed_body) >= next_limit:
                trimmed_body = trimmed_body[:next_limit].rstrip(" .,!?") + "..."
        result = assemble(optional_tags, cta_block)

    while hook and len(result) > max_chars:
        next_limit = max(len(hook) - max(len(result) - max_chars, 8), 12)
        if next_limit >= len(hook):
            break
        hook = _smart_trim(hook, next_limit, min_words=2)
        result = assemble(optional_tags, cta_block)

    while optional_tags and len(result) > max_chars:
        optional_tags.pop()
        result = assemble(optional_tags, cta_block)

    while cta_block and len(result) > max_chars:
        next_limit = max(len(cta_block) - max(len(result) - max_chars, 8), 12)
        if next_limit >= len(cta_block):
            break
        cta_block = _smart_trim(cta_block, next_limit, min_words=2)
        result = assemble(optional_tags, cta_block)

    if len(result) > max_chars:
        fallback_parts = [part for part in [hook, required_block] if part]
        fallback = SEPARATOR.join(fallback_parts)
        if len(fallback) > max_chars and hook:
            hook = _smart_trim(hook, max(12, max_chars - len(required_block) - len(SEPARATOR)), min_words=2)
            fallback = SEPARATOR.join([part for part in [hook, required_block] if part])
        result = fallback[:max_chars].rstrip()

    return result


# Captions are written by NVIDIA NIM (Llama) — same key the Shorts factory uses.
NVIDIA_CAPTION_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
NVIDIA_CAPTION_MODEL = "meta/llama-3.3-70b-instruct"


def _call_nvidia(api_key, prompt, url=None, model=None, max_retries=None, stats=None):
    """Write captions via NVIDIA NIM's OpenAI-compatible chat endpoint."""
    return _call_chat_provider(
        provider_name="nvidia",
        api_key=api_key,
        prompt=prompt,
        url=url or NVIDIA_CAPTION_URL,
        model=model or NVIDIA_CAPTION_MODEL,
        max_retries=max_retries,
        stats=stats,
    )


def _extract_chat_message_content(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
            elif isinstance(item, str) and item.strip():
                parts.append(item.strip())
        return "\n".join(parts).strip()
    return str(content or "").strip()


def _parse_glm_response_text(raw_text):
    raw_text = (raw_text or "").strip()
    if not raw_text:
        return "", {}

    if raw_text.startswith("{") or raw_text.startswith("["):
        try:
            response_json = json.loads(raw_text)
        except Exception:
            return raw_text, {}

        content = (
            response_json.get("text")
            or response_json.get("response")
            or response_json.get("completion")
            or response_json.get("output")
            or ""
        )
        if not content and isinstance(response_json.get("choices"), list):
            choices = response_json.get("choices") or []
            if choices:
                message = choices[0].get("message", {}) or {}
                content = _extract_chat_message_content(message.get("content"))
        return _extract_chat_message_content(content), response_json

    return raw_text, {}


def _call_chat_provider(
    provider_name,
    api_key,
    prompt,
    url,
    model,
    max_retries=None,
    timeout=None,
    stats=None,
):
    if max_retries is None:
        max_retries = 1 if is_economy_mode() else 3
    max_tokens = 4096 if is_economy_mode() else 8192
    timeout = timeout or (75 if is_economy_mode() else 120)
    provider_label = str(provider_name or "provider").upper()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json; charset=utf-8",
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
        "top_p": 0.8,
        "max_tokens": max_tokens,
    }
    for attempt in range(1, max_retries + 1):
        if stats is not None:
            stats["api_calls"] = stats.get("api_calls", 0) + 1
        track_api_call(provider_name)
        started = time.perf_counter()
        try:
            r = httpx.post(url, headers=headers, json=payload, timeout=timeout)
            if r.status_code == 429:
                wait = 2**attempt  # exponential backoff: 2s, 4s, 8s
                if stats is not None:
                    stats["retries"] = stats.get("retries", 0) + 1
                log(
                    "CAPTION",
                    f"[{provider_label}] [RETRY] 429 — waiting {wait}s (attempt {attempt}/{max_retries})",
                )
                time.sleep(wait)
                continue
            r.raise_for_status()
            elapsed = round(time.perf_counter() - started, 3)
            if stats is not None:
                stats["latency_seconds"] = round(
                    stats.get("latency_seconds", 0.0) + elapsed, 3
                )
            track_api_success(provider_name)
            response_json = r.json()
            usage = response_json.get("usage", {})
            message = {}
            choices = response_json.get("choices") or []
            if choices:
                message = choices[0].get("message", {}) or {}
            content = _extract_chat_message_content(message.get("content"))
            if not content:
                raise RuntimeError(f"{provider_label} returned empty content.")
            log(
                "CAPTION",
                f"[{provider_label}] [SUCCESS] Tokens in:{usage.get('prompt_tokens', '?')} out:{usage.get('completion_tokens', '?')}",
            )
            return content
        except Exception as e:
            if stats is not None:
                stats.setdefault("errors", []).append(str(e))
            log("CAPTION", f"[{provider_label}] [FAIL] attempt {attempt}: {e}")
            if attempt == max_retries:
                raise
            wait = 2**attempt
            if stats is not None:
                stats["retries"] = stats.get("retries", 0) + 1
            log("CAPTION", f"[{provider_label}] [RETRY] waiting {wait}s before retry...")
            time.sleep(wait)
    raise RuntimeError(
        f"{provider_label} API failed after {max_retries} retries."
    )


def _call_glm(api_key, prompt, max_retries=None, stats=None):
    if max_retries is None:
        max_retries = 1 if is_economy_mode() else 3
    timeout = 75 if is_economy_mode() else 120
    provider_label = "GLM"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json; charset=utf-8",
    }
    payload = {
        "prompt": prompt,
        "max_tokens": get_glm_max_tokens(),
        "model": get_glm_model(),
    }

    for attempt in range(1, max_retries + 1):
        if stats is not None:
            stats["api_calls"] = stats.get("api_calls", 0) + 1
        track_api_call("glm")
        started = time.perf_counter()
        try:
            r = httpx.post(
                get_glm_base_url(),
                headers=headers,
                json=payload,
                timeout=timeout,
            )
            if r.status_code == 429:
                wait = 2**attempt
                if stats is not None:
                    stats["retries"] = stats.get("retries", 0) + 1
                log(
                    "CAPTION",
                    f"[{provider_label}] [RETRY] 429 — waiting {wait}s (attempt {attempt}/{max_retries})",
                )
                time.sleep(wait)
                continue
            if r.status_code >= 500:
                body_preview = (r.text or "").strip()[:400]
                raise RuntimeError(
                    f"HTTP {r.status_code} from Modal GLM endpoint. Body: {body_preview or '<empty>'}"
                )
            r.raise_for_status()
            elapsed = round(time.perf_counter() - started, 3)
            if stats is not None:
                stats["latency_seconds"] = round(
                    stats.get("latency_seconds", 0.0) + elapsed, 3
                )
            track_api_success("glm")
            raw_body = r.text or ""
            content, response_json = _parse_glm_response_text(raw_body)
            if not content:
                body_preview = raw_body.strip()[:400]
                raise RuntimeError(
                    "GLM returned empty content. "
                    f"Response keys: {sorted(response_json.keys()) if response_json else 'n/a'}. "
                    f"Body preview: {body_preview or '<empty>'}"
                )
            body_kind = "json" if response_json else "text"
            log(
                "CAPTION",
                f"[{provider_label}] [SUCCESS] Modal-native {body_kind} response received",
            )
            return content
        except Exception as e:
            if stats is not None:
                stats.setdefault("errors", []).append(str(e))
            log("CAPTION", f"[{provider_label}] [FAIL] attempt {attempt}: {e}")
            if attempt == max_retries:
                raise
            wait = 2**attempt
            if stats is not None:
                stats["retries"] = stats.get("retries", 0) + 1
            log("CAPTION", f"[{provider_label}] [RETRY] waiting {wait}s before retry...")
            time.sleep(wait)
    raise RuntimeError(f"{provider_label} API failed after {max_retries} retries.")


def _provider_label(provider_name):
    return {
        "nvidia": "NVIDIA Caption API",
        "glm": "GLM Caption API",
    }.get(str(provider_name or "").lower(), str(provider_name or "caption provider"))


def _provider_model(provider_name):
    provider_name = str(provider_name or "").lower()
    if provider_name == "nvidia":
        return NVIDIA_CAPTION_MODEL
    if provider_name == "glm":
        return get_glm_model()
    return ""


def _call_caption_provider(provider_name, api_key, prompt, stats=None, url=None, model=None):
    provider_name = str(provider_name or "").lower()
    if provider_name == "glm":
        return _call_glm(api_key, prompt, stats=stats)
    return _call_nvidia(api_key, prompt, url=url, model=model, stats=stats)


def _parse_raw(raw):
    """Parse JSON from LLM response with repair layer and retries."""
    import re

    raw = (raw or "").strip()
    if not raw:
        log("CAPTION", "[FAIL] Empty response from LLM — returning empty dict")
        return {}

    def _try_parse(text):
        """Try to parse JSON with various repair strategies."""
        text = (text or "").strip()
        if not text:
            return None

        # Strategy 1: Extract from markdown code fences first
        if "```" in text:
            pattern = r"```(?:json)?\s*(.*?)```"
            matches = re.findall(pattern, text, re.DOTALL)
            if matches:
                text = matches[-1].strip()

        # Strategy 2: Try direct parse first (handles most cases)
        try:
            return _normalize(json.loads(text))
        except json.JSONDecodeError:
            pass

        # Strategy 3: Find JSON object pattern with non-greedy matching
        # Use nested brace counting to find proper boundaries
        try:
            start_idx = text.find('{')
            if start_idx >= 0:
                brace_count = 0
                for i in range(start_idx, len(text)):
                    if text[i] == '{':
                        brace_count += 1
                    elif text[i] == '}':
                        brace_count -= 1
                        if brace_count == 0:
                            json_text = text[start_idx:i+1]
                            return _normalize(json.loads(json_text))
        except (json.JSONDecodeError, IndexError):
            pass

        return None

    # Try parsing original
    result = _try_parse(raw)
    if result:
        return result

    # Try repairing common issues
    log("CAPTION", f"[JSON_REPAIR] Initial parse failed, attempting repair... (response length: {len(raw)})")

    # Repair: Fix trailing commas
    repaired = re.sub(r",(\s*[}\]])", r"\1", raw)
    result = _try_parse(repaired)
    if result:
        log("CAPTION", "[JSON_REPAIR] Fixed trailing commas")
        return result

    # Repair: Fix unescaped quotes - improved for Unicode/Gujarati text
    # This handles quotes that appear within content strings better
    try:
        # Try to find and fix quotes that break JSON structure
        # Look for patterns like ": "text"text"" and fix to ": "text\"text\""
        repaired = re.sub(
            r'(: +")([^"]*)"([^}]*)',  # After colon-quote, find unescaped quote
            lambda m: f'{m.group(1)}{m.group(2).replace(chr(34), chr(92)+chr(34))}{m.group(3)}',
            raw,
            flags=re.DOTALL | re.MULTILINE
        )
        result = _try_parse(repaired)
        if result:
            log("CAPTION", "[JSON_REPAIR] Fixed unescaped quotes")
            return result
    except Exception as quote_error:
        log("CAPTION", f"[JSON_REPAIR] Quote repair attempt failed: {quote_error}")

    # Repair: Try removing markdown formatting if present
    if '**' in raw or '*' in raw or '```' in raw:
        repaired = re.sub(r'\*{1,2}', '', raw)
        repaired = re.sub(r'```[^`]*```', '', repaired)
        result = _try_parse(repaired)
        if result:
            log("CAPTION", "[JSON_REPAIR] Removed markdown formatting")
            return result

    # Repair: Try to extract valid platform keys if JSON is severely broken
    # Look for patterns like "platform_name": "caption_text" and reconstruct.
    # Only triggers when the raw text actually looks like a JSON-ish object
    # (contains braces) so we don't false-match on prose like
    # "Sure, here is the instagram: 'foo'". This avoids polluting the result
    # with non-JSON narrative responses.
    if "{" in raw and "}" in raw:
        try:
            platform_pattern = r'["\']?(instagram|facebook|youtube|twitter|threads|tiktok|bluesky)["\']?\s*:\s*["\']([^"\']{10,})["\']'
            matches = re.findall(platform_pattern, raw, re.IGNORECASE)
            if matches:
                reconstructed = {}
                for plat_name, caption in matches:
                    plat_name = plat_name.strip().lower()
                    if plat_name and caption:
                        reconstructed[plat_name] = {"caption": caption}
                if reconstructed:
                    result = _normalize(reconstructed)
                    if result:
                        log("CAPTION", f"[JSON_REPAIR] Reconstructed from platform patterns: {list(result.keys())}")
                        return result
        except Exception as pattern_error:
            log("CAPTION", f"[JSON_REPAIR] Pattern reconstruction failed: {pattern_error}")

    # If all repairs failed, log diagnostic info
    log("CAPTION", f"[FAIL] JSON repair failed for all strategies")
    log("CAPTION", f"[DEBUG] First 300 chars of response: {raw[:300]}")

    return {}


def _is_caption_corrupted(caption_text):
    """
    Check if a caption is *truly* corrupted/garbage, beyond what hashtag
    cleanup can fix. Returns True only when the body is essentially gone
    (so the caller should drop the caption and use a fallback).

    A few short Gujarati hashtags at the end of an otherwise good caption
    are NOT considered corrupted — call ``_strip_corrupt_hashtags`` to
    sanitize them while keeping the body.
    """
    if not caption_text or len(caption_text.strip()) < 5:
        return False  # Too short to be corrupted, just empty

    text = caption_text.strip()

    # Use the script-agnostic full-hashtag pattern so Indic hashtags like
    # #ચિદાકાશ are counted as one tag (the default HASHTAG_PATTERN
    # splits on combining marks and overcounts).
    hashtags = _FULL_HASHTAG_PATTERN.findall(text)
    non_hashtag_text = _FULL_HASHTAG_PATTERN.sub("", text).strip()

    # Only flag as fully corrupted when there is barely any body text left
    # AND there are hashtags (so it isn't just a short legit caption).
    # This avoids destroying real NVIDIA captions that just happen to
    # have a couple of weird short hashtags appended to a long body.
    if hashtags and len(non_hashtag_text) < 10:
        log(
            "CAPTION",
            f"[CORRUPT_CHECK] Body text essentially empty ({len(non_hashtag_text)} chars) "
            f"with {len(hashtags)} hashtags — treating as corrupted",
        )
        return True

    return False


_FULL_HASHTAG_PATTERN = re.compile(r"#[^\s#]+", re.UNICODE)


def _strip_corrupt_hashtags(caption_text):
    """Remove single/double-character hashtags (like ``#હ`` ``#આધ``) that
    appear when an LLM truncates a longer Gujarati hashtag.

    Uses a script-agnostic hashtag pattern (``#[^\\s#]+``) so that real
    Indic hashtags like ``#ચિદાકાશ`` are kept intact — the default
    ``HASHTAG_PATTERN`` (``#\\w[\\w\\-]*``) splits on combining marks and
    misidentifies the leading ``#ચ`` as corrupt, which would destroy the
    rest of the hashtag.

    Preserves the rest of the caption. Returns the cleaned text.
    """
    if not caption_text:
        return caption_text

    def _is_corrupt_tag(tag):
        body = tag[1:] if tag.startswith("#") else tag
        # Trim trailing punctuation captured by the broad regex
        body = body.rstrip(".,!?;:)]}\"'`|/\\")
        if not body:
            return True
        # ASCII tags: keep if length >= 2 (e.g. #AI is fine)
        if all(ord(ch) < 128 for ch in body):
            return False
        # Non-ASCII (Indic etc.): real hashtags are much longer than the
        # truncation artefacts (#હ #શ #આધ). Count base characters by
        # stripping combining marks; a "word" of <=2 base characters is
        # a fragment.
        import unicodedata
        nfd = unicodedata.normalize("NFD", body)
        base_chars = [ch for ch in nfd if not unicodedata.combining(ch)]
        return len(base_chars) <= 2

    def _replace(match):
        tag = match.group(0)
        if _is_corrupt_tag(tag):
            return ""
        return tag

    cleaned = _FULL_HASHTAG_PATTERN.sub(_replace, caption_text)
    # Collapse runs of whitespace left behind by removed tags, but keep
    # paragraph breaks.
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r" *\n", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _strict_validate(captions):
    """Strict validation: ensure all 7 platforms exist, non-empty, within limits."""
    required = {
        "youtube",
        "instagram",
        "tiktok",
        "facebook",
        "twitter",
        "threads",
        "bluesky",
    }

    # Check all platforms present
    missing = required - set(captions.keys())
    if missing:
        log("CAPTION", f"[VALIDATION_FAIL] Missing platforms: {missing}")
        return False, f"missing:{missing}"

    # Check non-empty and within limits
    for p in required:
        data = captions.get(p, {})
        caption = data.get("caption", "").strip()

        if not caption:
            log("CAPTION", f"[VALIDATION_FAIL] Empty caption for {p}")
            return False, f"empty:{p}"

        limit = PLATFORM_LIMITS.get(p, 2000)
        if len(caption) > limit:
            log(
                "CAPTION",
                f"[VALIDATION_FAIL] Caption too long for {p}: {len(caption)} > {limit}",
            )
            return False, f"too_long:{p}"

    log("CAPTION", "[VALIDATION_PASS] All 7 platforms valid")
    return True, "ok"


def _save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _build_provider_stats(provider_name):
    return {
        "provider": provider_name,
        "label": _provider_label(provider_name),
        "model": _provider_model(provider_name),
        "api_calls": 0,
        "retries": 0,
        "latency_seconds": 0.0,
        "errors": [],
        "warnings": [],
        "status": "pending",
    }


def _normalize_provider_output(captions, target_platforms):
    """Normalize provider output and clean up corrupt hashtag artefacts.

    Only fully-corrupted captions (no real body, only hashtags) are
    dropped so the fallback can replace them. Captions with a real body
    that happen to contain a few truncated single-char hashtags get the
    bad tags stripped but keep their text — destroying a good caption
    over a stray ``#હ`` is far worse than a slightly thinner hashtag tail.
    """
    result = {}
    for p in target_platforms:
        if p not in captions:
            continue
        entry = dict(captions[p])
        caption_text = entry.get("caption", "") or ""
        if caption_text:
            cleaned = _strip_corrupt_hashtags(caption_text)
            if cleaned != caption_text:
                log("CAPTION", f"  Stripped corrupt single-char hashtags for {p}")
                entry["caption"] = cleaned
                caption_text = cleaned
        if caption_text and _is_caption_corrupted(caption_text):
            log("CAPTION", f"  Dropping fully-corrupted caption for {p} (no usable body)")
            continue
        result[p] = entry
    return result


def _run_caption_provider(
    provider_name,
    api_key,
    prompt,
    target_platforms,
    target_language,
    url=None,
    model=None,
):
    stats = _build_provider_stats(provider_name)
    captions = {}
    log("CAPTION", f"Calling {_provider_label(provider_name)} ...")
    raw = _call_caption_provider(
        provider_name, api_key, prompt, stats=stats, url=url, model=model
    )
    captions = _parse_raw(raw)
    captions = _normalize_provider_output(captions, target_platforms)

    missing, empty = _validate_schema(captions, target_platforms=target_platforms)
    if missing:
        stats["warnings"].append(f"missing:{','.join(sorted(missing))}")
        log("CAPTION", f"  WARNING: Missing platforms: {missing}")
    if empty:
        stats["warnings"].append(f"empty:{','.join(sorted(empty))}")
        log("CAPTION", f"  WARNING: Empty captions: {empty}")

    bad_script = [
        p
        for p, d in captions.items()
        if not _contains_target_script(d.get("caption", ""), target_language)
    ]
    if bad_script and _language_meta(target_language).get("script_ranges"):
        stats["warnings"].append(f"script:{','.join(sorted(bad_script))}")
        log(
            "CAPTION",
            f"  WARNING: Non-{_language_meta(target_language)['name']} output in {bad_script}",
        )

    # Truncation check: LLM cut caption mid-output. Distinct from 'expanded'
    # (exceeds limit, trimmed locally) — truncation means we lost content and
    # need the model to produce a complete shorter version.
    truncated_platforms, _ = _validate_caption_length(captions, target_platforms)
    if truncated_platforms and is_quality_mode():
        log(
            "CAPTION",
            f"  Truncated captions on {truncated_platforms} from {provider_name} — retrying with tighter target ...",
        )
        trunc_targets_hint = "; ".join(
            f"{p}<={int(PLATFORM_LIMITS.get(p, 2000) * 0.85)}chars"
            for p in truncated_platforms
        )
        retry_prompt = (
            f"{prompt}\n\nCRITICAL: Your previous output for {truncated_platforms} "
            "was truncated (cut off mid-sentence or mid-hashtag). "
            f"Keep each platform strictly under 85% of its hard limit so it completes cleanly: "
            f"{trunc_targets_hint}. End with a finished sentence followed by complete hashtags. "
            f"Return JSON ONLY for selected platforms: {', '.join(target_platforms)}."
        )
        try:
            raw_t = _call_caption_provider(provider_name, api_key, retry_prompt, stats=stats)
            captions_t = _parse_raw(raw_t)
            captions_t = _normalize_provider_output(captions_t, target_platforms)
            for p in truncated_platforms:
                new_cap = captions_t.get(p, {}).get("caption", "")
                if new_cap and not _looks_truncated(new_cap):
                    captions[p] = captions_t.get(p, captions[p])
                    log("CAPTION", f"  Truncation retry succeeded for {p}")
                else:
                    log("CAPTION", f"  Truncation retry did not resolve {p}; keeping original")
        except Exception as e:
            stats["warnings"].append(f"trunc_retry_failed:{','.join(sorted(truncated_platforms))}")
            log("CAPTION", f"Truncation retry failed: {e}")
    elif truncated_platforms:
        stats["warnings"].append(f"truncated:{','.join(sorted(truncated_platforms))}")
        log(
            "CAPTION",
            f"  Economy mode: accepting truncated captions for {truncated_platforms} without regeneration.",
        )

    bad_short = [
        p
        for p, mins in SHORT_MINIMUMS.items()
        if p in target_platforms
        if len(captions.get(p, {}).get("caption", "")) < mins
    ]
    if bad_short and is_quality_mode():
        log(
            "CAPTION",
            f"  Short captions on {bad_short} from {provider_name} — retrying ...",
        )
        twitter_instruction = ""
        if "twitter" in bad_short:
            twitter_instruction = (
                "For twitter specifically, keep the regenerated caption between 180 and 240 characters "
                "and never exceed 250 characters including hashtags. "
            )
        retry_prompt = (
            f"{prompt}\n\nCRITICAL: Your previous output for {bad_short} was too short. "
            f"Minimums: TikTok=80 chars, Twitter=180 chars, Threads=200 chars, Bluesky=180 chars. "
            f"{twitter_instruction}"
            f"Write LONGER complete sentences. Fill the limit without exceeding any platform max. "
            f"Return JSON ONLY for selected platforms: {', '.join(target_platforms)}."
        )
        try:
            raw2 = _call_caption_provider(provider_name, api_key, retry_prompt, stats=stats)
            captions2 = _parse_raw(raw2)
            for p in bad_short:
                new_len = len(captions2.get(p, {}).get("caption", ""))
                old_len = len(captions.get(p, {}).get("caption", ""))
                if new_len > old_len:
                    captions[p] = captions2.get(p, {})
        except Exception as e:
            stats["warnings"].append(f"short_retry_failed:{','.join(sorted(bad_short))}")
            log("CAPTION", f"Regeneration failed for {bad_short}: {e}")
    elif bad_short:
        stats["warnings"].append(f"short:{','.join(sorted(bad_short))}")
        log(
            "CAPTION",
            f"  Economy mode: accepting short captions for {bad_short} without regeneration.",
        )

    for p, data in captions.items():
        caption = data.get("caption", "")

        if p in ["instagram", "facebook", "youtube", "tiktok", "twitter"]:
            missing_both = (
                "#kailasa" not in caption.lower()
                or "#nithyananda" not in caption.lower()
            )
            if missing_both and is_quality_mode():
                log("CAPTION", f"Missing required tags for {p} — regenerating...")
                try:
                    retry_prompt = (
                        f"{prompt}\n\nCRITICAL: The previous caption for {p} was missing required hashtags. "
                        f"Must include both #KAILASA and #Nithyananda hashtags. "
                        f"Regenerate the caption for {p} with proper hashtags. "
                        f"Return JSON ONLY for selected platforms: {', '.join(target_platforms)}."
                    )
                    raw_retry = _call_caption_provider(
                        provider_name, api_key, retry_prompt, stats=stats
                    )
                    new_captions = _parse_raw(raw_retry)
                    if new_captions.get(p) and new_captions[p].get("caption"):
                        captions[p] = new_captions[p]
                        caption = captions[p]["caption"]
                        log("CAPTION", f"Regenerated caption for {p}")
                except Exception as e:
                    stats["warnings"].append(f"tag_retry_failed:{p}")
                    log("CAPTION", f"Failed to regenerate {p}: {e}")
            elif missing_both:
                captions[p]["caption"] = _append_required_hashtags(p, caption)
                caption = captions[p]["caption"]
                log("CAPTION", f"Economy mode: appended required hashtags for {p}.")
        elif p in ["threads", "bluesky"]:
            missing_tag = "#kailasa" not in caption.lower()
            if missing_tag and is_quality_mode():
                log(
                    "CAPTION",
                    f"Missing required #KAILASA tag for {p} — regenerating...",
                )
                try:
                    retry_prompt = (
                        f"{prompt}\n\nCRITICAL: The previous caption for {p} was missing required #KAILASA hashtag. "
                        f"Must include #KAILASA hashtag. "
                        f"Regenerate the caption for {p} with proper hashtag. "
                        f"Return JSON ONLY for selected platforms: {', '.join(target_platforms)}."
                    )
                    raw_retry = _call_caption_provider(
                        provider_name, api_key, retry_prompt, stats=stats
                    )
                    new_captions = _parse_raw(raw_retry)
                    if new_captions.get(p) and new_captions[p].get("caption"):
                        captions[p] = new_captions[p]
                        caption = captions[p]["caption"]
                        log("CAPTION", f"Regenerated caption for {p}")
                except Exception as e:
                    stats["warnings"].append(f"kailasa_retry_failed:{p}")
                    log("CAPTION", f"Failed to regenerate {p}: {e}")
            elif missing_tag:
                captions[p]["caption"] = _append_required_hashtags(p, caption)
                caption = captions[p]["caption"]
                log("CAPTION", f"Economy mode: appended required hashtags for {p}.")

        if _hashtag_target_needs_retry(p, caption) and is_quality_mode():
            try:
                target_total = _target_total_hashtags(p)
                log(
                    "CAPTION",
                    f"Hashtag count below target for {p} — regenerating toward {target_total} total hashtags...",
                )
                retry_prompt = (
                    f"{prompt}\n\nCRITICAL: The previous caption for {p} used too few hashtags. "
                    f"Aim for {target_total} total hashtags including the fixed required tags, "
                    f"unless the platform limit or natural fit makes that impossible. "
                    f"Keep the caption complete and within the platform character limit. "
                    f"Return JSON ONLY for selected platforms: {', '.join(target_platforms)}."
                )
                raw_retry = _call_caption_provider(
                    provider_name, api_key, retry_prompt, stats=stats
                )
                new_captions = _parse_raw(raw_retry)
                if new_captions.get(p) and new_captions[p].get("caption"):
                    captions[p] = new_captions[p]
                    caption = captions[p]["caption"]
                    log("CAPTION", f"Regenerated caption for {p} with stronger hashtag target")
            except Exception as e:
                stats["warnings"].append(f"hashtag_retry_failed:{p}")
                log("CAPTION", f"Failed hashtag regeneration for {p}: {e}")

        if _language_meta(target_language).get("script_ranges") and p in [
            "instagram",
            "facebook",
            "youtube",
            "threads",
            "bluesky",
        ]:
            if (
                not _contains_target_script(caption, target_language)
                and is_quality_mode()
            ):
                log(
                    "CAPTION",
                    f"No {_language_meta(target_language)['name']} script detected in {p} caption — regenerating...",
                )
                try:
                    retry_prompt = (
                        f"{prompt}\n\nCRITICAL: The previous caption for {p} was not clearly written in {_language_meta(target_language)['name']}. "
                        f"Must be written in {_language_meta(target_language)['name']}. "
                        f"Regenerate the caption for {p} in proper {_language_meta(target_language)['name']}. "
                        f"Return JSON ONLY for selected platforms: {', '.join(target_platforms)}."
                    )
                    raw_retry = _call_caption_provider(
                        provider_name, api_key, retry_prompt, stats=stats
                    )
                    new_captions = _parse_raw(raw_retry)
                    if new_captions.get(p) and new_captions[p].get("caption"):
                        captions[p] = new_captions[p]
                        caption = captions[p]["caption"]
                        log("CAPTION", f"Regenerated caption for {p}")
                except Exception as e:
                    stats["warnings"].append(f"script_retry_failed:{p}")
                    log("CAPTION", f"Regeneration failed for {p}: {e}")

        hard_lim = PLATFORM_LIMITS.get(p, 2000)
        opt_range = OPTIMAL_RANGES.get(p)

        if len(caption) > hard_lim:
            stats["warnings"].append(f"too_long:{p}")
            trimmed = _priority_aware_trim(caption, hard_lim, p)
            log(
                "CAPTION",
                f"Caption exceeds hard limit for {p} ({len(caption)} > {hard_lim}) — enforcing body-first trim",
            )
            captions[p]["caption"] = trimmed
            caption = trimmed

        if opt_range:
            opt_min, opt_max = opt_range
            if len(caption) < opt_min:
                stats["warnings"].append(f"below_optimal:{p}")
                log(
                    "CAPTION",
                    f"Caption short for {p} ({len(caption)} < {opt_min} optimal)",
                )
            elif len(caption) > opt_max:
                overage_pct = ((len(caption) - opt_max) / opt_max) * 100
                log(
                    "CAPTION",
                    f"Caption long for {p} ({len(caption)} > {opt_max} optimal, {overage_pct:.0f}% over)",
                )

                if overage_pct >= 30:
                    _, hashtags = _extract_trailing_hashtags(caption)
                    _, cta = _extract_cta_links(caption)
                    required_tags = _required_hashtag_list(p)
                    tag_count = len(_extract_hashtag_tokens(hashtags))

                    trimmed = _priority_aware_trim(caption, opt_max, p)
                    min_len = SHORT_MINIMUMS.get(p, 80)
                    if len(trimmed) < min_len:
                        stats["warnings"].append(f"trim_aborted:{p}")
                        log(
                            "CAPTION",
                            f"  WARNING: Trimmed too short ({len(trimmed)} < {min_len}), keeping original",
                        )
                    else:
                        captions[p]["caption"] = trimmed
                        caption = trimmed
                        log(
                            "CAPTION",
                            f"→ Body-first trim applied | Required tags preserved ({len(required_tags)}) | Optional tags considered ({tag_count}) | CTA preserved ({len(cta)} chars)",
                        )
                else:
                    log("CAPTION", "→ Within tolerance, keeping as-is")

    for p, data in captions.items():
        cleaned_caption = _sanitize_caption_text(
            _extract_str(data.get("caption", "")), newline_before_tags=True
        )
        data["caption"] = cleaned_caption
        if p == "youtube":
            title = _sanitize_caption_text(
                _extract_str(data.get("title", "")), newline_before_tags=False
            )
            data["title"] = title

    stats["status"] = "ok"
    return captions, stats


def _write_caption_files(output_dir, captions, target_platforms, basename="captions.json"):
    _save_json(os.path.join(output_dir, basename), captions)
    for p in target_platforms:
        data = captions.get(p, {})
        prefix = (
            f"TITLE: {data['title']}\n\n"
            if p == "youtube" and data.get("title")
            else ""
        )
        suffix = "" if basename == "captions.json" else f".{os.path.splitext(basename)[0]}"
        with open(
            os.path.join(output_dir, f"caption_{p}{suffix}.txt"),
            "w",
            encoding="utf-8",
        ) as f:
            f.write(prefix + data.get("caption", ""))


def _build_eval_summary(live_provider, live_captions, eval_provider, eval_captions, target_platforms):
    per_platform = {}
    for platform in target_platforms:
        live_entry = live_captions.get(platform, {})
        eval_entry = eval_captions.get(platform, {})
        live_caption = _extract_str(live_entry.get("caption", ""))
        eval_caption = _extract_str(eval_entry.get("caption", ""))
        item = {
            "live_length": len(live_caption),
            "eval_length": len(eval_caption),
            "captions_match": live_caption == eval_caption,
        }
        if platform == "youtube":
            item["live_title_length"] = len(_extract_str(live_entry.get("title", "")))
            item["eval_title_length"] = len(_extract_str(eval_entry.get("title", "")))
            item["titles_match"] = _extract_str(live_entry.get("title", "")) == _extract_str(
                eval_entry.get("title", "")
            )
        per_platform[platform] = item
    return {
        "live_provider": live_provider,
        "eval_provider": eval_provider,
        "platforms_compared": target_platforms,
        "per_platform": per_platform,
    }


def generate_all_captions(
    vision_data,
    api_key=None,
    output_dir="workspace",
    segments=None,
    target_language="gu",
    return_meta=False,
    selected_platforms=None,
    source_metadata=None,
    api_url=None,
    model=None,
):
    os.makedirs(output_dir, exist_ok=True)
    meta = {
        "used_fallback": False,
        "reason": "",
        "provider": "nvidia_caption",
        "live_provider": "nvidia",
        "provider_stats": {},
        "source_caption_strategy": "generated",
        "evaluation": {
            "enabled": False,
            "provider": "glm",
            "status": "not_run",
            "files": [],
        },
    }
    main_topic = vision_data.get("main_topic", "")
    conflict = vision_data.get("core_conflict", "")
    prov = vision_data.get("provocative_angle", "")
    key_message = (conflict + " | " + prov).strip(" |")
    theme = vision_data.get("theme", "teaching")
    target_platforms = _normalize_target_platforms(selected_platforms)

    transcript_text = ""
    if segments:
        transcript_text = "\n".join(
            s.get("translated") or s.get("text", "") for s in segments
        ).strip()

    log("CAPTION", f"Vision -> topic: {main_topic[:60]}")
    log("CAPTION", f"Vision -> key_message: {key_message[:100]}")
    prompt = _build_prompt(
        main_topic,
        key_message,
        theme,
        transcript_text,
        target_language=target_language,
        target_platforms=target_platforms,
    )
    source_prompt = None
    if _has_usable_source_metadata(source_metadata):
        source_prompt = _build_source_first_prompt(
            vision_data,
            source_metadata,
            transcript=transcript_text,
            target_language=target_language,
            target_platforms=target_platforms,
        )
        meta["source_caption_strategy"] = "source_first"
        log("CAPTION", "Source description metadata found — trying source-first adaptation.")
    else:
        log("CAPTION", "No usable source description metadata — using generated captions.")
    captions = {}
    nvidia_key = api_key
    glm_key = get_glm_api_key()
    glm_eval_enabled = is_glm_caption_eval_enabled()
    mode_name = "Economy" if is_economy_mode() else "Quality"
    log("CAPTION", f"Mode: {mode_name}")

    if nvidia_key:
        try:
            nvidia_stats = None
            live_prompt = prompt
            if source_prompt:
                try:
                    captions, nvidia_stats = _run_caption_provider(
                        "nvidia",
                        nvidia_key,
                        source_prompt,
                        target_platforms,
                        target_language,
                        url=api_url,
                        model=model,
                    )
                    meta["source_caption_strategy"] = "source_first"
                    live_prompt = source_prompt
                except Exception as source_error:
                    meta["source_caption_strategy"] = "source_first_fallback_generated"
                    log(
                        "CAPTION",
                        f"Source-first adaptation failed: {source_error} — falling back to transcript-based generation.",
                    )
            if not captions:
                captions, nvidia_stats = _run_caption_provider(
                    "nvidia",
                    nvidia_key,
                    prompt,
                    target_platforms,
                    target_language,
                    url=api_url,
                    model=model,
                )
            meta["provider_stats"]["nvidia"] = nvidia_stats
        except Exception as e:
            log("CAPTION", f"Error: {e} — fallback.")
            meta["used_fallback"] = True
            meta["reason"] = str(e)
            meta["provider_stats"]["nvidia"] = {
                **_build_provider_stats("nvidia"),
                "status": "error",
                "errors": [str(e)],
            }
            captions = _fallback_captions(
                vision_data,
                target_language=target_language,
                target_platforms=target_platforms,
            )
    else:
        log("CAPTION", "No key — fallback.")
        meta["used_fallback"] = True
        meta["reason"] = "No NVIDIA API key"
        meta["provider_stats"]["nvidia"] = {
            **_build_provider_stats("nvidia"),
            "status": "missing_key",
            "errors": ["No NVIDIA API key"],
        }
        captions = _fallback_captions(
            vision_data,
            target_language=target_language,
            target_platforms=target_platforms,
        )

    # Ensure we have captions (fallback if empty)
    if not captions:
        log("CAPTION", "Empty captions — using fallback.")
        meta["used_fallback"] = True
        if not meta.get("reason"):
            meta["reason"] = "Caption generation produced empty output"
        captions = _fallback_captions(
            vision_data,
            target_language=target_language,
            target_platforms=target_platforms,
        )

    captions = {p: captions.get(p, {}) for p in target_platforms if p in captions}
    missing_after_parse = [
        p
        for p in target_platforms
        if not captions.get(p, {}).get("caption", "").strip()
    ]
    if missing_after_parse:
        fallback_map = _fallback_captions(
            vision_data,
            target_language=target_language,
            target_platforms=target_platforms,
        )
        for p in missing_after_parse:
            captions[p] = fallback_map.get(p, {"caption": ""})

    for p, data in captions.items():
        cleaned_caption = _sanitize_caption_text(
            _extract_str(data.get("caption", "")), newline_before_tags=True
        )
        cleaned_caption = _strip_source_video_url(cleaned_caption, source_metadata)
        # Override any generated/extra hashtags + @mentions with exactly the two
        # fixed tags the user wants.
        data["caption"] = _force_two_hashtags(cleaned_caption)
        if p == "youtube":
            title = _sanitize_caption_text(
                _extract_str(data.get("title", "")), newline_before_tags=False
            )
            # Titles carry no hashtags/handles.
            data["title"] = _force_two_hashtags(
                _strip_source_video_url(title, source_metadata), append=False
            )

    _write_caption_files(output_dir, captions, target_platforms, basename="captions.json")

    if glm_eval_enabled and nvidia_key and not meta["used_fallback"]:
        meta["evaluation"]["enabled"] = True
        if glm_key:
            try:
                glm_captions, glm_stats = _run_caption_provider(
                    "glm",
                    glm_key,
                    live_prompt if "live_prompt" in locals() else prompt,
                    target_platforms,
                    target_language,
                )
                meta["provider_stats"]["glm"] = glm_stats
                summary = _build_eval_summary(
                    "nvidia",
                    captions,
                    "glm",
                    glm_captions,
                    target_platforms,
                )
                nvidia_file = os.path.join(output_dir, "captions_nvidia_eval.json")
                glm_file = os.path.join(output_dir, "captions_glm_eval.json")
                summary_file = os.path.join(output_dir, "captions_eval_summary.json")
                meta_file = os.path.join(output_dir, "captions_provider_meta.json")
                _save_json(nvidia_file, captions)
                _save_json(glm_file, glm_captions)
                _save_json(summary_file, summary)
                meta["evaluation"]["status"] = "ok"
                meta["evaluation"]["files"] = [
                    nvidia_file,
                    glm_file,
                    summary_file,
                    meta_file,
                ]
                _save_json(meta_file, meta)
                log("CAPTION", "GLM caption evaluation artifacts saved.")
            except Exception as e:
                meta["provider_stats"]["glm"] = {
                    **_build_provider_stats("glm"),
                    "status": "error",
                    "errors": [str(e)],
                }
                meta["evaluation"]["status"] = "error"
                meta["evaluation"]["reason"] = str(e)
                meta_file = os.path.join(output_dir, "captions_provider_meta.json")
                meta["evaluation"]["files"] = [meta_file]
                _save_json(meta_file, meta)
                log("CAPTION", f"GLM caption evaluation failed: {e}")
        else:
            meta["evaluation"]["status"] = "missing_key"
            meta["evaluation"]["reason"] = "GLM_CAPTION_EVAL enabled but no GLM_API_KEY found"
            meta["provider_stats"]["glm"] = {
                **_build_provider_stats("glm"),
                "status": "missing_key",
                "errors": ["No GLM_API_KEY found"],
            }
            meta_file = os.path.join(output_dir, "captions_provider_meta.json")
            meta["evaluation"]["files"] = [meta_file]
            _save_json(meta_file, meta)
            log("CAPTION", "GLM caption evaluation skipped: no GLM API key.")
    elif glm_eval_enabled:
        meta["evaluation"]["enabled"] = True
        meta["evaluation"]["status"] = "skipped_live_provider_unavailable"
        meta["evaluation"]["reason"] = (
            "NVIDIA live captions were unavailable, so GLM side-by-side evaluation was skipped."
        )
        meta_file = os.path.join(output_dir, "captions_provider_meta.json")
        meta["evaluation"]["files"] = [meta_file]
        _save_json(meta_file, meta)
    else:
        meta_file = os.path.join(output_dir, "captions_provider_meta.json")
        _save_json(meta_file, meta)

    log("CAPTION", f"All captions saved ({len(target_platforms)} platforms).")
    return (captions, meta) if return_meta else captions


def _fallback_captions(vision_data, target_language="gu", target_platforms=None):
    topic = vision_data.get("main_topic", "") or ""
    conflict = vision_data.get("core_conflict", "") or ""
    prov = vision_data.get("provocative_angle", "") or ""
    hook = (prov or conflict or topic)[:120]
    body1 = (conflict or prov or topic)[:150]
    body2 = topic[:100] if topic and topic != body1 else ""
    bullets = BULLET + " " + body1
    if body2:
        bullets += "\n" + BULLET + " " + body2
    long_cap = hook + "\n\n" + bullets + "\n\n" + TAGS4
    all_caps = {
        "instagram": {"caption": long_cap},
        "facebook": {"caption": long_cap},
        "tiktok": {"caption": _smart_trim(hook + "\n\n#KAILASA #Nithyananda", 250)},
        "twitter": {
            "caption": _smart_trim(
                hook + " " + body1 + "\n\n#KAILASA #Nithyananda",
                100,
            )
        },
        "threads": {
            "caption": _smart_trim(hook + "\n\n" + body1 + "\n\n" + TAGS3, 250)
        },
        "bluesky": {
            "caption": _smart_trim(hook + "\n\n" + body1 + "\n\n" + TAGS2, 160)
        },
        "youtube": {
            "title": _smart_trim(topic or hook, 75),
            "caption": _smart_trim(long_cap, 4500),
        },
    }
    wanted = _normalize_target_platforms(target_platforms)
    result = {}
    for p in wanted:
        if p in all_caps:
            result[p] = all_caps[p]
        else:
            log("CAPTION", f"  WARNING: No fallback caption template for '{p}'")
    return result
