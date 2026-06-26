#!/usr/bin/env bash
# Run one queued background batch (quote distribute / auto-publish / text
# auto-publish). Every minute; flock keeps jobs running one-at-a-time to
# completion (a batch can take several minutes).
set -a
[ -f /root/peerpost/peerpost-app/.env ] && . /root/peerpost/peerpost-app/.env
[ -f /root/peerpost/dubber-service/.env ] && . /root/peerpost/dubber-service/.env
set +a
exec /usr/bin/flock -n /tmp/background-jobs.lock \
  curl -s -m 1400 -X POST -H "Authorization: Bearer ${DUBBER_SERVICE_TOKEN}" \
  http://127.0.0.1:3009/api/internal/background-jobs >> /root/peerpost/background-jobs.log 2>&1
