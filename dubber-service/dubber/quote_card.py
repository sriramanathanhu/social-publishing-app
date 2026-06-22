"""
Quote image cards: composite a background photo + the brand overlay PNG + the
quote text into a 1080×1350 card with Pillow.

Layers (bottom→top):
  1. background photo, cover-fit to 1080×1350 (pan/zoom to frame the subject)
  2. the brand overlay PNG (transparent over the photo, opaque frame + quote box)
  3. the quote text — word-wrapped and auto-fit into the box, under the " mark
     and above the @handle.

Overlay + font are local brand assets under assets/quote/. The text box, colour
and font size range are caller-overridable so an admin can recalibrate without
a code change.
"""

from __future__ import annotations

import io
import os

import requests
from PIL import Image, ImageDraw, ImageFont

from .utils import log

_ASSETS = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "quote")
OVERLAY_PATH = os.path.join(_ASSETS, "overlay.png")
FONT_PATH = os.path.join(_ASSETS, "font.ttf")

CARD_W, CARD_H = 1080, 1350
# Default text rectangle inside the dark box (measured from the overlay):
# under the " mark (~y945) and above the @handle (~y1193).
DEFAULT_BOX = (110, 975, 975, 1170)
DEFAULT_COLOR = (245, 242, 235)  # warm cream
_LINE_RATIO = 1.28


def _cover_fit(img: Image.Image, w: int, h: int, pan_y: float, zoom: float) -> Image.Image:
    """Scale to COVER w×h then crop; pan_y 0=top..1=bottom, zoom ≥1 zooms in."""
    img = img.convert("RGB")
    iw, ih = img.size
    scale = max(w / iw, h / ih) * max(zoom, 1.0)
    nw, nh = max(w, int(iw * scale)), max(h, int(ih * scale))
    img = img.resize((nw, nh), Image.LANCZOS)
    x = (nw - w) // 2
    y = int((nh - h) * min(max(pan_y, 0.0), 1.0))
    return img.crop((x, y, x + w, y + h))


def _wrap(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, max_w: int):
    lines, cur = [], ""
    for word in text.split():
        trial = f"{cur} {word}".strip()
        if draw.textlength(trial, font=font) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def _fit(draw, text, box, max_size, min_size):
    left, top, right, bottom = box
    max_w, max_h = right - left, bottom - top
    for size in range(max_size, min_size - 1, -2):
        font = ImageFont.truetype(FONT_PATH, size)
        lines = _wrap(draw, text, font, max_w)
        line_h = int(size * _LINE_RATIO)
        if line_h * len(lines) <= max_h:
            return font, lines, line_h
    font = ImageFont.truetype(FONT_PATH, min_size)
    return font, _wrap(draw, text, font, right - left), int(min_size * _LINE_RATIO)


def _load_photo(photo_url: str) -> Image.Image:
    if photo_url.startswith("http://") or photo_url.startswith("https://"):
        r = requests.get(photo_url, timeout=30)
        r.raise_for_status()
        return Image.open(io.BytesIO(r.content))
    return Image.open(photo_url)


def render_quote_card(
    photo_url: str,
    quote: str,
    *,
    overlay_url: str | None = None,
    pan_y: float = 0.4,
    zoom: float = 1.0,
    box=DEFAULT_BOX,
    color=DEFAULT_COLOR,
    max_size: int = 60,
    min_size: int = 24,
    align: str = "left",
) -> bytes:
    """Render the card and return PNG bytes. ``overlay_url`` selects a specific
    overlay (else the bundled default brand overlay)."""
    photo = _cover_fit(_load_photo(photo_url), CARD_W, CARD_H, pan_y, zoom)
    card = photo.convert("RGBA")
    overlay = (
        _load_photo(overlay_url) if overlay_url else Image.open(OVERLAY_PATH)
    ).convert("RGBA")
    if overlay.size != (CARD_W, CARD_H):
        overlay = overlay.resize((CARD_W, CARD_H), Image.LANCZOS)
    card.alpha_composite(overlay)

    draw = ImageDraw.Draw(card)
    font, lines, line_h = _fit(draw, quote.strip(), box, max_size, min_size)
    left, top, right, _bottom = box
    fill = (*tuple(color), 255)
    y = top
    for ln in lines:
        if align == "center":
            x = left + (right - left - draw.textlength(ln, font=font)) / 2
        else:
            x = left
        draw.text((x, y), ln, font=font, fill=fill)
        y += line_h

    out = io.BytesIO()
    card.convert("RGB").save(out, format="PNG")
    log("QUOTE", f"rendered card ({len(lines)} lines @ {font.size}px)")
    return out.getvalue()
