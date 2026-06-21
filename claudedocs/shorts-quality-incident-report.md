# Shorts/Dub Quality Report — multi-user session

_Date: 2026-06-20 · Scope: `dubber-service` Shorts pipeline · Trigger: 5 concurrent users generating reels + dubs_

## Executive summary

Three classes of defect were reported: (1) auto-framing engaging late / drifting,
(2) wrong number of reels and wrong durations, (3) reels ending abruptly mid-sentence.

The single biggest amplifier is **no concurrency control**. Every Shorts job is started
as a bare daemon thread (`app/main.py:318`) with **no global queue or semaphore**. With 5
users at once on an **8-core / 15 GB** box, each job spawns up to 4 parallel `ffmpeg`
renders (`shorts_pipeline.py:41`) plus face-detection frame grabs plus NIM/Gemini/Deepgram
calls. That is ~20+ concurrent ffmpeg processes and a burst of API calls competing for the
same CPU, RAM, and rate-limited quotas. Under that pressure, renders fail and get silently
dropped, API batches exhaust their retries, and fallbacks kick in — which is exactly what
produces "1 short clip instead of 10" and inconsistent framing.

The other two issues are real pipeline-logic gaps that exist even at low load, but they
become frequent under contention.

---

## Issue 1 — Auto-framing applies late / drifts to the end

**Observed:** correct framing only kicks in 10–15 s into a clip, and framing also looks off
near the end.

**Root causes:**

1. **The crop is STATIC for the whole clip.** `auto_crop_filter` calls `face_center_x`,
   which samples **5 frames** across `[start, end]` and takes the **median** face X, then
   bakes one fixed `crop=...` into the render (`shorts_reframe.py:35-94`). If the speaker
   moves, or the clip contains a shot change (e.g. a slide for the first 10–15 s, then a
   talking head), one fixed crop cannot be right for the whole clip — the portion where the
   face is elsewhere looks mis-framed. This matches "right only after 10–15 s" and "off at
   the end" precisely: those are the spans where the real subject is not where the median
   put the crop.
2. **Weak detector, sparse sampling.** Haar `frontalface_default` (`shorts_reframe.py:22`)
   misses turned/profile/partially-occluded faces; only 5 samples at `minSize=(80,80)`. A
   missed detection at the head/tail biases the median toward the middle of the clip.
3. **No tracking, no smoothing, no per-segment reframing.** There is no temporal model — it
   is one number for the entire clip.
4. **Under load it silently falls back to a center crop** (`face_center_x` returns `None`
   when the sampling ffmpeg calls are starved/time out → `auto_crop_filter` returns `None` →
   caller uses the fixed center crop, `shorts_pipeline.py:288-292`). So in a busy batch some
   clips get face-aware crop and some get center crop — inconsistent framing across the set.

**Fixes (in priority order):**

- **Reframe per sub-window, not per clip.** Split each clip into N windows (e.g. every 3–5 s),
  detect the face per window, and build a **piecewise / time-stepped crop** (ffmpeg
  `crop=...:x='if(...)'` expressions, or a sent-to-ffmpeg keyframed `x(t)`), with a
  smoothing/hysteresis filter so the frame doesn't jitter. This directly fixes "late" and
  "drift at the end."
- **Upgrade detection.** Add the DNN face detector (OpenCV `cv2.dnn` ResNet SSD) or MediaPipe;
  detect on more frames (e.g. 1 fps), keep the largest/most-central face, and **interpolate**
  X between samples.
- **Confidence floor + graceful center.** If detection confidence/coverage is low for a
  window, hold the last good position rather than snapping to center.
- **Make detection robust to load** (see cross-cutting): isolate the CPU budget so frame
  grabs don't starve.

---

## Issue 2 — Wrong number of reels; wrong durations (sometimes 1 clip, 12 s / 20 s)

**Observed:** fewer reels than the requested `num_clips`; durations far from the requested
range, e.g. a single 12 s or 20 s clip.

**Root causes:**

1. **No concurrency limit → render failures are silently dropped.** Each job runs up to
   `_MAX_WORKERS=4` parallel ffmpeg renders (`shorts_pipeline.py:41, 323-330`). With 5 jobs
   that is ~20 ffmpeg processes on 8 cores / 15 GB. ffmpeg that is OOM-killed or stalls makes
   `_render_single_pass` return `False` → `render_one` returns `None` → that clip is dropped
   (`shorts_pipeline.py:299-302, 328-330`). The job still "succeeds" with whatever survived,
   so the user gets fewer reels than requested. If only one survives, they get one.
