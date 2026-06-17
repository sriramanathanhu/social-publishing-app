"""
AI clip-finding + title/description generation for the Shorts factory, ported
from the user's Colab pipeline. Uses an OpenAI-compatible NVIDIA NIM endpoint:
  - clip-finding: a large model (Kimi) in INSTANT mode (thinking disabled) with
    SSE streaming + batching + retries — the workarounds that keep the gateway
    from killing long generations.
  - titles/descriptions: a fast model (Llama-3.3-70B), non-streaming.

Keys arrive per-job from the PeerPost backend; nothing is persisted here.
"""

from __future__ import annotations

import json
import re
import time

import requests

from .utils import log

# Defaults match the user's content; overridable per job via settings.
DEFAULT_CLIP_MODEL = "moonshotai/kimi-k2.6"
DEFAULT_TITLE_MODEL = "meta/llama-3.3-70b-instruct"
DEFAULT_SPEAKER = (
    "The Supreme Pontiff of Hinduism Bhagavan Sri Nithyananda Paramashivam"
)
DEFAULT_CHANNEL = "SPH Nithyananda"
DEFAULT_BASE_TAGS = "#kailasa #nithyananda"
DEFAULT_MENTION = "@srinithyananda"

BATCH_CHARS = 6000
OVERLAP_CHARS = 800
RETRY_DELAYS = [15, 30, 60, 120, 240]
MAX_ATTEMPTS = 5

BAD_START = {
    "and", "but", "so", "because", "which", "that", "he", "she", "it", "they",
    "this", "those", "also", "then", "now", "here", "where", "when", "who",
    "like", "well", "oh", "ah", "um", "uh", "yeah", "yes", "no", "okay", "ok",
    "alright",
}
BAD_END = {
    "and", "but", "so", "because", "then", "also", "now", "here", "like",
    "going", "trying", "when", "where", "who", "the", "a", "an", "of", "to",
    "in",
}


def segments_to_transcript(segments: list[dict]) -> str:
    """Format segments as ``[start→end] text`` lines for the clip-finder."""
    lines = []
    for s in segments:
        a, b = int(s.get("start", 0)), int(s.get("end", 0)) + 1
        text = (s.get("text") or "").strip()
        if text:
            lines.append(f"[{a}→{b}] {text}")
    return "\n".join(lines)


def _make_batches(text: str, batch_size=BATCH_CHARS, overlap=OVERLAP_CHARS):
    lines = text.splitlines(keepends=True)
    batches, cur, cur_len = [], [], 0
    for line in lines:
        cur.append(line)
        cur_len += len(line)
        if cur_len >= batch_size:
            batches.append("".join(cur))
            tail = "".join(cur)[-overlap:]
            nl = tail.find("\n")
            cur = [tail[nl + 1:]] if nl >= 0 else [tail]
            cur_len = sum(len(x) for x in cur)
    if cur:
        batches.append("".join(cur))
    return batches


def _call_nim_streaming(api_url, api_key, model, prompt, system=None) -> str:
    """Streaming NIM call with thinking disabled (instant mode). Aborts if no
    content token arrives for 60s so a stalled gateway surfaces as an error."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "Connection": "keep-alive",
        "Authorization": f"Bearer {api_key}",
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system or
                "You are a content analysis expert. Return only valid JSON. "
                "No markdown fences. No explanation."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 16384,
        "temperature": 1.0,
        "top_p": 1.0,
        "stream": True,
        "chat_template_kwargs": {"thinking": False},
    }
    full, last = "", time.time()
    IDLE_LIMIT = 60
    with requests.post(api_url, json=payload, headers=headers,
                       timeout=(30, 600), stream=True) as resp:
        resp.raise_for_status()
        for raw in resp.iter_lines():
            if time.time() - last > IDLE_LIMIT:
                raise TimeoutError(
                    f"No token for {IDLE_LIMIT}s — server not responding "
                    f"({len(full)} chars so far)."
                )
            if not raw:
                continue
            line = raw.decode("utf-8") if isinstance(raw, bytes) else raw
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            token = ((chunk.get("choices") or [{}])[0].get("delta") or {}).get(
                "content"
            ) or ""
            if token:
                full += token
                last = time.time()
    return full.strip()


def _call_nim_fast(api_url, api_key, model, prompt, system=None) -> str:
    """Non-streaming NIM call for short outputs (titles/descriptions)."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system or
                "You are a YouTube Shorts expert. Return only valid JSON. "
                "No markdown. No explanation."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.7,
        "max_tokens": 512,
        "stream": False,
    }
    r = requests.post(api_url, json=payload, headers=headers, timeout=60)
    r.raise_for_status()
    content = (
        ((r.json().get("choices") or [{}])[0].get("message") or {}).get("content")
        or ""
    ).strip()
    if not content:
        raise ValueError("Empty content from fast model")
    return content


