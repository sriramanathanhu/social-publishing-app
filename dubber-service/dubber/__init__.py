# Trimmed for the dubber-service Phase 0 spike.
#
# The upstream autodubber __init__ eagerly imports the whole app (captions,
# vision, publishing via zernio/gspread, dub verification). The hosted service
# only needs the core dub path, and transcription is replaced by the Deepgram
# adapter (see app/transcribe_deepgram.py), so we expose just those modules
# here. This keeps the runtime dependency surface to requirements.txt and
# avoids pulling faster-whisper / demucs / zernio / gspread.

from .downloader import download_video, is_url
from .segment_merger import merge_short_segments
from .translator import translate_segments, get_translation_runtime_meta
from .tts_generator import generate_tts_audio
from .video_builder import build_dubbed_video
from .utils import log

__version__ = "2.1.6+dubber-service.phase0"

__all__ = [
    "download_video",
    "is_url",
    "merge_short_segments",
    "translate_segments",
    "get_translation_runtime_meta",
    "generate_tts_audio",
    "build_dubbed_video",
    "log",
]
