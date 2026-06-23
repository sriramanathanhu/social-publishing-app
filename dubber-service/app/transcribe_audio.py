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
        " Transcribe ONLY the words actually spoken in THIS audio clip. The "
        "moment the speaker stops talking, stop writing — do NOT add, continue, "
        "summarise, or invent any sentence that is not actually spoken. Ignore "
        "any silence. If the clip contains no intelligible speech at all, return "
        "an empty response."
    )
    if translate and output_lang.lower() != source_lang.lower():
        instruction = (
            f"The spoken language is {source_lang}. Listen to the audio, then "
            f"TRANSLATE the speech into {output_lang}. Output ONLY the "
            f"{output_lang} text as clean, readable prose — natural paragraphs, "
            f"no timestamps, no speaker labels, no commentary." + no_speech
        )
    else:
        instruction = (
            f"The spoken language is {source_lang}. Transcribe the speech "
            f"verbatim in {source_lang}. Output ONLY the transcript as clean, "
            f"readable prose — natural paragraphs, no timestamps, no speaker "
            f"labels, no commentary." + no_speech
        )

    resp = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[f, instruction],
        config={
            "temperature": 0.2,
            "thinking_config": {"thinking_budget": 0},
            "max_output_tokens": 8192,
        },
    )
    try:
        client.files.delete(name=f.name)
    except Exception:
        pass
    return (resp.text or "").strip()


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
        on_progress(98, "finalize", "Assembling transcript…")
        transcript = "\n\n".join(t for t in texts if t).strip()
        if not transcript:
            raise RuntimeError("Transcription produced no text.")
        on_progress(100, "done", "Done")
        return transcript
    finally:
        shutil.rmtree(work, ignore_errors=True)
