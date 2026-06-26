"""Audio → chunked Gemini transcription (with optional translation).

Downloads an audio source (a direct URL, or a Google Drive share link),
splits it into N chunks with FFmpeg, transcribes each chunk with the Gemini
API, and concatenates the result. Optionally translates to a target language.
"""

from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import tempfile
import time
from typing import Callable

import requests
from google import genai

Progress = Callable[[int, str, str], None]


def _drive_id(link: str) -> str | None:
    """Extract a Drive file id from common share-link shapes (or a bare id)."""
    link = link.strip()
    m = re.search(r"/file/d/([a-zA-Z0-9_-]+)", link)
    if m:
        return m.group(1)
    m = re.search(r"[?&]id=([a-zA-Z0-9_-]+)", link)
    if m:
        return m.group(1)
    if re.fullmatch(r"[a-zA-Z0-9_-]{20,}", link):
        return link
    return None


def _drive_download(link: str, dest: str) -> str:
    """Download a (publicly shared) Google Drive file via gdown.

    gdown 6.x removed the `fuzzy` arg, so we parse the file id ourselves and
    download by id (the canonical uc?id=… form, with large-file confirm
    handling done by gdown).
    """
    import gdown

    file_id = _drive_id(link)
    if not file_id:
        raise RuntimeError(
            "Could not read a Google Drive file id from that link. Use a link "
            "like https://drive.google.com/file/d/FILE_ID/view."
        )
    out = gdown.download(id=file_id, output=dest, quiet=True)
    if not out or not os.path.exists(out):
        raise RuntimeError(
            "Could not download the Google Drive file. Make sure it is shared "
            "as 'Anyone with the link'."
        )
    return out


def _http_download(url: str, dest: str) -> str:
    with requests.get(url, stream=True, timeout=900) as r:
        r.raise_for_status()
        with open(dest, "wb") as fh:
            for chunk in r.iter_content(chunk_size=1 << 20):
                if chunk:
                    fh.write(chunk)
    return dest


def _download(source_type: str, source_input: str, work: str) -> str:
    dest = os.path.join(work, "source_audio")
    if source_type == "drive":
        return _drive_download(source_input, dest)
    return _http_download(source_input, dest)


def _duration(path: str) -> float:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", path,
        ],
        capture_output=True, text=True,
    )
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


_SILENCE_TRIM = (
    "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1,"
    "areverse,"
    "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1,"
    "areverse"
)


def _chunk(path: str, n: int, work: str) -> list[str]:
    """Split into ~n mono 16 kHz mp3 chunks of equal duration.

    First trims leading/trailing silence from the whole file: a chunk that ends
    in silence makes Gemini hallucinate text, and the natural end of the audio
    is the usual culprit. Internal speech pauses are preserved.
    """
    n = max(1, min(50, int(n)))
    trimmed = os.path.join(work, "trimmed.wav")
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000",
            "-af", _SILENCE_TRIM, trimmed,
        ],
        capture_output=True, text=True,
    )
    src = trimmed if os.path.exists(trimmed) and os.path.getsize(trimmed) > 2000 else path

    dur = _duration(src)
    seg = max(1.0, dur / n) if dur else 600.0
    pattern = os.path.join(work, "chunk_%03d.mp3")
    proc = subprocess.run(
        [
            "ffmpeg", "-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000",
            "-f", "segment", "-segment_time", str(seg),
            "-c:a", "libmp3lame", "-q:a", "5", pattern,
        ],
        capture_output=True, text=True,
    )
    chunks = sorted(glob.glob(os.path.join(work, "chunk_*.mp3")))
    if not chunks:
        raise RuntimeError(
            f"Audio could not be split (ffmpeg: {proc.stderr[-200:]})."
        )
    return chunks


_SCRIPT = {
    "tamil": "the Tamil script (தமிழ் எழுத்து)",
    "english": "the Latin alphabet (English script)",
    "hindi": "Devanagari (देवनागरी)",
    "sanskrit": "Devanagari (देवनागरी)",
}


def _script(lang: str) -> str:
    return _SCRIPT.get(lang.strip().lower(), f"the standard {lang} script")


# Best model for multi-language audio — recognises Hindi/Tamil/Sanskrit/English
# code-switching far better than flash (slower + pricier, by the user's choice).
_MODEL = "gemini-2.5-pro"


def _is_auto(lang: str) -> bool:
    return lang.strip().lower() in ("auto", "auto-detect", "autodetect", "multi", "")