2. **`_dedup(min_gap=15)` can collapse the set to a handful** (`shorts_ai.py:257-264`). Any
   clip whose start is within 15 s of an already-kept clip is discarded. If the model picks
   clustered moments (common on a short or repetitive source), dedup can legitimately reduce
   10 candidates to 1–2. This is a top suspect for "only one reel."
3. **API rate-limits under concurrent load → fewer/zero candidates.** All jobs hit the same
   NVIDIA NIM endpoint and the **shared Gemini free tier (250k tokens/min)** at once. Batches
   exhaust `MAX_ATTEMPTS=5` retries (`shorts_ai.py:35-36, 290-313`) and return fewer clips;
   Gemini quota errors force the NIM fallback, which may also be throttled → even-clips
   fallback or a near-empty set.
4. **Duration limits are advisory, not enforced.** `_snap` only attaches a `_warn` string
   when a clip falls outside `[min_sec, max_sec]` — it never rejects or re-derives it
   (`shorts_ai.py:251-253`). A snap that lands short (e.g. the only sentence boundary nearby
   is 12 s away) is shipped as a 12 s clip even when `min_sec` is 90.
5. **Speed factor shrinks the final duration.** Output duration is `(end-start)/speed`
   (`shorts_pipeline.py:315`, retiming at `:164-166`). With `speed=1.4`, a 28 s selection
   becomes a 20 s reel. Speed compounds any already-short selection.
6. **Even-clips / short-source fallback returns very few.** When there is no transcript or
   the selectors fail, `_even_clips` returns `num_clips` evenly spaced — but if the source is
   short it returns a **single** clip of `(min+max)/2` length (`shorts_pipeline.py:_even_clips`).
   A short upload + this path yields one short clip.

**Fixes:**

- **Add a global job queue / concurrency cap** (see cross-cutting) — the highest-leverage fix
  for the count problem.
- **Stop silently dropping clips.** Count requested vs rendered; **retry failed renders**
  (serially, lower preset) before giving up, and **surface the shortfall** to the UI
  ("requested 10, produced 7 — 3 renders failed").
- **Enforce duration as a hard gate.** After `_snap`, **discard** clips outside
  `[min_sec, max_sec]` (instead of `_warn`), and if that leaves fewer than `num_clips`, ask
  the selector for more / widen the window. Never ship a 12 s clip when min is 90.
- **Make `min_gap` proportional** (e.g. `min(15, source_duration / (num_clips*2))`) or
  dedup by **overlap of [start,end] windows** rather than start-only, so clustered-but-distinct
  clips aren't all dropped.
- **Account for `speed`** when validating duration: validate the *output* length against the
  user's intended reel length, or validate the source selection against `min/max × speed`.
- **Per-user / per-key rate-limit backoff** so concurrent jobs queue against the shared
  Gemini/NIM quota instead of all failing.

---

## Issue 3 — Reels end abruptly, mid-sentence / meaningless

**Observed:** clips cut in the middle of a sentence or end without a complete thought.

**Root causes:**

1. **End-snapping falls back to an earlier boundary when completing the sentence would exceed
   `max_sec`.** In `_snap` (`shorts_ai.py:239-250`), the preferred path picks the first
   sentence-END at/after the model's cut **only if** `(end - start) <= max_sec`. If the
   sentence that would complete the thought pushes past `max_sec`, it falls back to the
   **nearest** end boundary by absolute distance — which is often an **earlier** one → the
   final sentence is truncated. So tight `max_sec` + a long closing sentence = mid-sentence cut.
2. **Integer-second boundaries.** Transcript lines and boundaries truncate to whole seconds
   (`segments_to_transcript` `int(start)`, `_parse_boundaries` `int(start)`,
   `shorts_ai.py:77, 219`). Starts truncate *down* and cuts land on integer seconds, so the
   tail of the last word can be clipped even when the boundary "looks" complete.
3. **Sentence segmentation degrades when punctuation is sparse or non-English.**
   `build_sentences` relies on terminal punctuation (`. ? ! … |`) and >0.6 s pauses
   (`shorts_ai.py:51-70`). If Deepgram's `smart_format` under-punctuates (common for some
   languages/accents), "sentences" become huge or arbitrary, boundaries get sparse, and snap
   has nothing good to land on → abrupt cuts.
