#!/usr/bin/env bash
# Keep the shorts DB in sync with the sidecar's real job state (status + clips),
# so the UI never shows a stale "queued/stuck" for a job that's actually
# running/done. Runs from cron every minute; flock prevents overlap.
set -a
[ -f /root/peerpost/peerpost-app/.env ] && . /root/peerpost/peerpost-app/.env
[ -f /root/peerpost/dubber-service/.env ] && . /root/peerpost/dubber-service/.env
set +a
exec /usr/bin/flock -n /tmp/sync-shorts.lock \
  node /root/peerpost/dubber-service/scripts/sync-shorts.mjs >> /root/peerpost/sync-shorts.log 2>&1
