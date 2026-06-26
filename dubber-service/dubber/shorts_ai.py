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
from concurrent.futures import ThreadPoolExecutor

import requests

from .utils import log

# Defaults match the user's content; overridable per job via settings.
DEFAULT_CLIP_MODEL = "moonshotai/kimi-k2.6"
DEFAULT_TITLE_MODEL = "meta/llama-3.3-70b-instruct"
DEFAULT_SPEAKER = (
    "The Supreme Pontiff of Hinduism Bhagavan Sri Nithyananda Paramashivam"
)
DEFAULT_CHANNEL = "SPH Nithyananda"
# Exactly the two fixed tags the user wants — no extra/auto hashtags, no @mention.
DEFAULT_BASE_TAGS = "#nithyananda #kailasa"
DEFAULT_MENTION = ""


def _clean_gist(gist: str, speaker: str) -> str:
    """Make the AI gist read cleanly as the object of '<speaker> reveals ___':
    drop any restatement of the speaker's name + verb (the cause of "… reveals
    Bhagavan … reveals …"), drop @handles, and tidy the casing."""
    g = re.sub(r"@\w+", "", gist or "").strip()
    names = (
        r"(?:the\s+supreme\s+pontiff(?:\s+of\s+hinduism)?,?\s*)?"
        r"(?:bhagavan\s+)?(?:sri\s+)?(?:sph\s+)?nithyananda(?:\s+paramashivam)?"
        r"|paramashivam|bhagavan|sph|he|she|it|this"
    )
    verbs = (
        r"reveals?|explains?|teaches?|describes?|shares?|discusses?|shows?"
        r"|unveils?|expounds?|reflects?(?:\s+on)?|talks?\s+about|speaks?\s+about"
    )
    # Leading "<name> <verb>" or a bare leading "<verb>".
    g = re.sub(rf"^\s*(?:{names})\s+(?:{verbs})\s+", "", g, flags=re.IGNORECASE)
    g = re.sub(rf"^\s*(?:{verbs})\s+", "", g, flags=re.IGNORECASE)
    # Mid-text restatements: "… tapestry. He explains the role …" → "… tapestry, and the role …"
    g = re.sub(
        rf"[.;,]\s+(?:{names})\s+(?:{verbs})\s+", ", and ", g, flags=re.IGNORECASE
    )
    g = re.sub(r"\s{2,}", " ", g).strip().rstrip(".")
    if g and g[:1].isupper() and not g.split(" ", 1)[0].isupper():
        g = g[0].lower() + g[1:]  # flow after "reveals"
    return g

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
# Seconds added after the snapped end so the last word fully plays.
_TAIL_PAD = 0.3
# Terminal punctuation that marks a real sentence end.
_TERMINAL = (".", "?", "!", "…", "।")


def build_sentences(words: list[dict]) -> list[dict]:
    """Re-segment word-level data into proper sentences by terminal punctuation
    (. ? !) and hard pauses (>0.6s). Gives sentence-accurate clip boundaries so
    clips don't start/end mid-sentence. Returns ``[{start, end, text}]``."""
    if not words:
        return []
    sentences, buf = [], []
    for i, w in enumerate(words):
        buf.append(w)
        token = (w.get("word") or "").strip()
        terminal = token.endswith(_TERMINAL)
        gap = (words[i + 1]["start"] - w["end"]) if i + 1 < len(words) else 999
        if terminal or (gap > 0.6 and len(buf) >= 4) or i == len(words) - 1:
            sentences.append({
                "start": float(buf[0]["start"]),
                "end": float(buf[-1]["end"]),
                "text": " ".join(x["word"] for x in buf).strip(),
            })
            buf = []
    return sentences