4. **Gemini path only snaps when `words` exist.** `bounds = ... if words else []`
   (`shorts_gemini.py:124-126`). Gemini returns integer second guesses; with no/poor word
   timings the picks are used **unsnapped**, so cuts land wherever the model guessed.
5. **No-speech / even-clips fallback is not sentence-aware by design** — for music that's
   fine, but if it is triggered on spoken content (because transcription failed under load),
   every cut is arbitrary.

**Fixes:**

- **Never truncate the closing sentence.** When the completing sentence would exceed
  `max_sec`, prefer **moving the start later** (drop the weakest leading sentence) to keep the
  full closing sentence within budget, rather than cutting it short. Only as a last resort end
  on an earlier *complete* sentence — never mid-sentence.
- **Snap on float boundaries**, not integer seconds; add a small tail pad (e.g. +0.3 s) so the
  last word fully plays.
- **Add a completeness guard:** if the snapped end word is in `BAD_END` or the clip has no
  terminal punctuation, reject/repair the clip.
- **Always snap the Gemini picks**, even with weak words, by falling back to Deepgram utterance
  segments (not just word-built sentences) for boundaries.
- **Improve transcript quality:** request punctuation + the right language explicitly; when
  punctuation density is low, segment by pause only with a higher threshold.

---

## Cross-cutting root cause — no concurrency / resource control

**Evidence:** `app/main.py:318` starts each Shorts job as `threading.Thread(...).start()` with
no pool, queue, or limit; `shorts_pipeline.py:41-42` sizes the per-job ffmpeg pool to the
**whole** box (`cpu_count()//2`, capped 4) assuming it is the only job; host is 8 cores /
15 GB. Five jobs therefore each assume they own the machine.

**Consequences:** CPU/RAM oversubscription → ffmpeg OOM/timeouts → dropped clips (Issue 2);
starved face-detection frame grabs → center-crop fallback → inconsistent framing (Issue 1);
piled-up API calls → rate-limit failures → weak/empty selections → abrupt or missing clips
(Issues 2 & 3).

**Fix — add an explicit concurrency tier:**

- A **global job queue** (e.g. `concurrent.futures.ThreadPoolExecutor(max_workers=2)` or an
  `asyncio`/RQ/Celery queue) so at most N Shorts jobs run at once; the rest queue with a
  visible "queued" status.
- **Size the per-job render pool against a shared budget**, not the whole box: e.g.
  `total_ffmpeg_slots = cores - 1`, divided across active jobs (a global ffmpeg semaphore).
- **Cap ffmpeg memory/threads** and add render **retry with backoff**.
- **Centralize API rate-limiting** (token-bucket per provider/key) so concurrent jobs share
  the Gemini/NIM quota gracefully instead of colliding.
- **Surface queue position + per-clip success/failure** in the UI so users see "3 of 10
  renders failed, retrying" rather than a silently short result.

---

## Prioritized fix plan

| # | Fix | Addresses | Effort | Impact |
|---|-----|-----------|--------|--------|
| 1 | Global job queue + shared ffmpeg/CPU budget | 1, 2, 3 (load) | M | High |
| 2 | Hard-enforce `[min_sec,max_sec]`; account for `speed`; report shortfalls | 2 | S | High |
| 3 | Retry failed renders; stop silently dropping clips; show counts | 2 | S | High |
| 4 | Fix end-snap to never truncate the closing sentence; float boundaries + tail pad | 3 | S–M | High |
| 5 | Per-sub-window (time-stepped) auto-crop with smoothing | 1 | M–L | High |
| 6 | Upgrade face detector (DNN/MediaPipe) + denser sampling | 1 | M | Med |
| 7 | Proportional / overlap-based `min_gap` dedup | 2 (only-one-reel) | S | Med |
| 8 | Provider rate-limit backoff (token bucket) | 2, 3 | M | Med |

**Quick wins to ship first:** #2, #3, #4, #7 are small, localized changes in `shorts_ai.py`
and `shorts_pipeline.py` and remove most of the "wrong count / wrong duration / abrupt"
reports even before the larger concurrency work (#1) and reframing work (#5/#6).
