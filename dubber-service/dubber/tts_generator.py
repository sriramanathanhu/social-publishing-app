import os, asyncio, time, re, json
import edge_tts
from pydub import AudioSegment
from .utils import ffprobe_info, log


def _probe_audio_duration_ms(path):
    """Return audio duration in ms without decoding every sample.

    ffprobe reads only the container/codec header, which is an order of
    magnitude faster than pydub's ``AudioSegment.from_file`` for the
    20s+ clips this pipeline generates (pydub decodes the full waveform
    into memory just to measure length). For a 50-segment dub this
    saves several seconds of wall time and ~tens of MB of transient
    allocations. Falls back to the historical pydub path if ffprobe
    cannot read the file, preserving behavior on any edge case.
    """
    try:
        info = ffprobe_info(path)
        dur = info.get("duration")
        if dur is not None and dur >= 0:
            return int(round(dur * 1000))
    except Exception:
        pass
    try:
        return len(AudioSegment.from_file(path))
    except Exception:
        return 0

# Fallback voices for different languages
FALLBACK_VOICES = {
    "gu-IN": ["gu-IN-NiranjanNeural", "gu-IN-DhwaniNeural"],
    "hi-IN": ["hi-IN-MadhurNeural", "hi-IN-SwaraNeural"],
    "ta-IN": ["ta-IN-PallaviNeural", "ta-IN-ValluvarNeural"],
    "te-IN": ["te-IN-MohanNeural", "te-IN-ShrutiNeural"],
    "kn-IN": ["kn-IN-GaganNeural", "kn-IN-SapnaNeural"],
    "ml-IN": ["ml-IN-MidhunNeural", "ml-IN-SobhanaNeural"],
    "bn-BD": ["bn-BD-PradeepNeural", "bn-BD-NabanitaNeural"],
    "en-GB": ["en-GB-RyanNeural", "en-GB-SoniaNeural"],
    "es-CO": ["es-CO-GonzaloNeural", "es-CO-SalomeNeural"],
    "ru-RU": ["ru-RU-DmitryNeural", "ru-RU-SvetlanaNeural"],
    "default": ["en-GB-RyanNeural", "en-GB-SoniaNeural"],
}


LETTER_SPELLED_ACRONYMS = {
    "AI",
    "AGI",
    "API",
    "APIs",
    "CPU",
    "CPUs",
    "GPU",
    "GPUs",
    "GPT",
    "IT",
    "LLM",
    "LLMs",
    "ML",
    "NLP",
    "UI",
    "UX",
}

KNOWN_PRONUNCIATION_HINTS = {
    "paramadvaita": "Parama-dvaita",
}


def _run_async(coro):
    """Run a coroutine to completion on a fresh event loop.

    asyncio.run() creates and closes a new loop per call. This is thread-safe
    (each thread gets its own loop), avoids stale-loop bugs from a module-level
    loop that never closes, and works correctly even if TTS is invoked from
    multiple worker threads. The per-call overhead is on the order of
    milliseconds, negligible compared to network TTS synthesis.
    """
    try:
        return asyncio.run(coro)
    except Exception as e:
        log("TTS", f"  Coroutine error: {type(e).__name__}: {str(e)[:200]}")
        raise e


async def _synthesize(text, voice, path, rate="+0%"):
    log("TTS", f"  Starting synthesis: voice={voice}, text_len={len(text)}")
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await communicate.save(path)
    log("TTS", f"  Synthesis complete: {path}")


def _sanitize_text(text):
    """Clean text for TTS synthesis - remove problematic characters."""
    if not text:
        return "..."

    # Remove control characters except newlines and tabs
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)

    # Replace multiple spaces with single space
    text = re.sub(r"\s+", " ", text)

    # Remove excessive punctuation
    text = re.sub(r"([.!?])\1+", r"\1", text)

    # Ensure text is not empty
    text = text.strip() or "..."

    # Limit text length (Edge TTS has limits)
    if len(text) > 5000:
        text = text[:4997] + "..."

    return text


def _spell_letters(token):
    return " ".join(list(token))


