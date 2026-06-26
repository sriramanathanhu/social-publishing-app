#!/usr/bin/env bash
# Schedule newly-finished shorts clips into their distribution list (a slice per
# ecosystem, drip-spaced). Runs from cron every minute; flock prevents overlap.
set -a
[ -f /root/peerpost/peerpost-app/.env ] && . /root/peerpost/peerpost-app/.env
[ -f /root/peerpost/dubber-service/.env ] && . /root/peerpost/dubber-service/.env
set +a
exec /usr/bin/flock -n /tmp/shorts-autopublish.lock \
  curl -s -m 110 -X POST -H "Authorization: Bearer ${DUBBER_SERVICE_TOKEN}" \
  http://127.0.0.1:3009/api/internal/shorts-autopublish >> /root/peerpost/shorts-autopublish.log 2>&1
