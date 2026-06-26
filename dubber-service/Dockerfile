# Dubber service — Python 3.11 + FFmpeg (the pipeline needs both).
FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY dubber ./dubber
COPY app ./app
# Quote-card fonts/overlay (committed). The face re-ID ONNX models are NOT
# committed (the SFace model is ~38MB) — fetch them at build time with checksum
# verification so a clean checkout / CI build is self-contained.
COPY assets ./assets
COPY scripts ./scripts
RUN sh ./scripts/fetch_models.sh

ENV DUBBER_OUTPUT_DIR=/srv/outputs
EXPOSE 8800

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8800"]