def _build_batch_prompt(batch, idx, total, clips_needed, ctx) -> str:
    return f"""You are a world-class short-form video editor for content by {ctx['speaker']}.
Find up to {clips_needed} clips. Each clip must convey ONE complete, powerful, standalone teaching.

Video: "{ctx['video_title']}" by {ctx['channel']} ({ctx['duration']}s long)
Batch {idx + 1}/{total} | Target: {ctx['min_sec']}–{ctx['max_sec']} seconds per clip

Each transcript line: [START→END] sentence text
- start_seconds = START number (before →) of your first sentence
- end_seconds = END number (after →) of your last sentence
- NEVER use timestamps that fall inside a sentence

3-PART STRUCTURE:
HOOK (first sentence): bold truth, stands alone with ZERO prior context.
MIDDLE: builds the teaching logically.
CONCLUSION (last sentence): ends with . ? or !

RULES: duration {ctx['min_sec']}–{ctx['max_sec']}s, fully self-contained, no mid-sentence cuts, no greetings.

OUTPUT raw JSON only:
{{"clips":[{{"rank":1,"start_seconds":42,"end_seconds":98,"title":"short title","hook":"first sentence verbatim","closing_line":"last sentence verbatim","core_teaching":"one-sentence summary","tags":["tag"],"viral_score":95,"caption_text":"under 10 words"}}]}}

TRANSCRIPT:
{batch}"""


def _parse_boundaries(segments):
    """(start, end, first_word, last_word) tuples used to snap clip edges."""
    out = []
    for s in segments:
        words = (s.get("text") or "").strip().split()
        if not words:
            continue
        out.append((int(s.get("start", 0)), int(s.get("end", 0)) + 1,
                    words[0].lower().strip(".,!?;:"),
                    words[-1].lower().strip(".,!?;:")))
    return out


def _snap(clips, bounds, min_sec, max_sec):
    if not bounds:
        return clips
    for c in clips:
        s = c.get("start_seconds", 0)
        e = c.get("end_seconds", 0)
        for bs, _be, fw, _lw in sorted(bounds, key=lambda x: abs(x[0] - s)):
            if fw not in BAD_START:
                c["start_seconds"] = bs
                break
        for _bs, be, _fw, lw in sorted(bounds, key=lambda x: abs(x[1] - e)):
            if lw not in BAD_END:
                c["end_seconds"] = be
                break
        dur = c["end_seconds"] - c["start_seconds"]
        if dur < min_sec or dur > max_sec:
            c["_warn"] = f"duration {dur}s outside [{min_sec},{max_sec}]"
    return clips


def _dedup(clips, min_gap=15):
    seen, out = set(), []
    for c in sorted(clips, key=lambda x: -x.get("viral_score", 0)):
        s = c.get("start_seconds", 0)
        if all(abs(s - u) > min_gap for u in seen):
            seen.add(s)
            out.append(c)
    return out