def segments_to_transcript(segments: list[dict]) -> str:
    """Format segments/sentences as ``[start→end] text`` lines for the model."""
    lines = []
    for s in segments:
        a, b = round(float(s.get("start", 0)), 1), round(float(s.get("end", 0)), 1)
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
    """(start, end, first_word, last_word, hard_end) tuples used to snap clips.

    Float seconds (word-level precision) — NOT rounded to whole seconds — so a
    cut lands exactly on the sentence edge instead of up to a second early (which
    clipped the final word). A small tail pad is added at snap time.

    ``hard_end`` is True when the boundary text ends with terminal punctuation
    (. ? ! …) — a TRUE sentence end — and False when it was split only by a
    mid-sentence pause. The end snapper prefers hard ends so a reel never stops
    on a fragment."""
    out = []
    for s in segments:
        text = (s.get("text") or "").strip()
        words = text.split()
        if not words:
            continue
        out.append((round(float(s.get("start", 0)), 2),
                    round(float(s.get("end", 0)), 2),
                    words[0].lower().strip(".,!?;:"),
                    words[-1].lower().strip(".,!?;:"),
                    text.endswith(_TERMINAL)))
    return out


def _snap(clips, bounds, min_sec, max_sec):
    """Snap each clip to complete-sentence boundaries.

    Rules:
    - The clip ALWAYS ends on a complete sentence (never mid-sentence).
    - ``max_sec`` is a HARD ceiling (social platforms reject longer): the end is
      chosen so duration never exceeds it. If completing the model's sentence
      would overflow ``max_sec``, the START is slid later so a whole thought
      still fits under the ceiling, instead of cutting the sentence short.
    - ``min_sec`` is honoured by extending the end to a later complete sentence
      when possible; clips that still can't reach it are flagged ``_under_min``
      for the caller to drop (hard floor).
    """
    if not bounds:
        return clips
    good_starts = sorted({bs for bs, _be, fw, _lw, _h in bounds if fw not in BAD_START})
    # HARD ends = real sentence ends (terminal punctuation). SOFT ends = pause
    # splits, used only when no hard end fits. Preferring hard ends is what stops
    # reels from ending on a fragment.
    hard_ends = sorted({be for _bs, be, _fw, _lw, h in bounds if h})
    soft_ends = sorted({be for _bs, be, _fw, lw, _h in bounds if lw not in BAD_END})
    if not good_starts or not (hard_ends or soft_ends):
        return clips

    def choose_end(cands, S, e0):
        """Pick a sentence end in (S, S+max]: closest to the model's intended end
        e0 so we neither cut the thought short nor pull in a sentence that
        belongs to the next reel, while honouring min when reachable."""
        within = [e for e in cands if e > S and e - S <= max_sec]
        if not within:
            return None
        meet_min = [e for e in within if e - S >= min_sec - 0.5]
        pool = meet_min or within
        # Complete the model's thought: the EARLIEST end at/after e0 (don't pull
        # extra). If none reaches e0 (the sentence overflows max), take the latest
        # complete end that still fits.
        after = [e for e in pool if e >= e0 - 0.5]
        return min(after) if after else max(pool)

    for c in clips:
        s0 = c.get("start_seconds", 0)
        e0 = c.get("end_seconds", 0)
        # Start: nearest strong sentence opener to the model's start.
        S = min(good_starts, key=lambda b: abs(b - s0))
        # End: prefer a TRUE sentence end; fall back to a soft pause-end; then to
        # sliding the start later so a complete sentence fits under max.
        E = choose_end(hard_ends, S, e0)
        if E is None:
            E = choose_end(soft_ends, S, e0)
        if E is None:
            ends = hard_ends or soft_ends
            for be in reversed(ends):
                if be <= s0:
                    continue
                fits = [bs for bs in good_starts if min_sec <= be - bs <= max_sec]
                if fits:
                    S, E = max(fits), be
                    break
            if E is None:
                cap = [be for be in ends if be > S and be - S <= max_sec]
                later = [be for be in ends if be > S]
                E = max(cap) if cap else (min(later) if later else S + min_sec)

        # Small tail pad so the final word fully plays (cut precision / breath),
        # without exceeding the ceiling beyond enforce_duration's tolerance.
        c["start_seconds"] = round(S, 2)
        c["end_seconds"] = round(E + _TAIL_PAD, 2)
        dur = c["end_seconds"] - c["start_seconds"]
        c["_under_min"] = dur < min_sec - 0.5
        c["_over_max"] = dur > max_sec + 0.5
    return clips


