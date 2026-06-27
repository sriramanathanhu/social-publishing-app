#!/usr/bin/env bash
# Safety-net behind the Zernio webhook: pull the real status of OVERDUE scheduled
# posts (one batch) and advance the terminal ones (published / failed / gone), so
# our posts_log never drifts even if a webhook delivery is missed. Token-gated.
# Cron, every few minutes. flock so a slow batch never overlaps the next tick.
set -a
[ -f /root/peerpost/dubber-service/.env ] && . /root/peerpost/dubber-service/.env
set +a
exec /usr/bin/flock -n /tmp/reconcile-posts.lock \
  curl -s -m 280 -X POST \
  -H "Authorization: Bearer ${DUBBER_SERVICE_TOKEN}" \
  "http://127.0.0.1:3009/api/internal/reconcile-posts?limit=200&concurrency=10&overdue=1" \
  >> /root/peerpost/reconcile-posts.log 2>&1
