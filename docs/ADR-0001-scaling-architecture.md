# ADR-0001: Scaling architecture — harden the stack, defer the rewrites

- **Status:** Accepted
- **Date:** 2026-06-28
- **Drivers:** scale PeerPost to thousands of users with least time-to-revenue and regression risk.

## Context

Today: a **Next.js 15 / TypeScript** app (frontend + API routes) + a **Python sidecar** for the video/AI pipeline (ffmpeg + OpenCV face-tracking + Deepgram/Gemini/edge-TTS). Single bare `pnpm`/`uvicorn` processes; **minute-cron** dispatch; **CPU** encoding.

Observed bottlenecks (none are language-related):
1. **Stateful in-memory sidecar** → jobs lost on restart (orphan bug).
2. **CPU encoding + redundant re-encode passes** (a Shorts clip is encoded up to 3×).
3. **Single process, no HA**, cron dispatch latency up to 60s.
4. **Provider rate limits** (publishing caps, credits).

Benchmark (8-core, 4-min 1080p): Go vs Python for ffmpeg work is **identical** (18.3 vs 18.8s); stream-copy is **~90×** faster than re-encode but only keyframe-accurate. **The host language is never the bottleneck — the I/O and the encode strategy are.**

## Decision — ADOPT
1. **Service/container split:** `db` · `frontend` · `api` · `video-worker`.
2. **Postgres job queue** (no Redis): durable table + `LISTEN/NOTIFY` wake + `SELECT … FOR UPDATE SKIP LOCKED` claim.
3. **Heartbeat + reaper:** workers heartbeat; reaper requeues stale `running` jobs (fixes orphan bug permanently).
4. **ffmpeg:** stream-copy for trims/joins/audio-swap; single-pass **NVENC** for transforms (reframe/caption/speed).
5. **GPU worker (NVENC)** for the encode path.
6. **Throttled progress** to the row (ticker, `ffmpeg -progress`); progress ephemeral, terminal state durable; SSE for live UI; NOTIFY only on state transitions.
7. **Per-tenant quotas + metering** for plan limits.
8. **New video-worker MAY be Go** (greenfield, low-risk); existing app stays TS/Python.

## Decision — DEFER
1. **Rewrite the Next.js/TS API to Go** — I/O-bound; ~months of work, regression risk, no user-perceived speedup.
2. **Frontend → Bun/TanStack** — patched CVE, marginal user-perceived gain, less mature.
3. **Remove Python entirely** — OpenCV face-tracking (YuNet + SFace) has no clean Go equivalent.
4. **Parallel full rewrites** — no stable API contract yet.

## Consequences
- **+** Every observed bottleneck addressed in ~4–6 weeks while still shipping features.
- **+** Horizontally scalable: add `video-worker` replicas behind the queue.
- **−** Keeps two languages (TS + Python) — each best-in-class for its half.
- **−** PG-as-queue ceiling is below Redis/Kafka at extreme scale — sufficient for our volume; revisit if it saturates.

## Revisit triggers
Team becomes Go-primary · PG-as-queue measurably saturates · profiling shows API *runtime* (not downstream I/O) is the latency bottleneck · a Go-native CV path matches OpenCV.
