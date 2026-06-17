"""Phase 0 dubbing service (FastAPI).

A thin HTTP wrapper around :mod:`app.pipeline`. PeerPost (the Next.js app) is
the only intended caller: it creates a job with the user's keys, streams
progress over SSE, and downloads the finished video to hand to its existing
PostPeer publish flow.

Scope note (spike): jobs live in memory and outputs on local disk. Durable job
state (Postgres) and object storage (the PostPeer S3 presign flow) come in the
PeerPost-integration phase — this service stays stateless-per-process for now.

Auth: a shared bearer token (``DUBBER_SERVICE_TOKEN``) gates every endpoint, so
only the PeerPost backend can call it. User API keys arrive per-request in the
job body and are never written to disk or logs.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import threading
import uuid
from dataclasses import dataclass, field
from queue import Queue
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from app.pipeline import DubRequest, StageEvent, run_dub
from app.shorts_pipeline import ShortsRequest, run_shorts

app = FastAPI(title="Dubber Service", version="0.1.0")

OUTPUT_DIR = os.getenv("DUBBER_OUTPUT_DIR", "outputs")
SERVICE_TOKEN = os.getenv("DUBBER_SERVICE_TOKEN", "")


# ── Auth ─────────────────────────────────────────────────────────────────────
def require_token(authorization: str = Header(default="")) -> None:
    if not SERVICE_TOKEN:
        raise HTTPException(500, "DUBBER_SERVICE_TOKEN is not configured")
    expected = f"Bearer {SERVICE_TOKEN}"
    if authorization != expected:
        raise HTTPException(401, "Unauthorized")


# ── In-memory job store ───────────────────────────────────────────────────────
@dataclass
class Job:
    id: str
    status: str = "queued"          # queued|running|done|failed
    pct: int = 0
    stage: str = "queued"
    message: str = "Queued"
    error: Optional[str] = None
    output_path: Optional[str] = None
    captions: dict = field(default_factory=dict)
    events: "Queue[StageEvent]" = field(default_factory=Queue)


JOBS: dict[str, Job] = {}


class CreateJob(BaseModel):
    video_input: str
    target_lang: str
    voice: str
    deepgram_key: str
    gemini_key: str = ""
    mistral_key: str = ""
    platforms: Optional[list[str]] = None
    source_lang: str = "auto"
    source_type: str = "url"          # "url" | "upload" (direct fetch, no extractor)
    cookies: str = ""                 # per-job yt-dlp cookies.txt content (optional)


def _run_job(job: Job, body: CreateJob) -> None:
    job.status = "running"
    out_path = os.path.join(OUTPUT_DIR, f"{job.id}.mp4")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Materialise per-job cookies (if supplied) to a temp file yt-dlp can read.
    # Kept OUTSIDE the workspace (run_dub wipes the workspace on start) and
    # removed in the finally block so credentials never linger on disk.
    cookies_file = None
    if body.cookies.strip():
        fd, cookies_file = tempfile.mkstemp(prefix=f"dubcookies_{job.id}_", suffix=".txt")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body.cookies)

    def on_progress(ev: StageEvent) -> None:
        job.pct, job.stage, job.message = ev.pct, ev.stage, ev.message
        job.events.put(ev)

    try:
        result = run_dub(
            DubRequest(
                video_input=body.video_input,
                target_lang=body.target_lang,
                voice=body.voice,
                deepgram_key=body.deepgram_key,
                gemini_key=body.gemini_key,
                mistral_key=body.mistral_key,
                platforms=body.platforms,
                source_lang=body.source_lang,
                source_type=body.source_type,
                cookies_file=cookies_file,
                workspace=os.path.join("workspace", job.id),
                output_path=out_path,
            ),
            on_progress=on_progress,
        )
        job.output_path = result.output_path
        job.captions = result.captions
        job.status = "done"
    except Exception as exc:  # surface failure to the caller, don't crash worker
        job.status = "failed"
        job.error = str(exc)
    finally:
        if cookies_file and os.path.exists(cookies_file):
            try:
                os.remove(cookies_file)
            except OSError:
                pass
        # Sentinel so an open SSE stream knows to close.
        job.events.put(None)  # type: ignore[arg-type]


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "dubber", "version": app.version}


@app.post("/jobs", dependencies=[Depends(require_token)])
def create_job(body: CreateJob) -> dict:
    job = Job(id=uuid.uuid4().hex)
    JOBS[job.id] = job
    threading.Thread(target=_run_job, args=(job, body), daemon=True).start()
    return {"job_id": job.id, "status": job.status}


@app.get("/jobs/{job_id}", dependencies=[Depends(require_token)])
def job_status(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    return {
        "job_id": job.id,
        "status": job.status,
        "pct": job.pct,
        "stage": job.stage,
        "message": job.message,
        "error": job.error,
        "has_output": bool(job.output_path),
    }


@app.get("/jobs/{job_id}/events", dependencies=[Depends(require_token)])
async def job_events(job_id: str) -> StreamingResponse:
    """Server-Sent Events stream of pipeline progress."""
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")

    async def gen():
        loop = asyncio.get_event_loop()
        while True:
            ev = await loop.run_in_executor(None, job.events.get)
            if ev is None:  # sentinel: job finished
                final = "done" if job.status == "done" else "failed"
                payload = job.error or "complete"
                yield f"event: {final}\ndata: {payload}\n\n"
                return
            yield (
                f"event: progress\n"
                f"data: {{\"stage\":\"{ev.stage}\",\"pct\":{ev.pct},"
                f"\"message\":{_json_str(ev.message)}}}\n\n"
            )

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/jobs/{job_id}/captions", dependencies=[Depends(require_token)])
def job_captions(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    return {"captions": job.captions}


@app.get("/jobs/{job_id}/result", dependencies=[Depends(require_token)])
def job_result(job_id: str) -> FileResponse:
    job = JOBS.get(job_id)
    if not job or not job.output_path or not os.path.exists(job.output_path):
        raise HTTPException(404, "Result not ready")
    return FileResponse(job.output_path, media_type="video/mp4", filename="dubbed.mp4")


def _json_str(s: str) -> str:
    """Minimal JSON string escaping for SSE data payloads."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


