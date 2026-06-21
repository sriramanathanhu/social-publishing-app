#!/usr/bin/env bash
# Start the dubber-service sidecar reliably.
#
# Activating the venv puts .venv/bin on PATH so the pipeline's `yt-dlp`
# subprocess is found, and `set -a` exports .env (DUBBER_SERVICE_TOKEN, etc.)
# into the process the subprocesses inherit. Launching uvicorn directly without
# this leaves yt-dlp off PATH → silent download failures.
set -euo pipefail
cd "$(dirname "$0")"

source .venv/bin/activate
set -a
[ -f .env ] && . ./.env
set +a

mkdir -p outputs logs

# yt-dlp needs a JavaScript runtime (Deno) to solve YouTube's nsig/EJS challenge;
# without it YouTube only exposes image formats → "Requested format is not
# available". Warn loudly rather than fail mysteriously mid-download.
command -v deno >/dev/null 2>&1 || \
  echo "WARNING: 'deno' not found on PATH — YouTube downloads will fail the nsig challenge. Install it (see https://github.com/yt-dlp/yt-dlp/wiki/EJS)."

HOST="${DUBBER_HOST:-127.0.0.1}"
PORT="${DUBBER_PORT:-8800}"
exec uvicorn app.main:app --host "$HOST" --port "$PORT"
