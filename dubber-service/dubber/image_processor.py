#!/usr/bin/env python3
"""Image processing module for OCR and content generation"""

import os
import json
import time
import re
from .utils import log
from .runtime_config import is_economy_mode
from .config import get_gemini_api_key
import sys

sys.stdout.reconfigure(encoding="utf-8")


# --- One-shot Tesseract path initialization ---------------------------------
# Performed once at module import to avoid per-OCR-call os.environ['PATH']
# read-modify-writes from worker threads. Result is cached in module state;
# extract_text_from_image() only reads the flag.
_TESSERACT_EXE = None          # Full path to tesseract.exe if found, else None
_TESSERACT_INIT_ERR = None     # Descriptive error string when not found


def _initialize_tesseract_path():
    """Resolve Tesseract install location once. Safe to call multiple times."""
    global _TESSERACT_EXE, _TESSERACT_INIT_ERR
    if _TESSERACT_EXE or _TESSERACT_INIT_ERR:
        return  # Already initialized
    if os.name != "nt":
        # Non-Windows: rely on PATH lookup by pytesseract; no PATH mutation.
        _TESSERACT_EXE = ""  # Empty string = use system default
        return
    tesseract_dir = (
        os.environ.get("TESSERACT_DIR", "").strip()
        or r"C:\Program Files\Tesseract-OCR"
    )
    tesseract_exe = os.path.join(tesseract_dir, "tesseract.exe")
    if os.path.isfile(tesseract_exe):
        # Prepend directory to PATH exactly once (idempotent guard).
        current_path = os.environ.get("PATH", "")
        if tesseract_dir not in current_path:
            os.environ["PATH"] = tesseract_dir + ";" + current_path
        _TESSERACT_EXE = tesseract_exe
    else:
        _TESSERACT_INIT_ERR = (
            f"Tesseract not found at '{tesseract_exe}'. "
            "Set TESSERACT_DIR env var if installed elsewhere."
        )


# Run once at import so worker threads never mutate os.environ.
_initialize_tesseract_path()


LANGUAGE_META = {
    "en": {
        "name": "English",
        "script_hint": "Write in clear natural English.",
        "style_hint": "Use warm devotional English for a broad audience.",
    },
    "gu": {
        "name": "Gujarati",
        "script_hint": "Write in Gujarati script.",
        "style_hint": "Use devotional Gujarati with natural Sanskrit terms where they fit.",
    },
    "hi": {
        "name": "Hindi",
        "script_hint": "Write in Devanagari script.",
        "style_hint": "Use devotional Hindi with natural Sanskrit terms where they fit.",
    },
    "ta": {
        "name": "Tamil",
        "script_hint": "Write in Tamil script.",
        "style_hint": "Use natural spoken Tamil with devotional warmth.",
    },
    "te": {
        "name": "Telugu",
        "script_hint": "Write in Telugu script.",
        "style_hint": "Use natural spoken Telugu with devotional warmth.",
    },
    "kn": {
        "name": "Kannada",
        "script_hint": "Write in Kannada script.",
        "style_hint": "Use natural spoken Kannada with devotional warmth.",
    },
    "ml": {
        "name": "Malayalam",
        "script_hint": "Write in Malayalam script.",
        "style_hint": "Use natural spoken Malayalam with devotional warmth.",
    },
    "bn": {
        "name": "Bengali",
        "script_hint": "Write in Bengali script.",
        "style_hint": "Use natural spoken Bengali with devotional warmth.",
    },
    "es": {
        "name": "Spanish",
        "script_hint": "Write in natural Spanish.",
        "style_hint": "Use clear devotional Spanish that sounds native and warm.",
    },
    "ru": {
        "name": "Russian",
        "script_hint": "Write in natural Russian.",
        "style_hint": "Use clear devotional Russian that sounds native and warm.",
    },
}


def _target_meta(target_language):
    code = str(target_language or "en").strip().lower()
    return code, LANGUAGE_META.get(code, LANGUAGE_META["en"])


