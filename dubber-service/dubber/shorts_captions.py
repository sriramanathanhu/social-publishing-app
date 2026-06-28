"""
Burned-in captions for short clips (ASS subtitles → ffmpeg).

Default style "whitebox": a clean WHITE box with BLACK, BOLD, uppercase text
(static, one line per group), centred — the standard reel-caption look.
Other styles (word-by-word, spoken word highlighted): pop, karaoke, boxed.
"""

from __future__ import annotations

import os
import subprocess

from .utils import log

DEFAULT_COLOR = "#FFD700"   # gold highlight
DEFAULT_FONT_SIZE = 36
DEFAULT_MAX_WORDS = 4


def _rgb2ass(hexcolor: str) -> str:
    h = hexcolor.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"&H00{b:02X}{g:02X}{r:02X}"


def _ft(s: float) -> str:
    s = max(0.0, s)
    return f"{int(s // 3600)}:{int((s % 3600) // 60):02d}:{int(s % 60):02d}.{int((s % 1) * 100):02d}"


def _font_for_text(text: str) -> str:
    """Pick a font that actually has the glyphs for this line's script. Needed for
    multilingual captions (Sanskrit/Hindi → Devanagari, Tamil) — Latin-only fonts
    render those as boxes. libass also falls back per-glyph via fontconfig, but
    choosing the right PRIMARY per line avoids any fallback gaps. Requires the
    Noto Indic fonts (fonts-noto-core) to be installed in the worker."""
    for ch in text:
        o = ord(ch)
        if 0x0B80 <= o <= 0x0BFF:           # Tamil
            return "Noto Sans Tamil"
        if 0x0900 <= o <= 0x097F:           # Devanagari (Hindi + Sanskrit)
            return "Noto Sans Devanagari"
    return "Noto Sans"


def _clip_words(words, start_s, end_s):
    """Words within [start_s, end_s], re-timed to clip-relative seconds."""
    out = []
    for w in words:
        if start_s <= w["start"] <= end_s:
            out.append({
                "word": w["word"],
                "start": w["start"] - start_s,
                "end": w["end"] - start_s,
            })
    return out


