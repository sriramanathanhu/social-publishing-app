# Dubber service — Python 3.11 + FFmpeg (the pipeline needs both).
FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY dubber ./dubber
COPY app ./app

ENV DUBBER_OUTPUT_DIR=/srv/outputs
EXPOSE 8800

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8800"]