def extract_text_from_image(image_path, api_key=None):
    """Extract text from image using OCR"""
    api_key = get_gemini_api_key(api_key)
    try:
        # Try multiple OCR approaches
        extracted_text = ""

        # Method 1: Try using pytesseract (if available)
        try:
            import pytesseract
            from PIL import Image

            # Use cached tesseract path resolved at module import time.
            if os.name == "nt":  # Windows
                if not _TESSERACT_EXE:
                    log(
                        "OCR",
                        f"{_TESSERACT_INIT_ERR or 'Tesseract unavailable'} — "
                        "skipping local OCR, will use Gemini fallback.",
                    )
                    raise ImportError("tesseract_not_installed")
                pytesseract.pytesseract.tesseract_cmd = _TESSERACT_EXE

            image = Image.open(image_path)
            extracted_text = pytesseract.image_to_string(image)
            log("OCR", f"Pytesseract extracted {len(extracted_text)} chars")
            if extracted_text.strip():
                return extracted_text.strip()
        except ImportError:
            log("OCR", "Pytesseract not available, trying alternative...")
        except Exception as e:
            log("OCR", f"Pytesseract failed: {e}")

        # Method 2: Try using Gemini Vision API
        if api_key:
            try:
                extracted_text = _extract_with_gemini_vision(image_path, api_key)
                if extracted_text.strip():
                    return extracted_text.strip()
            except Exception as e:
                log("OCR", f"Gemini Vision failed: {e}")

        # Method 3: Basic fallback - return meaningful placeholder text
        filename = os.path.basename(image_path)
        log("OCR", f"Using fallback - filename: {filename}")

        # Try to extract meaningful info from filename
        if "ai" in filename.lower() or "nithyananda" in filename.lower():
            fallback_text = "Ask Nithyananda AI app - Your personal spiritual companion for divine guidance and blessings from SPH Bhagavan Sri Nithyananda Paramashivam. Available now for iOS and Android download."
        elif "kailasa" in filename.lower():
            fallback_text = "KAILASA - The Hindu nation re-established by SPH Bhagavan Sri Nithyananda Paramashivam. Experience the ancient enlightenment civilization in the modern world."
        else:
            fallback_text = "Divine spiritual guidance and blessings from SPH Bhagavan Sri Nithyananda Paramashivam. Experience the presence of KAILASA in your daily life."

        return fallback_text

    except Exception as e:
        log("OCR", f"All OCR methods failed: {e}")
        return f"Error extracting text: {str(e)}"


def _extract_with_gemini_vision(image_path, api_key):
    """Extract text using Gemini Vision API"""
    from google import genai
    from google.genai import types
    import base64

    client = genai.Client(api_key=api_key)

    # Read and encode image
    with open(image_path, "rb") as f:
        image_data = f.read()

    # Create prompt for text extraction
    prompt = """Extract all text from this image. Return only the extracted text, nothing else. 
    If there is no text, return "No text found in image"."""

    resp = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=[
            prompt,
            types.Part.from_bytes(
                data=image_data,
                mime_type="image/jpeg"
                if image_path.lower().endswith((".jpg", ".jpeg"))
                else "image/png",
            ),
        ],
        config=types.GenerateContentConfig(
            temperature=0.1,
            max_output_tokens=1024,
        ),
    )

    return resp.text.strip()