def _transcribe_chunk(
    client: "genai.Client",
    path: str,
    source_lang: str,
    output_lang: str,
    translate: bool,
) -> str:
    f = client.files.upload(file=path)
    for _ in range(180):
        f = client.files.get(name=f.name)
        state = str(f.state)
        if "ACTIVE" in state:
            break
        if "FAILED" in state:
            raise RuntimeError("Gemini could not process the audio chunk.")
        time.sleep(1)

    no_speech = (
        " Transcribe ONLY the words actually spoken in THIS clip. The moment the "
        "speaker stops, stop writing — do NOT add, continue, summarise, or invent "
        "anything not actually spoken. Ignore silence. If there is no intelligible "
        "speech, return an empty response."
    )
    if translate:
        src = (
            "the speech (in whatever language it is spoken)"
            if _is_auto(source_lang)
            else f"the {source_lang} speech"
        )
        instruction = (
            f"Translate {src} into {output_lang}, written in "
            f"{_script(output_lang)}. Output ONLY the {output_lang} translation "
            f"as clean prose — no timestamps, no speaker labels, no commentary."
            + no_speech
        )
    else:
        # Faithful, multi-language transcription. The speaker may switch between
        # languages — transcribe each part in its OWN language and native script,
        # never flattening everything to one language.
        hint = (
            ""
            if _is_auto(source_lang)
            else f" The audio is primarily in {source_lang}, but the speaker may "
            "switch to other languages at any time."
        )
        instruction = (
            "Transcribe this audio EXACTLY as spoken, word for word." + hint +
            " The speaker may mix languages (for example Hindi, Sanskrit, Tamil, "
            "English). Transcribe each portion in the SAME language it is spoken "
            "in, using that language's NATIVE script: Hindi and Sanskrit in "
            "Devanagari (देवनागरी), Tamil in the Tamil script (தமிழ்), English in "
            "the Latin alphabet, and any other language in its own native script. "
            "Do NOT translate, romanise, or transliterate; do NOT normalise the "
            "text into a single language. Output ONLY the verbatim transcript as "
            "clean prose — no timestamps, no speaker labels, no commentary."
            + no_speech
        )

    # gemini-2.5-pro requires thinking mode (it rejects a budget of 0), so leave
    # thinking at the model default; give a generous output budget so dense
    # multi-script transcripts aren't truncated.
    resp = client.models.generate_content(
        model=_MODEL,
        contents=[f, instruction],
        config={
            "temperature": 0.1,
            "max_output_tokens": 32768,
            "system_instruction": (
                "You are a precise, multilingual audio transcriptionist. You "
                "transcribe every word faithfully in the exact language it is "
                "spoken, in that language's native script, and never translate or "
                "transliterate unless explicitly asked to translate."
            ),
        },
    )
    try:
        client.files.delete(name=f.name)
    except Exception:
        pass
    return (resp.text or "").strip()


def _format_paragraphs(client: "genai.Client", text: str) -> str:
    """Re-flow the transcript into readable paragraphs WITHOUT changing content.

    Asks the model to only insert paragraph breaks, then verifies the result is
    character-for-character identical to the input once whitespace is ignored —
    if the model altered, corrected, translated or dropped anything, we discard
    its output and keep the original. So this can only ever change whitespace.
    """
    instruction = (
        "Reformat the transcript below into clean, readable paragraphs by "
        "inserting paragraph breaks (blank lines) at natural pauses / topic "
        "shifts.\n\n"
        "ABSOLUTE RULES — the wording must stay 100% unchanged:\n"
        "- Do NOT add, remove, reorder, correct, rephrase, translate, "
        "transliterate, or re-spell ANY word or character.\n"
        "- Do NOT fix grammar, punctuation, or capitalisation.\n"
        "- Keep every language and script exactly as written.\n"
        "- The only thing you may change is where line breaks / blank lines go.\n"
        "Output ONLY the reformatted transcript.\n\n"
        "TRANSCRIPT:\n" + text
    )
    try:
        resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[instruction],
            config={
                "temperature": 0,
                "thinking_config": {"thinking_budget": 0},
                "max_output_tokens": 65536,
            },
        )
        formatted = (resp.text or "").strip()
    except Exception:
        return text
    # Accept only if nothing but whitespace changed (content is preserved).
    if formatted and "".join(formatted.split()) == "".join(text.split()):
        return formatted
    return text


def run_transcribe(
    *,
    source_type: str,
    source_input: str,
    chunks: int,
    source_lang: str,
    output_lang: str,
    translate: bool,
    gemini_key: str,
    on_progress: Progress,
) -> str:
    if not gemini_key:
        raise RuntimeError("A Gemini API key is required for transcription.")
    work = tempfile.mkdtemp(prefix="transcribe_")
    try:
        on_progress(5, "download", "Fetching audio…")
        audio = _download(source_type, source_input, work)
        on_progress(15, "chunk", f"Splitting into {chunks} chunk(s)…")
        parts = _chunk(audio, chunks, work)
        total = len(parts)
        client = genai.Client(api_key=gemini_key)
        texts: list[str] = []
        for i, ch in enumerate(parts):
            on_progress(
                15 + int(80 * i / total),
                "transcribe",
                f"Transcribing chunk {i + 1}/{total}…",
            )
            texts.append(
                _transcribe_chunk(client, ch, source_lang, output_lang, translate)
            )
        on_progress(95, "finalize", "Assembling transcript…")
        transcript = "\n\n".join(t for t in texts if t).strip()
        if not transcript:
            raise RuntimeError("Transcription produced no text.")
        on_progress(97, "format", "Formatting into paragraphs…")
        transcript = _format_paragraphs(client, transcript)
        on_progress(100, "done", "Done")
        return transcript
    finally:
        shutil.rmtree(work, ignore_errors=True)