# ── Shorts factory (long video → many clips) ─────────────────────────────────
@dataclass
class ShortsJob:
    id: str
    status: str = "queued"
    pct: int = 0
    stage: str = "queued"
    message: str = "Queued"
    error: Optional[str] = None
    clips: list = field(default_factory=list)
    events: "Queue[StageEvent]" = field(default_factory=Queue)


SHORTS_JOBS: dict[str, ShortsJob] = {}


class CreateShorts(BaseModel):
    video_input: str
    deepgram_key: str
    nvidia_key: str
    nvidia_url: str = "https://integrate.api.nvidia.com/v1/chat/completions"
    clip_model: Optional[str] = None
    title_model: Optional[str] = None
    num_clips: int = 15
    min_seconds: int = 90
    max_seconds: int = 120
    aspect: str = "9:16"
    language: str = "en"
    source_type: str = "url"
    cookies: str = ""
    settings: Optional[dict] = None


def _run_shorts(job: ShortsJob, body: CreateShorts) -> None:
    job.status = "running"
    cookies_file = None
    if body.cookies.strip():
        fd, cookies_file = tempfile.mkstemp(prefix=f"shorts_{job.id}_", suffix=".txt")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body.cookies)

    def on_progress(ev: StageEvent) -> None:
        job.pct, job.stage, job.message = ev.pct, ev.stage, ev.message
        job.events.put(ev)

    try:
        kw = {}
        if body.clip_model:
            kw["clip_model"] = body.clip_model
        if body.title_model:
            kw["title_model"] = body.title_model
        result = run_shorts(
            ShortsRequest(
                video_input=body.video_input,
                deepgram_key=body.deepgram_key,
                nvidia_key=body.nvidia_key,
                nvidia_url=body.nvidia_url,
                num_clips=body.num_clips,
                min_seconds=body.min_seconds,
                max_seconds=body.max_seconds,
                aspect=body.aspect,
                language=body.language,
                source_type=body.source_type,
                cookies_file=cookies_file,
                settings=body.settings or {},
                workspace=os.path.join("workspace", job.id),
                job_id=job.id,
                **kw,
            ),
            on_progress=on_progress,
        )
        job.clips = result.clips
        job.status = "done"
    except Exception as exc:  # noqa: BLE001
        job.status = "failed"
        job.error = str(exc)
    finally:
        if cookies_file and os.path.exists(cookies_file):
            try:
                os.remove(cookies_file)
            except OSError:
                pass
        job.events.put(None)  # type: ignore[arg-type]


@app.post("/shorts", dependencies=[Depends(require_token)])
def create_shorts(body: CreateShorts) -> dict:
    job = ShortsJob(id=uuid.uuid4().hex)
    SHORTS_JOBS[job.id] = job
    threading.Thread(target=_run_shorts, args=(job, body), daemon=True).start()
    return {"job_id": job.id, "status": job.status}


@app.get("/shorts/{job_id}", dependencies=[Depends(require_token)])
def shorts_status(job_id: str) -> dict:
    job = SHORTS_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    return {
        "job_id": job.id, "status": job.status, "pct": job.pct,
        "stage": job.stage, "message": job.message, "error": job.error,
        "count": len(job.clips),
    }


@app.get("/shorts/{job_id}/clips", dependencies=[Depends(require_token)])
def shorts_clips(job_id: str) -> dict:
    job = SHORTS_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    return {"clips": job.clips}


@app.get("/shorts/{job_id}/events", dependencies=[Depends(require_token)])
async def shorts_events(job_id: str) -> StreamingResponse:
    job = SHORTS_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")

    async def gen():
        loop = asyncio.get_event_loop()
        while True:
            ev = await loop.run_in_executor(None, job.events.get)
            if ev is None:
                final = "done" if job.status == "done" else "failed"
                yield f"event: {final}\ndata: {job.error or 'complete'}\n\n"
                return
            yield (
                f"event: progress\n"
                f"data: {{\"stage\":\"{ev.stage}\",\"pct\":{ev.pct},"
                f"\"message\":{_json_str(ev.message)}}}\n\n"
            )

    return StreamingResponse(gen(), media_type="text/event-stream")