def find_clips(segments, *, num_clips, min_sec, max_sec, duration,
               api_url, api_key, model, settings, on_log=print) -> list[dict]:
    """Run the NIM clip-finder across batches and return ranked, snapped clips."""
    ctx = {
        "speaker": settings.get("speaker", DEFAULT_SPEAKER),
        "channel": settings.get("channel", DEFAULT_CHANNEL),
        "video_title": settings.get("video_title", "source"),
        "duration": int(duration),
        "min_sec": min_sec,
        "max_sec": max_sec,
    }
    transcript = segments_to_transcript(segments)
    batches = _make_batches(transcript)
    bounds = _parse_boundaries(segments)
    per_batch = max(3, (num_clips // max(len(batches), 1)) + 2)
    on_log(f"clip-find: {len(batches)} batch(es), {len(bounds)} boundaries")

    all_clips = []
    for bi, btext in enumerate(batches):
        prompt = _build_batch_prompt(btext, bi, len(batches), per_batch, ctx)
        for attempt in range(MAX_ATTEMPTS):
            try:
                raw = _call_nim_streaming(api_url, api_key, model, prompt)
                raw = re.sub(r"^```json\s*|^```\s*|\s*```$", "", raw,
                             flags=re.MULTILINE).strip()
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    m = re.search(r'\{[\s\S]*"clips"\s*:\s*\[[\s\S]*\]\s*\}', raw)
                    if not m:
                        raise ValueError(f"no JSON: {raw[:200]}")
                    data = json.loads(m.group())
                clips = data.get("clips", [])
                if clips:
                    all_clips.extend(_snap(clips, bounds, min_sec, max_sec))
                    on_log(f"batch {bi + 1}/{len(batches)}: {len(clips)} clip(s)")
                    break
                raise ValueError("empty clips")
            except Exception as exc:  # noqa: BLE001
                on_log(f"batch {bi + 1} attempt {attempt + 1} failed: {str(exc)[:160]}")
                if attempt < MAX_ATTEMPTS - 1:
                    time.sleep(RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)])

    clips = _dedup(all_clips)[:num_clips]
    for i, c in enumerate(clips, 1):
        c["rank"] = i
    on_log(f"clip-find: {len(clips)} clip(s) from {len(all_clips)} raw")
    return clips


def _title_prompt(clip, clip_text, ctx) -> str:
    return f"""You are a YouTube Shorts title/description expert for {ctx['speaker']}'s teachings.

Clip #{clip.get('rank')}: "{clip.get('title', '')}"
Core teaching: {clip.get('core_teaching', '')}
Hook: {clip.get('hook', '')}
Closing line: {clip.get('closing_line', '')}
Transcript excerpt: {clip_text}

Return ONLY valid JSON:
{{"youtube_title":"...","gist":"...","relevant_hashtags":["tag1","tag2"]}}
Rules:
- youtube_title: max 60 chars, punchy, captures the core teaching, no clickbait
- gist: 1-2 sentences, specific to THIS clip, what exactly is revealed/taught
- relevant_hashtags: exactly 2 strings (no #) relevant to this clip's topic"""


def generate_titles(clips, segments, *, api_url, api_key, model, settings,
                    on_log=print) -> None:
    """Enrich each clip in-place with youtube_title / youtube_description /
    hashtags via the fast NIM model, with the user's fixed description format."""
    ctx = {"speaker": settings.get("speaker", DEFAULT_SPEAKER)}
    base_tags = settings.get("base_tags", DEFAULT_BASE_TAGS)
    mention = settings.get("mention", DEFAULT_MENTION)

    for c in clips:
        text = " ".join(
            s["text"] for s in segments
            if s["start"] >= c.get("start_seconds", 0)
            and s["end"] <= c.get("end_seconds", 0)
        )[:500]
        title = c.get("title", f"Clip {c.get('rank')}")
        gist = c.get("core_teaching", "")
        tags = []
        for attempt in range(3):
            try:
                raw = _call_nim_fast(api_url, api_key, model,
                                     _title_prompt(c, text or c.get("caption_text", ""), ctx))
                raw = re.sub(r"^```json\s*|^```\s*|\s*```$", "", raw,
                             flags=re.MULTILINE).strip()
                try:
                    td = json.loads(raw)
                except json.JSONDecodeError:
                    m = re.search(r'\{[\s\S]*"youtube_title"[\s\S]*\}', raw)
                    if not m:
                        raise ValueError("no JSON")
                    td = json.loads(m.group())
                title = td.get("youtube_title", title)
                gist = (td.get("gist") or gist or "").strip().rstrip(".")
                tags = [t.strip("#").strip() for t in td.get("relevant_hashtags", [])][:2]
                break
            except Exception as exc:  # noqa: BLE001
                on_log(f"title clip {c.get('rank')} attempt {attempt + 1}: {str(exc)[:120]}")
                if attempt < 2:
                    time.sleep(5 * (attempt + 1))

        while len(tags) < 2:
            tags.append("spirituality" if not tags else "consciousness")
        hashtags = f"#{tags[0]} #{tags[1]}"
        c["youtube_title"] = title
        c["youtube_description"] = (
            f"{ctx['speaker']} reveals {gist}. {base_tags} {hashtags} {mention}"
        )
        c["hashtags"] = tags
