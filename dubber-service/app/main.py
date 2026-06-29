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
import shutil
import tempfile
import threading
import uuid
from dataclasses import dataclass, field
from queue import Queue
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from app.pipeline import DubRequest, StageEvent, run_dub
from app.shorts_pipeline import ShortsRequest, run_shorts
from app.transcribe_audio import run_transcribe
from dubber.quote_card import render_quote_card

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

# ── Concurrency cap ──────────────────────────────────────────────────────────
# Heavy jobs (dub / shorts / transcribe) are CPU-bound (ffmpeg). Without a cap,
# several users running jobs at once saturate every core and the box thrashes.
# A global semaphore lets at most N run concurrently; the rest wait (their job
# stays "queued" and the client keeps polling). Tune via the env var.
MAX_CONCURRENT_JOBS = max(1, int(os.getenv("DUBBER_MAX_CONCURRENT_JOBS", "2")))
_job_slots = threading.BoundedSemaphore(MAX_CONCURRENT_JOBS)

# Shorts + transcribe run in a SEPARATE pool so a backlog of dub jobs can't
# block them (head-of-line blocking) and vice versa.
OTHER_MAX_CONCURRENT_JOBS = max(
    1, int(os.getenv("OTHER_MAX_CONCURRENT_JOBS", "2"))
)
_other_slots = threading.BoundedSemaphore(OTHER_MAX_CONCURRENT_JOBS)


def _cleanup_workspace(job_id: str) -> None:
    """Remove a job's scratch folder once it's finished (frees disk)."""
    shutil.rmtree(os.path.join("workspace", job_id), ignore_errors=True)


class CreateJob(BaseModel):
    video_input: str
    target_lang: str
    voice: str
    deepgram_key: str
    gemini_key: str = ""
    nvidia_key: str = ""              # caption generation (NVIDIA NIM)
    platforms: Optional[list[str]] = None
    source_lang: str = "auto"
    source_type: str = "url"          # "url" | "upload" (direct fetch, no extractor)
    cookies: str = ""                 # per-job yt-dlp cookies.txt content (optional)
    burn_captions: bool = False       # burn translated subtitles into the video


def _run_job(job: Job, body: CreateJob) -> None:
    job.status = "queued"
    job.message = "Queued — waiting for a free slot…"
    _job_slots.acquire()
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
                nvidia_key=body.nvidia_key,
                platforms=body.platforms,
                source_lang=body.source_lang,
                source_type=body.source_type,
                cookies_file=cookies_file,
                burn_captions=body.burn_captions,
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
        _cleanup_workspace(job.id)
        _job_slots.release()
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


# ── Transcription (audio → chunked Gemini transcript) ────────────────────────
@dataclass
class TranscribeJobState:
    id: str
    status: str = "queued"            # queued|running|done|failed
    pct: int = 0
    stage: str = "queued"
    message: str = "Queued"
    error: Optional[str] = None
    transcript: Optional[str] = None


TRANSCRIBE_JOBS: dict[str, TranscribeJobState] = {}


class CreateTranscribe(BaseModel):
    source_type: str                  # "upload" (direct URL) | "drive"
    source_input: str                 # audio URL or Google Drive share link
    chunks: int = 4
    source_lang: str = "English"      # "Tamil" | "English"
    output_lang: str = "English"      # "Tamil" | "English"
    translate: bool = False
    gemini_key: str = ""


def _run_transcribe(job: "TranscribeJobState", body: CreateTranscribe) -> None:
    job.status = "queued"
    job.message = "Queued — waiting for a free slot…"
    _other_slots.acquire()
    job.status = "running"

    def on_progress(pct: int, stage: str, message: str) -> None:
        job.pct, job.stage, job.message = pct, stage, message

    try:
        job.transcript = run_transcribe(
            source_type=body.source_type,
            source_input=body.source_input,
            chunks=body.chunks,
            source_lang=body.source_lang,
            output_lang=body.output_lang,
            translate=body.translate,
            gemini_key=body.gemini_key,
            on_progress=on_progress,
        )
        job.status = "done"
    except Exception as exc:
        job.status = "failed"
        job.error = str(exc)
    finally:
        _other_slots.release()