def _make_ass(words, rx, ry, style, color, font_size, max_words) -> str:
    hl = _rgb2ass(color)
    white, black, shadow = "&H00FFFFFF", "&H00000000", "&H80000000"
    fs = int(font_size * (ry / 1920) * 2.5)

    # Per-style geometry + colours.
    if style == "whitebox":
        # Clean WHITE box with BLACK, BOLD text — the "reel caption" look. With
        # BorderStyle=3 the box is drawn in OutlineColour (white) and the text in
        # PrimaryColour (black); Outline is the padding around the text, and a
        # soft shadow gives the box depth. Positioned near the vertical centre.
        ol, sd, bd, bs = max(12, fs // 6), 2, 1, 3
        primary, boxcol = black, white
        # Alignment 2 = bottom-anchored, so MarginV is the gap from the BOTTOM
        # edge. 0.20 → box bottom at 80% from the top (lower-third), leaving the
        # bottom 20% clear for the platform's own UI.
        align, marginv = 2, int(ry * 0.20)
    else:
        ol, sd, bd, bs = {
            "pop": (3, 2, 1, 1), "karaoke": (2, 1, 1, 1), "boxed": (0, 0, 1, 3),
        }.get(style, (2, 1, 0, 1))
        primary, boxcol = white, black
        align, marginv = 8, int(ry * 0.78)

    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {rx}
PlayResY: {ry}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: D,Noto Sans,{fs},{primary},{hl},{boxcol},{shadow},{bd},0,0,0,100,100,0,0,{bs},{ol},{sd},{align},60,60,{marginv},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    if not words:
        return head

    groups = [words[i:i + max_words] for i in range(0, len(words), max_words)]
    body = ""

    if style == "whitebox":
        # One static, UPPERCASE line per group (no per-word colour highlight) for
        # the clean reference look.
        for gi, grp in enumerate(groups):
            gs = grp[0]["start"]
            ge = (
                groups[gi + 1][0]["start"]
                if gi + 1 < len(groups)
                else grp[-1]["end"] + 0.3
            )
            raw = " ".join(w["word"] for w in grp)
            # Per-line font override so Tamil/Devanagari render as real glyphs.
            txt = "{\\fn" + _font_for_text(raw) + "}" + raw.upper()
            body += f"Dialogue: 0,{_ft(gs)},{_ft(ge)},D,,0,0,0,,{txt}\n"
        return head + body

    for gi, grp in enumerate(groups):
        group_end = groups[gi + 1][0]["start"] if gi + 1 < len(groups) else grp[-1]["end"] + 0.3
        for wi, aw in enumerate(grp):
            ws = aw["start"]
            we = grp[wi + 1]["start"] if wi + 1 < len(grp) else group_end
            parts = []
            for wj, w in enumerate(grp):
                t = w["word"]
                if wj == wi:
                    if style == "pop":
                        parts.append(f"{{\\c{hl}\\fscx112\\fscy112\\b1}}{t}{{\\c{white}\\fscx100\\fscy100}}")
                    elif style == "karaoke":
                        parts.append(f"{{\\c{hl}\\b1}}{t}{{\\c{white}\\b0}}")
                    elif style == "boxed":
                        parts.append(f"{{\\c{hl}\\b1}}{t}{{\\c{white}}}")
                    else:
                        parts.append(f"{{\\c{hl}}}{t}{{\\c{white}}}")
                else:
                    parts.append(t)
            txt = " ".join(parts)
            if style == "pop":
                # Uppercase only the visible text, not the override tags.
                r2, intag = "", False
                for ch in txt:
                    if ch == "{":
                        intag = True
                    elif ch == "}":
                        intag = False
                    r2 += ch if intag else ch.upper()
                txt = r2
            body += f"Dialogue: 0,{_ft(ws)},{_ft(we)},D,,0,0,0,,{txt}\n"
    return head + body


def make_ass_file(words, start_s, end_s, rx, ry, settings, ass_path) -> bool:
    """Write an ASS subtitle file for a clip's time range. Returns True if it
    has content. Used by the single-pass renderer (apply via the ass= filter)."""
    cwords = _clip_words(words, start_s, end_s)
    if not cwords:
        return False
    style = settings.get("caption_style", "whitebox")
    color = settings.get("caption_color", DEFAULT_COLOR)
    font_size = int(settings.get("font_size", DEFAULT_FONT_SIZE))
    max_words = int(settings.get("max_words_per_line", DEFAULT_MAX_WORDS))
    ass = _make_ass(cwords, rx, ry, style, color, font_size, max_words)
    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(ass)
    return True


def burn_captions(clip_path, words, start_s, end_s, out_path, rx, ry,
                  settings, on_log=log) -> bool:
    """Burn word-by-word captions onto ``clip_path`` → ``out_path``. Returns
    True on success; on any failure leaves it to the caller to keep the raw clip."""
    cwords = _clip_words(words, start_s, end_s)
    if not cwords:
        return False
    style = settings.get("caption_style", "whitebox")
    color = settings.get("caption_color", DEFAULT_COLOR)
    font_size = int(settings.get("font_size", DEFAULT_FONT_SIZE))
    max_words = int(settings.get("max_words_per_line", DEFAULT_MAX_WORDS))

    ass = _make_ass(cwords, rx, ry, style, color, font_size, max_words)
    ass_path = clip_path + ".ass"
    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(ass)

    subprocess.run(
        ["ffmpeg", "-y", "-i", clip_path, "-vf", f"ass={ass_path}",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
         "-c:a", "copy", "-movflags", "+faststart", out_path],
        capture_output=True,
    )
    ok = os.path.exists(out_path) and os.path.getsize(out_path) > 5000
    if not ok:
        on_log("CAPTION", f"caption burn failed for {os.path.basename(clip_path)}")
    return ok
