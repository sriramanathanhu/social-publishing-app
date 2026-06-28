# PeerPost — Scaling Roadmap (to 400 users and beyond)

Goal: serve **~400 active users reliably** today, and **add capacity by adding nodes** as users grow — without re-architecting each time.

This roadmap turns the decisions in [ADR-0001](./ADR-0001-scaling-architecture.md) into ordered, shippable phases. Each phase is independently deployable and leaves the app working.

---

## Where we are (baseline)
- Next.js app + Python video sidecar, **single bare processes** on one box.
- Background work dispatched by a **1-minute cron poll**.
- Sidecar holds job state **in memory** → jobs lost on restart (the "orphan" bug, hit 3× in production).
- **CPU** encoding; sidecar worker pool = 2.
- No per-tenant usage limits.

## Target architecture (end state)
```
            ┌── frontend (Next.js)
  Caddy ────┤
            └── api (Next.js route handlers) ──┐
                                               ├── Postgres (jobs + state + usage)
  video-worker × N  ──(LISTEN/NOTIFY + SKIP LOCKED)──┘
   (Go or Python, NVENC, heartbeat)
```
Scale = **add `video-worker` replicas** (same box until cores/GPU saturate, then more boxes). Everything else is stateless behind Caddy.

---

## Phases

### Phase 1 — Containerize (foundation) ✅ *this branch starts here*
- Dockerfile for the app; Dockerfile for the worker (ffmpeg + OpenCV + models).
- `docker-compose.yml`: `db`, `app`, `worker`, `caddy`. `worker` is **replica-scalable** (`docker compose up --scale worker=N`).
- `.env`-driven config; no secrets baked into images.
- **Outcome:** reproducible stack; worker count is now a dial, not a code change.
- **Risk:** none to running prod (additive files; adopt on cutover).

### Phase 2 — Durable queue + heartbeat + reaper
- Replace cron-poll with a **claim queue**: workers `SELECT … FOR UPDATE SKIP LOCKED` to claim jobs; the API `NOTIFY`s on enqueue to wake them (catch-up poll on startup so nothing is lost if no listener).
- Workers write a **heartbeat** (`updated_at`) every 1–2s while processing.
- A **reaper** requeues `running` jobs whose heartbeat is stale (> 2 min) → **auto-recovers crashed/restarted workers** (kills the orphan-bug class permanently).
- **Outcome:** restarts and crashes self-heal; multiple workers share the queue safely.

### Phase 3 — Faster, GPU-accelerated rendering
- **NVENC** encode + collapse the multi-pass Shorts render into one filter graph (≈3× fewer encodes, 5–20× on encode).
- **Stream-copy** for pure trims/joins/dub audio-swap (no re-encode where pixels don't change).
- **Outcome:** each worker does more; the GPU box (GEX44/GEX131) hits its real throughput.

### Phase 4 — Multi-tenancy: usage metering + plan quotas
- Tables: `plans`, `subscriptions`, `usage_counters` (per user, per billing period: processing-minutes + posts).
- Enforce caps at publish/generate time; surface usage in the UI; bill overages.
- **Outcome:** the BYOK/Managed plans from the launch doc are enforceable; cost is bounded per tenant.

### Phase 5 — Billing + hardening
- Stripe (or chosen PSP) checkout + webhooks → drive `subscriptions`.
- Auth hardening (no auth-in-middleware-only), rate limits, per-tenant isolation review.
- **Outcome:** ready for public paid signups.

### Phase 6 — Horizontal scale-out
- Run `video-worker` replicas across cores; add **a second node** behind the shared Postgres queue when one box saturates.
- Optional: bring transcription/TTS/selection **in-house** on the big GPU to drive API COGS → ~0.
- **Outcome:** capacity grows by adding workers/nodes; ~600–1,000 active users per GEX131.

---

## Capacity checkpoints
| Milestone | Setup | Action |
|---|---|---|
| ≤ 300 active | 1× GEX44, workers=2–4 | Phases 1–4 |
| 300–600 active | GEX131 OR 2× GEX44 | scale `worker` replicas (Phase 6) |
| 600–1,000 active | 1× GEX131, NVENC | tune pool size to cores/GPU |
| 1,000+ | +nodes behind queue | add boxes; consider in-house AI |

## Non-goals (deferred, per ADR-0001)
Rewriting the Next.js app to Go, or the frontend to Bun/TanStack — not pursued; the bottlenecks are I/O and GPU, not the host language. The video-worker *may* be Go (greenfield) when Phase 2/3 land.