def enforce_duration(clips, min_sec, max_sec, on_log=print) -> list[dict]:
    """Hard floor + ceiling after snapping. ``min_sec`` is a hard floor (a reel
    shorter than the user asked for isn't useful) and ``max_sec`` a hard ceiling
    (platforms reject longer). Snapping already tried to repair to a complete
    thought within max, so this only drops what couldn't be salvaged."""
    keep = []
    for c in clips:
        dur = c.get("end_seconds", 0) - c.get("start_seconds", 0)
        if dur < min_sec - 0.5:
            on_log(f"drop clip {c.get('rank')}: {int(dur)}s < min {min_sec}s")
            continue
        if dur > max_sec + 0.5:
            on_log(f"drop clip {c.get('rank')}: {int(dur)}s > max {max_sec}s")
            continue
        keep.append(c)
    return keep


def _dedup(clips, min_gap=15):
    seen, out = set(), []
    for c in sorted(clips, key=lambda x: -x.get("viral_score", 0)):
        s = c.get("start_seconds", 0)
        if all(abs(s - u) > min_gap for u in seen):
            seen.add(s)
            out.append(c)
    return out


def find_clips(segments, *, num_clips, min_sec, max_sec, duration,
               api_url, api_key, model, settings, words=None, on_log=print) -> list[dict]:
    """Run the NIM clip-finder across batches and return ranked, snapped clips.

    Prefers sentence boundaries built from ``words`` (terminal punctuation +
    pauses) so clips begin and end on complete sentences; falls back to coarse
    utterance segments when word timings are unavailable."""
    ctx = {
        "speaker": settings.get("speaker", DEFAULT_SPEAKER),
        "channel": settings.get("channel", DEFAULT_CHANNEL),
        "video_title": settings.get("video_title", "source"),
        "duration": int(duration),
        "min_sec": min_sec,
        "max_sec": max_sec,
    }
    units = build_sentences(words) if words else segments
    transcript = segments_to_transcript(units)
    batches = _make_batches(transcript)
    bounds = _parse_boundaries(units)
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

    # Enforce duration BEFORE truncating, so dropping a too-short/long clip lets
    # the next valid candidate fill the slot instead of shrinking the count.
    clips = enforce_duration(_dedup(all_clips), min_sec, max_sec, on_log)[:num_clips]
    for i, c in enumerate(clips, 1):
        c["rank"] = i
    on_log(f"clip-find: {len(clips)} clip(s) from {len(all_clips)} raw")
    return clips


def _clip_text(clip, units) -> str:
    """The transcript text inside a clip's [start, end] window."""
    s = clip.get("start_seconds", 0)
    e = clip.get("end_seconds", 0)
    return " ".join(
        u["text"] for u in units if u["start"] >= s and u["end"] <= e
    ).strip()[:1200]


def _judge_prompt(text) -> str:
    return f"""You are a ruthless short-form video editor judging ONE candidate clip for a standalone social reel (spiritual teaching).
Transcript of the clip:
\"\"\"{text}\"\"\"

Return ONLY JSON, no markdown:
{{"standalone": true, "hook": 0, "complete": 0, "overall": 0}}

- standalone = false if the OPENING needs prior context (starts with and/but/so/this/that/he/she/it/they/then, or references something earlier that isn't explained here) OR if it ends mid-thought. Otherwise true.
- hook = how scroll-stopping the FIRST sentence is (0-100).
- complete = is it ONE whole self-contained teaching (0-100).
- overall = publish-worthiness (0-100)."""