def _normalize_tts_pronunciation(text):
    """Normalize known terms so TTS pronounces them more naturally."""
    if not text:
        return text

    def preserve_case(token, replacement):
        if token.isupper():
            return replacement.upper()
        if token[0].isupper():
            return replacement
        return replacement.lower()

    normalized = re.sub(
        r"\bSovereign Order of KAILASA(?:'s|s)? Nithyananda\b",
        "Sovereign Order of KAILASA's Nithyananda",
        text,
        flags=re.IGNORECASE,
    )

    def replace_sacred_terms(match):
        token = match.group(0)
        lower = token.lower()
        replacements = {
            "agama": "Aagama",
            "agamas": "Aagamas",
            "atman": "Aatman",
            "brahman": "Brahman",
            "darshan": "Darshan",
            "devi": "Devi",
            "dharma": "Dharma",
            "guru": "Guru",
            "kailasa": "Kailaasa",
            "linga": "Linga",
            "mantra": "Mantra",
            "mantras": "Mantras",
            "moksha": "Moksha",
            "murti": "Murti",
            "prasad": "Prasaad",
            "puja": "Pooja",
            "sadhana": "Saadhana",
            "samadhi": "Samaadhi",
            "sanskrit": "Sanskrit",
            "shakti": "Shakti",
            "shaiva": "Shaiva",
            "shastra": "Shaastra",
            "shiva": "Shiva",
            "sutra": "Sutra",
            "tantra": "Tantra",
            "tantras": "Tantras",
            "upanishad": "Upanishad",
            "upanishads": "Upanishads",
            "veda": "Veda",
            "vedanta": "Vedaanta",
            "vedantic": "Vedaantic",
            "vedas": "Vedas",
            "yantra": "Yantra",
            "yantras": "Yantras",
        }
        replacement = replacements.get(lower)
        if not replacement:
            return token
        return preserve_case(token, replacement)

    normalized = re.sub(
        r"\b(?:agama|agamas|atman|brahman|darshan|devi|dharma|guru|kailasa|linga|mantra|mantras|moksha|murti|prasad|puja|sadhana|samadhi|sanskrit|shakti|shaiva|shastra|shiva|sutra|tantra|tantras|upanishad|upanishads|veda|vedanta|vedantic|vedas|yantra|yantras)\b",
        replace_sacred_terms,
        normalized,
        flags=re.IGNORECASE,
    )

    def replace_pronunciation_hint(match):
        token = match.group(0)
        replacement = KNOWN_PRONUNCIATION_HINTS.get(token.lower())
        if not replacement:
            return token
        return preserve_case(token, replacement)

    normalized = re.sub(
        r"\b(?:paramadvaita)\b",
        replace_pronunciation_hint,
        normalized,
        flags=re.IGNORECASE,
    )

    def replace_sjp(match):
        token = match.group(0)
        if token.lower().endswith("s"):
            return "S J Ps"
        return "S J P"

    normalized = re.sub(r"\bsjps?\b", replace_sjp, normalized, flags=re.IGNORECASE)

    def replace_known(match):
        token = match.group(0)
        upper = token.upper()
        suffix = ""
        if upper.endswith("S") and upper[:-1] in LETTER_SPELLED_ACRONYMS:
            suffix = " S"
            upper = upper[:-1]
        elif upper not in LETTER_SPELLED_ACRONYMS:
            return token
        spoken = _spell_letters(upper)
        return f"{spoken}{suffix}"

    normalized = re.sub(
        r"\b(?:ai|agi|api|apis|cpu|cpus|gpu|gpus|gpt|it|llm|llms|ml|nlp|ui|ux)\b",
        replace_known,
        normalized,
        flags=re.IGNORECASE,
    )

    def replace_hyphenated(match):
        token = match.group(1)
        if token.upper() in LETTER_SPELLED_ACRONYMS:
            return f"{_spell_letters(token.upper())} {match.group(2).lstrip('-')}"
        return match.group(0)

    normalized = re.sub(r"\b([A-Za-z]{2,5})(-\d+)\b", replace_hyphenated, normalized)
    normalized = re.sub(r"\b(([A-Z]\s+){1,5}[A-Z])-(\d+)\b", r"\1 \3", normalized)
    return normalized


def _extract_reference_audio(video_path, output_path, duration=10):
    """Extract a clean reference audio segment from source video for voice cloning."""
    import subprocess

    try:
        # Extract first 10 seconds of audio
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                video_path,
                "-t",
                str(duration),
                "-ar",
                "22050",
                "-ac",
                "1",
                "-f",
                "wav",
                output_path,
            ],
            capture_output=True,
            timeout=60,
        )
        if os.path.exists(output_path) and os.path.getsize(output_path) > 1000:
            log("TTS", f"  Reference audio extracted: {output_path}")
            return output_path
    except Exception as e:
        log("TTS", f"  Reference audio extraction failed: {e}")
    return None


def _get_fallback_voices(primary_voice):
    """Get list of fallback voices for a given primary voice."""
    # Extract language code from voice (e.g., "gu-IN-NiranjanNeural" -> "gu-IN")
    lang_code = "-".join(primary_voice.split("-")[:2])

    # Get fallback voices for this language
    fallbacks = FALLBACK_VOICES.get(lang_code, FALLBACK_VOICES["default"])

    # Ensure primary voice is first in list
    voices = [primary_voice]
    for v in fallbacks:
        if v != primary_voice:
            voices.append(v)

    return voices


