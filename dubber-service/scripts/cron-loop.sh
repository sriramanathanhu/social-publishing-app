#!/usr/bin/env bash
# Container replacement for the host crontab (Coolify deploy). Drives the dubber
# reconcile / auto-publish / cleanup ticks against the app. Each tick runs in the
# background under flock so a long one (background-jobs can take minutes) never
# blocks the others — mirroring the host crontab's independent flock'd processes.
set -u
APP="${APP_INTERNAL_URL:-http://app:3009}"
TOKEN="${DUBBER_SERVICE_TOKEN:?DUBBER_SERVICE_TOKEN is required}"

post() { # $1=path  $2=timeout(s)  $3=lockname
  flock -n "/tmp/$3.lock" curl -fsS -m "$2" -X POST \
    -H "Authorization: Bearer $TOKEN" "$APP$1" >/dev/null 2>&1
}

echo "cron-loop up; APP=$APP"
i=0
while true; do
  # every minute (independent + non-overlapping via flock)
  ( post /api/internal/dub-autopublish    110  dubpub )    &
  ( post /api/internal/shorts-autopublish 110  shortpub )  &
  ( post /api/internal/sync-shorts        110  syncshort ) &
  ( post /api/internal/background-jobs     1400 bgjobs )    &
  # every 5 minutes
  [ $((i % 5)) -eq 0 ]  && ( post /api/internal/reconcile-posts 280 reconcile ) &
  # hourly: disk cleanup (runs on the worker's mounted outputs/workspace volumes)
  [ $((i % 60)) -eq 0 ] && ( flock -n /tmp/cleanup.lock bash /srv/scripts/cleanup.sh >/dev/null 2>&1 ) &
  i=$((i + 1))
  sleep 60
done
