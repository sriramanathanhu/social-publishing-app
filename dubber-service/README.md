# Dubber Service (Phase 0 spike)

A Python sidecar for the PeerPost app (`../peerpost-app`). It dubs a video into
another language and returns a finished `.mp4`. PeerPost orchestrates it and
hands the result to its existing PostPeer publish flow — **this service does no
publishing**.

It reuses the battle-tested pipeline from
[`paramashivatma/autodubber`](https://github.com/paramashivatma/autodubber)
(vendored in `dubber/`), with two deliberate changes for a hosted, GPU-free,
multi-user deployment:

- **Transcription → Deepgram API** (`app/transcribe_deepgram.py`) instead of
  self-hosted faster-whisper. Removes the GPU requirement; billed to each
  user's own Deepgram key.
- **BGM separation (Demucs) disabled** — the only remaining GPU-heavy stage.

## Pipeline

```
download (yt-dlp) → transcribe (Deepgram) → merge → translate (Gemini/Google)
→ TTS (Edge-TTS) → build (FFmpeg) → captions (Gemini vision + Mistral) → output.mp4
```

Captions are generated from the translated transcript per platform and exposed
via `GET /jobs/{id}/captions`. The step is non-fatal: a caption-API failure
returns `{}` and never fails the dub. The PeerPost handoff and caption-review UI
live on the Next.js side.

## Layout

```
dubber-service/
├── app/
│   ├── main.py                 FastAPI: /jobs, /jobs/{id}, SSE events, /result
│   ├── pipeline.py             stage orchestration + progress events
│   └── transcribe_deepgram.py  Deepgram adapter (new)
├── dubber/                     vendored pipeline package (downloader, translator,
│                               tts_generator, video_builder, ...)
├── requirements.txt            runtime subset (no whisper/demucs/torch)
├── Dockerfile                  python:3.11-slim + ffmpeg
└── .env.example
```

## Run locally

Requires **Python 3.11+** and **FFmpeg on PATH**.

```bash
cd dubber-service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # set DUBBER_SERVICE_TOKEN
uvicorn app.main:app --port 8800
```

Or with Docker (bundles FFmpeg):

```bash
docker build -t dubber-service .
docker run -p 8800:8800 --env-file .env dubber-service
```

## API

All endpoints except `/health` require `Authorization: Bearer $DUBBER_SERVICE_TOKEN`.
User API keys are passed per-job and never stored or logged.

| Method | Path | Purpose |
|---|---|---|
| GET  | `/health` | liveness |
| POST | `/jobs` | start a dub job → `{job_id}` |
| GET  | `/jobs/{id}` | poll status `{status, pct, stage, message}` |
| GET  | `/jobs/{id}/events` | SSE progress stream (`progress` / `done` / `failed`) |
| GET  | `/jobs/{id}/captions` | per-platform AI captions `{platform: {caption, title?}}` |
| GET  | `/jobs/{id}/result` | download the finished `.mp4` |

### Create a job

```bash
curl -X POST http://localhost:8800/jobs \
  -H "Authorization: Bearer $DUBBER_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "video_input": "https://www.youtube.com/watch?v=...",
    "source_lang": "en",
    "target_lang": "gu",
    "voice": "gu-IN-NiranjanNeural",
    "deepgram_key": "<user deepgram key>",
    "gemini_key": "<user gemini key>",
    "mistral_key": "<user mistral key, optional>"
  }'
```

`video_input` may also be a local file path (the always-works fallback when
yt-dlp is blocked from datacenter IPs).

## Phase 0 limitations (by design)

- Jobs are in-memory; outputs on local disk. Durable state (Postgres) + object
  storage land in the PeerPost-integration phase.
- Single-process worker via threads — fine for the spike, not for concurrency.
  Swap for a real queue (RQ/Celery) when wiring multi-user load.
- No caption generation yet.