@app.post("/transcribe", dependencies=[Depends(require_token)])
def create_transcribe(body: CreateTranscribe) -> dict:
    job = TranscribeJobState(id=uuid.uuid4().hex)
    TRANSCRIBE_JOBS[job.id] = job
    threading.Thread(target=_run_transcribe, args=(job, body), daemon=True).start()
    return {"job_id": job.id, "status": job.status}


@app.get("/transcribe/{job_id}", dependencies=[Depends(require_token)])
def transcribe_status(job_id: str) -> dict:
    job = TRANSCRIBE_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    return {
        "job_id": job.id,
        "status": job.status,
        "pct": job.pct,
        "stage": job.stage,
        "message": job.message,
        "error": job.error,
        "transcript": job.transcript if job.status == "done" else None,
    }


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
    num_clips: int = 3
    min_seconds: int = 90
    max_seconds: int = 120
    aspect: str = "9:16"
    language: str = "en"
    source_type: str = "url"
    cookies: str = ""
    captions: bool = True
    selector: str = "nim"
    gemini_key: str = ""
    gemini_model: Optional[str] = None
    media_resolution: str = "low"
    judge: bool = True
    crop_focus: str = "auto"
    speed: float = 1.0
    overlay_url: Optional[str] = None
    transition_url: Optional[str] = None
    endcard_url: Optional[str] = None
    reference_face_url: Optional[str] = None
    settings: Optional[dict] = None


def _run_shorts(job: ShortsJob, body: CreateShorts) -> None:
    job.status = "queued"
    job.message = "Queued — waiting for a free slot…"
    _other_slots.acquire()
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
                captions=body.captions,
                selector=body.selector,
                gemini_key=body.gemini_key,
                gemini_model=body.gemini_model or "gemini-2.5-flash",
                media_resolution=body.media_resolution,
                judge=body.judge,
                crop_focus=body.crop_focus,
                speed=body.speed,
                overlay_url=body.overlay_url,
                transition_url=body.transition_url,
                endcard_url=body.endcard_url,
                reference_face_url=body.reference_face_url,
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
        _cleanup_workspace(job.id)
        _other_slots.release()
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


class QuoteCard(BaseModel):
    photo_url: str
    quote: str
    overlay_url: Optional[str] = None     # selected overlay (else default brand)
    pan_y: float = 0.4
    zoom: float = 1.0
    box: Optional[list[int]] = None       # [left, top, right, bottom]
    color: Optional[list[int]] = None     # [r, g, b]
    align: str = "left"
    finalize: bool = False                # True → upload to R2, return {publicUrl}


@app.post("/quote-card", dependencies=[Depends(require_token)])
def quote_card(body: QuoteCard):
    """Render a 1080×1350 quote card. Preview → PNG bytes; finalize → upload to
    R2 and return {publicUrl} for publishing."""
    kwargs = {
        "overlay_url": body.overlay_url,
        "pan_y": body.pan_y,
        "zoom": body.zoom,
        "align": body.align,
    }
    if body.box and len(body.box) == 4:
        kwargs["box"] = tuple(body.box)
    if body.color and len(body.color) == 3:
        kwargs["color"] = tuple(body.color)
    try:
        png = render_quote_card(body.photo_url, body.quote, **kwargs)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Card render failed: {exc}")

    if not body.finalize:
        return Response(content=png, media_type="image/png")

    from dubber.r2_upload import upload_clip

    key = f"quote-cards/{uuid.uuid4().hex}.png"
    fd, tmp = tempfile.mkstemp(suffix=".png")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(png)
        # upload_clip hard-codes video/mp4; write our own put for the PNG.
        from dubber.r2_upload import _r2, public_url

        r = _r2()
        if not r:
            raise HTTPException(status_code=500, detail="R2 not configured")
        r["client"].upload_file(
            tmp, r["bucket"], key, ExtraArgs={"ContentType": "image/png"}
        )
        return {"publicUrl": public_url(key), "key": key}
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