def _build_caption_prompt(target_language):
    _, meta = _target_meta(target_language)
    language_name = meta["name"]
    script_hint = meta["script_hint"]
    style_hint = meta["style_hint"]
    return f"""
You are a devotional social media copywriter for KAILASA — the Hindu nation
re-established by SPH Bhagavan Sri Nithyananda Paramashivam. You write
platform-specific captions in {language_name} that speak directly to SPH devotees.

TARGET LANGUAGE RULES:
- Write all captions in {language_name}.
- {script_hint}
- {style_hint}

CONTENT RULES:

1. STUDY THE IMAGE CAREFULLY. Extract every visible feature
   (selfie guidance, privacy badges, support info, UI elements, taglines).
   Weave unique features into captions.
   At least 2 captions must reference a unique feature extracted
   from this specific image — not generic app benefits that apply
   to any flyer.
   ALSO extract the URL or web link visible in the flyer — you will use
   it in step 5. Store it as extracted_url in your output.

2. EACH PLATFORM NEEDS A DIFFERENT EMOTIONAL ENTRY POINT:
   - Instagram: Feeling of SPH's presence — visual, devotional, personal
   - Facebook: Community/family sharing together — warm, inclusive
   - Twitter/X: Breaking urgency — punchy. STRICT 280 character max
      including hashtags and URL. Count characters before finalizing.
      Hook must reference a specific feature visible in this image.
      Never open with the app name or product announcement.
   - Threads: Conversational — "you asked, now it exists"
   - Bluesky: Thoughtful — AI + divine guidance for seekers.
     STRICT 300 character max including hashtags and URL.

3. HOOK RULE — NEVER open with product info. Open with a devotee desire,
   recognition moment, or emotional truth in natural {language_name}.

4. CTA RULE — Use the URL you extracted from the flyer in step 1.
   If no URL was visible in the flyer, use: kailasa.org
   The URL goes on its own line at the very end of the caption,
   before hashtags. Never mid-caption. Never buried in text.
   Format per platform in natural {language_name}:
   - Instagram: short "link in bio" CTA plus EXTRACTED_URL
   - Facebook: direct download CTA plus EXTRACTED_URL
   - Twitter/X: EXTRACTED_URL and a compact download cue
   - Threads: "Download here" style CTA plus EXTRACTED_URL
   - Bluesky: "Download here" style CTA plus EXTRACTED_URL

5. HASHTAGS — Every caption must end with AT LEAST: #KAILASA #Nithyananda
   Additional relevant hashtags are allowed per platform.
   Hashtags go AFTER the URL line. Never before.

OUTPUT RULES:
- Return JSON only. No explanation. No markdown fences. No extra text.
- Structure must be exactly this:
{{
  "extracted_url": "the url you found in the image",
  "captions": {{
    "instagram": "full caption here",
    "facebook": "full caption here",
    "twitter": "full caption here",
    "threads": "full caption here",
    "bluesky": "full caption here"
  }}
}}
"""


def generate_platform_captions(extracted_text, target_language="gu", api_key=None):
    """Generate platform captions from extracted text in the selected target language."""
    api_key = get_gemini_api_key(api_key)
    if not api_key:
        return "No API key available for caption generation"

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key)

        prompt = f"""{_build_caption_prompt(target_language)}
        
        EXTRACTED TEXT FROM IMAGE:
        {extracted_text}
        """

        resp = client.models.generate_content(
            model="gemini-2.5-flash-lite",
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.7,
                max_output_tokens=2048,
                response_mime_type="application/json",
            ),
        )

        # Validate raw response before parsing. Gemini can return an empty
        # `.text` when the response is blocked by safety filters, or return
        # JSON that is missing required keys on a partial/malformed completion.
        raw_text = getattr(resp, "text", None)
        if not raw_text or not str(raw_text).strip():
            raise ValueError(
                "Empty response from Gemini (likely safety filter or truncation)"
            )

        try:
            data = json.loads(str(raw_text).strip())
        except json.JSONDecodeError as je:
            raise ValueError(f"Gemini returned non-JSON text: {je}; head={str(raw_text)[:200]!r}")

        if not isinstance(data, dict):
            raise ValueError(f"Gemini JSON is not an object: type={type(data).__name__}")

        extracted_url = data.get("extracted_url")
        if extracted_url:
            log("CAPTIONS", f"Extracted URL (verify before publishing): {extracted_url}")

        captions = data.get("captions")
        if not isinstance(captions, dict) or not captions:
            raise ValueError(
                f"Gemini response missing/invalid 'captions' object: keys={list(data.keys())}"
            )

        _, meta = _target_meta(target_language)
        log("CAPTIONS", f"Generated {len(captions)} {meta['name']} captions")
        return captions

    except Exception as e:
        log("CAPTIONS", f"Failed to generate captions: {e}")

        # Check if it's a quota issue and provide fallback
        error_str = str(e).lower()
        if (
            "429" in error_str
            or "resource_exhausted" in error_str
            or "quota" in error_str
        ):
            log("CAPTIONS", "API quota exceeded - providing source-based fallback captions")
            fallback_text = re.sub(r"\s+", " ", str(extracted_text or "")).strip()
            if not fallback_text:
                fallback_text = "KAILASA content update"
            base = fallback_text[:220].rstrip(" .,!?")
            if len(fallback_text) > len(base):
                base += "..."
            return {
                "instagram": f"{base}\n\n#KAILASA #Nithyananda",
                "facebook": f"{base}\n\n#KAILASA #Nithyananda",
                "twitter": f"{base[:220].rstrip(' .,!?')}\n\n#KAILASA #Nithyananda",
                "threads": f"{base}\n\n#KAILASA",
                "bluesky": f"{base[:240].rstrip(' .,!?')}\n\n#KAILASA",
            }

        return {"error": f"Caption generation failed: {str(e)}"}


