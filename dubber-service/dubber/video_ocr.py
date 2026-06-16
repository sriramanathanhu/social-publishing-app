#!/usr/bin/env python3
"""
Video OCR transcription module for extracting burned-in subtitles from video frames.
"""

import os
import subprocess
import tempfile
import re
from .utils import log
from .image_processor import extract_text_from_image


def extract_video_frames(video_path, output_dir, frame_interval=2.0):
    """
    Extract frames from video at regular intervals.

    Args:
        video_path: Path to video file
        output_dir: Directory to save extracted frames
        frame_interval: Extract one frame every N seconds

    Returns:
        List of (frame_path, timestamp) tuples
    """
    os.makedirs(output_dir, exist_ok=True)

    # Get video duration
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                video_path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        duration = float(result.stdout.strip())
    except Exception as e:
        log("VIDEO_OCR", f"Failed to get video duration: {e}")
        duration = 600  # Default 10 minutes

    frames = []
    timestamp = 0.0
    frame_count = 0

    log(
        "VIDEO_OCR",
        f"Extracting frames from {os.path.basename(video_path)} (duration: {duration:.1f}s)",
    )

    while timestamp < duration:
        frame_path = os.path.join(output_dir, f"frame_{frame_count:04d}.jpg")

        try:
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    str(timestamp),
                    "-i",
                    video_path,
                    "-vframes",
                    "1",
                    "-q:v",
                    "3",
                    frame_path,
                ],
                capture_output=True,
                timeout=30,
            )

            if os.path.exists(frame_path) and os.path.getsize(frame_path) > 1000:
                frames.append((frame_path, timestamp))
                frame_count += 1

        except Exception as e:
            log("VIDEO_OCR", f"Failed to extract frame at {timestamp:.1f}s: {e}")

        timestamp += frame_interval

    log("VIDEO_OCR", f"Extracted {len(frames)} frames")
    return frames


def detect_subtitle_region(frame_path):
    """
    Detect if frame has subtitles and identify the subtitle region.

    Args:
        frame_path: Path to frame image

    Returns:
        (has_subtitle, region) where region is (x1, y1, x2, y2) or None
    """
    try:
        from PIL import Image
        import numpy as np

        img = Image.open(frame_path)
        width, height = img.size

        # Subtitles are typically in bottom 30% of frame
        bottom_region = img.crop((0, int(height * 0.7), width, height))

        # Convert to grayscale and check for text-like patterns
        gray = np.array(bottom_region.convert("L"))

        # Look for high contrast areas (white text on dark background or vice versa)
        threshold = 100
        binary = (gray > threshold).astype(np.uint8)

        # Check if there's significant text-like content
        text_pixels = np.sum(binary)
        total_pixels = binary.size
        text_ratio = text_pixels / total_pixels

        # If 5-50% of bottom region is high contrast, likely has subtitles
        has_subtitle = 0.05 < text_ratio < 0.5

        if has_subtitle:
            # Estimate subtitle region (bottom 20% of frame)
            region = (0, int(height * 0.8), width, height)
        else:
            region = None

        return has_subtitle, region

    except Exception as e:
        log("VIDEO_OCR", f"Subtitle detection failed: {e}")
        return False, None


def extract_subtitle_text(frame_path, region=None):
    """
    Extract text from subtitle region of frame.

    Args:
        frame_path: Path to frame image
        region: Optional (x1, y1, x2, y2) region to crop

    Returns:
        Extracted text string
    """
    try:
        from PIL import Image

        img = Image.open(frame_path)

        if region:
            img = img.crop(region)

        # Save cropped region to temp file for OCR
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp_path = tmp.name
            img.save(tmp_path, quality=95)

        try:
            # Use existing OCR functionality
            text = extract_text_from_image(tmp_path)
            return text.strip()
        finally:
            os.unlink(tmp_path)

    except Exception as e:
        log("VIDEO_OCR", f"Subtitle extraction failed: {e}")
        return ""


def clean_subtitle_text(text):
    """
    Clean and normalize extracted subtitle text.

    Args:
        text: Raw OCR text

    Returns:
        Cleaned text
    """
    if not text:
        return ""

    # Remove common OCR artifacts
    text = re.sub(r"[|\\]", "", text)  # Remove pipes and backslashes
    text = re.sub(r"\s+", " ", text)  # Normalize whitespace
    text = text.strip()

    # Remove if text is just noise (too short or too many special chars)
    if len(text) < 3:
        return ""

    # Check if text looks like valid content (has letters)
    if not re.search(r"[a-zA-Z]", text):
        return ""

    return text


def transcribe_video_ocr(video_path, output_dir="workspace"):
    """
    Transcribe video using OCR on burned-in subtitles.

    Args:
        video_path: Path to video file
        output_dir: Directory for temporary files

    Returns:
        List of segment dicts with 'start', 'end', 'text' keys
    """
    frames_dir = os.path.join(output_dir, "ocr_frames")
    os.makedirs(frames_dir, exist_ok=True)

    log("VIDEO_OCR", f"Starting OCR transcription for {os.path.basename(video_path)}")

    # Extract frames every 3 seconds
    frames = extract_video_frames(video_path, frames_dir, frame_interval=3.0)

    if not frames:
        log("VIDEO_OCR", "No frames extracted")
        return []

    # Check first few frames for subtitles
    subtitle_detected = False
    for frame_path, timestamp in frames[:5]:
        has_subtitle, region = detect_subtitle_region(frame_path)
        if has_subtitle:
            subtitle_detected = True
            log("VIDEO_OCR", f"Subtitles detected at {timestamp:.1f}s")
            break

    if not subtitle_detected:
        log("VIDEO_OCR", "No subtitles detected in video")
        return []

    # Extract text from all frames
    segments = []
    prev_text = ""

    for frame_path, timestamp in frames:
        text = extract_subtitle_text(frame_path)
        text = clean_subtitle_text(text)

        if text and text != prev_text:
            # New subtitle text detected
            segment = {
                "start": timestamp,
                "end": timestamp + 3.0,  # Will be adjusted based on next segment
                "text": text,
                "source": "ocr",
            }
            segments.append(segment)
            prev_text = text
            log("VIDEO_OCR", f"  [{timestamp:.1f}s] {text[:50]}...")

    # Adjust end times based on next segment start
    for i in range(len(segments) - 1):
        segments[i]["end"] = segments[i + 1]["start"]

    # Set last segment end to video duration or +5 seconds
    if segments:
        try:
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    video_path,
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
            duration = float(result.stdout.strip())
            segments[-1]["end"] = duration
        except:
            segments[-1]["end"] = segments[-1]["start"] + 5.0

    log("VIDEO_OCR", f"Extracted {len(segments)} subtitle segments")

    # Clean up frames
    try:
        import shutil

        shutil.rmtree(frames_dir, ignore_errors=True)
    except:
        pass

    return segments


def has_burned_in_subtitles(video_path, sample_frames=3):
    """
    Quick check if video likely has burned-in subtitles.

    Args:
        video_path: Path to video file
        sample_frames: Number of frames to check

    Returns:
        True if subtitles detected, False otherwise
    """
    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            # Extract a few frames
            frames = extract_video_frames(video_path, tmp_dir, frame_interval=10.0)

            # Check first few frames
            for frame_path, timestamp in frames[:sample_frames]:
                has_subtitle, _ = detect_subtitle_region(frame_path)
                if has_subtitle:
                    return True

            return False

    except Exception as e:
        log("VIDEO_OCR", f"Subtitle check failed: {e}")
        return False
