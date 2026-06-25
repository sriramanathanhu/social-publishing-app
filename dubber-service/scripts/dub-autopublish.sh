#!/usr/bin/env bash
# Background tick: reconcile finished dubs + auto-schedule opted-in ones to their
# language's accounts. Hits the app's internal endpoint (token-gated). Cron, 1/min.
set -a
[ -f /root/peerpost/dubber-service/.env ] && . /root/peerpost/dubber-service/.env
set +a
exec /usr/bin/flock -n /tmp/dub-autopublish.lock \
  curl -s -m 110 -X POST \
  -H "Authorization: Bearer ${DUBBER_SERVICE_TOKEN}" \
  http://127.0.0.1:3009/api/internal/dub-autopublish >> /root/peerpost/dub-autopublish.log 2>&1