def generate_gujarati_captions(extracted_text, api_key=None):
    """Backward-compatible wrapper for the older Gujarati-specific entrypoint."""
    return generate_platform_captions(
        extracted_text, target_language="gu", api_key=api_key
    )


def generate_teaser_content(
    extracted_text, captions, api_key=None, target_language="gu"
):
    """Generate teaser content from extracted text and captions."""
    api_key = get_gemini_api_key(api_key)
    _, meta = _target_meta(target_language)
    language_name = meta["name"]
    script_hint = meta["script_hint"]
    if is_economy_mode():
        # Save one Gemini call in Economy mode: build deterministic teaser locally.
        sample_caption = ""
        if isinstance(captions, dict):
            sample_caption = captions.get("instagram") or captions.get("facebook") or ""
            if isinstance(sample_caption, dict):
                sample_caption = sample_caption.get("caption", "")
        sample_caption = str(sample_caption or "").strip()
        if not sample_caption:
            sample_caption = str(extracted_text or "").strip()

        # Keep teaser concise and operator-friendly.
        brief = (
            sample_caption.split("\n")[0][:160].strip()
            or "Download and share this KAILASA update."
        )
        teaser = {
            "hook": brief,
            "main_content": brief,
            "call_to_action": "Review, download, and share this with other seekers.",
            "hashtags": "#KAILASA #Nithyananda",
            "duration_estimate": "15-30 seconds",
        }
        log("TEASER", "Economy mode: generated local teaser (Gemini skipped)")
        return teaser

    if not api_key:
        return "No API key available for teaser generation"

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key)

        # Get a sample caption for context
        sample_caption = (
            captions.get("instagram", "")
            if isinstance(captions, dict)
            else str(captions)
        )

        prompt = f"""
        Based on this flyer content and caption, generate teaser content for social media promotion:
        
        FLYER TEXT:
        {extracted_text}
        
        SAMPLE CAPTION:
        {sample_caption}
        
        Generate teaser content in this JSON format:
        {{
            "hook": "Engaging opening line ({language_name})",
            "main_content": "Main teaser message ({language_name}, 2-3 sentences)",
            "call_to_action": "Call to action ({language_name})",
            "hashtags": "Relevant hashtags ({language_name} + English)",
            "duration_estimate": "Estimated video duration (e.g., 15-30 seconds)"
        }}
        
        Guidelines:
        - Write in {language_name}
        - {script_hint}
        - Make it engaging and shareable
        - Include spiritual elements if appropriate
        - Keep it concise for short-form video
        """

        resp = client.models.generate_content(
            model="gemini-2.5-flash-lite",
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.7,
                max_output_tokens=1024,
                response_mime_type="application/json",
            ),
        )

        teaser = json.loads(resp.text.strip())
        log("TEASER", f"Generated teaser content")
        return teaser

    except Exception as e:
        log("TEASER", f"Failed to generate teaser: {e}")
        return {"error": f"Teaser generation failed: {str(e)}"}