def generate_tts_audio(
    segments,
    voice="en-GB-RyanNeural",
    output_dir="workspace",
):
    """
    Generate TTS audio for each segment.

    Args:
        segments: List of segment dicts with 'translated' or 'text'
        voice: Edge TTS voice ID (e.g., "gu-IN-NiranjanNeural")
        output_dir: Output directory
    """
    clips_dir = os.path.join(output_dir, "tts_clips")
    os.makedirs(clips_dir, exist_ok=True)
    log("TTS", f"Voice: {voice}  |  {len(segments)} segments")

    results = []
    skipped = []
    failed_segments = []

    # Get fallback voices
    voices = _get_fallback_voices(voice)
    log("TTS", f"Available voices: {voices}")

    for idx, seg in enumerate(segments):
        seg_id = seg["id"]
        if seg.get("preserve_original_audio"):
            log(
                "TTS",
                f"[{idx + 1}/{len(segments)}] seg#{seg_id}: preserving original source audio",
            )
            results.append(
                {
                    **seg,
                    "audio_path": None,
                    "audio_dur_ms": int(
                        max(float(seg.get("end", 0.0)) - float(seg.get("start", 0.0)), 0.0)
                        * 1000
                    ),
                    "tts_skipped": True,
                }
            )
            continue
        raw_text = (seg.get("translated") or seg.get("text", "")).strip()
        tts_text = _normalize_tts_pronunciation(raw_text)
        text = _sanitize_text(tts_text)
        clip = os.path.join(clips_dir, f"clip_{seg_id:04d}.wav")

        if text != raw_text:
            log("TTS", f"  Pronunciation normalized seg#{seg_id}: {raw_text[:70]} -> {text[:70]}")
        log("TTS", f"[{idx + 1}/{len(segments)}] seg#{seg_id}: {text[:70]}")

        success = False
        last_error = None

        # Edge TTS synthesis
        for voice_idx, current_voice in enumerate(voices):
            if voice_idx > 0:
                log("TTS", f"  Trying fallback voice: {current_voice}")
                # Add delay before fallback to give primary voice time to recover
                time.sleep(3)

            # More attempts for primary voice (8), fewer for fallback (5)
            max_attempts = 8 if voice_idx == 0 else 5
            log("TTS", f"  Voice: {current_voice}, max attempts: {max_attempts}")

            log("TTS", f"  About to enter attempt loop, max_attempts={max_attempts}")
            for attempt in range(1, max_attempts + 1):
                log("TTS", f"  Attempt {attempt}/{max_attempts} for {current_voice}")
                try:
                    log("TTS", f"  Creating coroutine...")
                    coro = _synthesize(text, current_voice, clip, rate="+0%")
                    log("TTS", f"  Running coroutine...")
                    _run_async(coro)
                    log("TTS", f"  Coroutine completed")

                    # Verify file was created
                    if os.path.exists(clip) and os.path.getsize(clip) > 100:
                        success = True
                        if voice_idx > 0:
                            log(
                                "TTS",
                                f"  Success with fallback voice: {current_voice}",
                            )
                        break
                    else:
                        log(
                            "TTS",
                            f"  File check failed: exists={os.path.exists(clip)}, size={os.path.getsize(clip) if os.path.exists(clip) else 0}",
                        )
                        raise RuntimeError("Generated file is empty or too small")

                except Exception as e:
                    last_error = e
                    error_msg = str(e)

                    # Log specific error types
                    if "403" in error_msg or "Forbidden" in error_msg:
                        log(
                            "TTS",
                            f"  Attempt {attempt}/{max_attempts}: Rate limited (403)",
                        )
                    elif "404" in error_msg or "Not Found" in error_msg:
                        log(
                            "TTS",
                            f"  Attempt {attempt}/{max_attempts}: Voice not found (404)",
                        )
                    elif "timeout" in error_msg.lower():
                        log("TTS", f"  Attempt {attempt}/{max_attempts}: Timeout")
                    else:
                        log(
                            "TTS",
                            f"  Attempt {attempt}/{max_attempts}: {error_msg[:100]}",
                        )

                    # Exponential backoff: 2s, 4s, 8s, 16s, 32s, 64s, 128s
                    if attempt < max_attempts:
                        delay = min(2**attempt, 30)  # Cap at 30 seconds
                        log("TTS", f"  Retrying in {delay}s...")
                        time.sleep(delay)

            if success:
                break

        if not success:
            log("TTS", f"  FAILED seg#{seg_id} after all attempts and fallbacks")
            log("TTS", f"     Last error: {last_error}")
            log("TTS", f"     Text: {text[:100]}")
            skipped.append(seg_id)
            failed_segments.append(
                {"seg_id": seg_id, "text": text, "error": str(last_error)}
            )
            continue

        dur_ms = _probe_audio_duration_ms(clip)
        results.append(
            {
                **seg,
                "tts_text": text,
                "audio_path": clip,
                "audio_dur_ms": dur_ms,
            }
        )
        log("TTS", f"  Generated {dur_ms}ms")

    if skipped:
        log("TTS", f"  WARNING: {len(skipped)} segments failed: {skipped}")
        log("TTS", f"Failed segments details:")
        for fs in failed_segments:
            log("TTS", f"  - seg#{fs['seg_id']}: {fs['error'][:50]}")

    # Save failed segments for potential retry
    if failed_segments:
        failed_path = os.path.join(output_dir, "tts_failed_segments.json")
        try:
            with open(failed_path, "w", encoding="utf-8") as f:
                json.dump(failed_segments, f, ensure_ascii=False, indent=2)
            log("TTS", f"Failed segments saved to: {failed_path}")
        except Exception as e:
            log("TTS", f"Could not save failed segments: {e}")

    return results