def judge_clips(clips, units, *, api_url, api_key, model, num_keep,
                min_score=55, on_log=print) -> list[dict]:
    """Score each candidate clip on a rubric (standalone comprehension, hook,
    completeness) with a fast model, drop the ones that fail the standalone gate
    or score low, and keep the best ``num_keep``. Runs the judges in parallel."""
    def judge(c):
        text = _clip_text(c, units) or c.get("hook", "")
        verdict = {}
        try:
            raw = _call_nim_fast(api_url, api_key, model, _judge_prompt(text))
            raw = re.sub(r"^```json\s*|^```\s*|\s*```$", "", raw,
                         flags=re.MULTILINE).strip()
            try:
                verdict = json.loads(raw)
            except json.JSONDecodeError:
                m = re.search(r"\{[\s\S]*\}", raw)
                verdict = json.loads(m.group()) if m else {}
        except Exception as ex:  # noqa: BLE001
            on_log(f"judge clip {c.get('rank')} failed: {str(ex)[:80]}")
        c["judge_score"] = int(verdict.get("overall", c.get("viral_score") or 50))
        c["standalone"] = bool(verdict.get("standalone", True))
        return c

    with ThreadPoolExecutor(max_workers=4) as ex:
        judged = list(ex.map(judge, clips))

    passing = [c for c in judged if c["standalone"] and c["judge_score"] >= min_score]
    rest = [c for c in judged if not (c["standalone"] and c["judge_score"] >= min_score)]
    passing.sort(key=lambda c: -c["judge_score"])
    rest.sort(key=lambda c: -c["judge_score"])
    # Keep all that pass the gate; only backfill from the rest if we'd otherwise
    # return too few (never return fewer clips just because the judge was strict).
    final = (passing + rest)[:num_keep]
    for i, c in enumerate(final, 1):
        c["rank"] = i
    on_log(f"judge: {len(passing)}/{len(judged)} passed gate, kept {len(final)}")
    return final


def _title_prompt(clip, clip_text, ctx) -> str:
    return f"""You are a YouTube Shorts title/description expert for {ctx['speaker']}'s teachings.

Clip #{clip.get('rank')}: "{clip.get('title', '')}"
Core teaching: {clip.get('core_teaching', '')}
Hook: {clip.get('hook', '')}
Closing line: {clip.get('closing_line', '')}
Transcript excerpt: {clip_text}

Return ONLY valid JSON:
{{"youtube_title":"...","gist":"..."}}
Rules:
- youtube_title: max 60 chars, punchy, captures the core teaching, no clickbait,
  no hashtags, no "@" handles, do NOT include the speaker's name or titles.
- gist: completes the phrase "{ctx['speaker']} reveals ___" — write ONLY the
  substance (1-2 ideas, specific to THIS clip). Do NOT repeat the speaker's name
  or titles, do NOT start with a verb like "reveals/explains", no "@" handles,
  no hashtags. Example: "how consciousness becomes the universe through the
  analogy of a thread and tapestry, and the role of pure sound and mantra"."""


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
                break
            except Exception as exc:  # noqa: BLE001
                on_log(f"title clip {c.get('rank')} attempt {attempt + 1}: {str(exc)[:120]}")
                if attempt < 2:
                    time.sleep(5 * (attempt + 1))

        gist = _clean_gist(gist, ctx["speaker"])
        # Title shouldn't carry the name/handles/hashtags either.
        title = re.sub(r"\s*[#@]\w+", "", title).strip()
        desc = f"{ctx['speaker']} reveals {gist}.".replace(" .", ".")
        tail = " ".join(t for t in (base_tags, mention) if t).strip()
        c["youtube_title"] = title
        c["youtube_description"] = f"{desc} {tail}".strip()
        # Exactly the two fixed tags (no #), for the clip's stored hashtags.
        c["hashtags"] = [t.strip("#") for t in base_tags.split()]
