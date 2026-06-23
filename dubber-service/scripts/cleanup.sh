#!/usr/bin/env bash
# Backstop cleanup for the dubber sidecar: remove stale per-job scratch folders
# (orphans from crashed jobs) and outputs already archived to R2. Per-job cleanup
# already runs on completion; this catches anything that slipped through.
set -u
cd "$(dirname "$0")/.." || exit 0

# workspace dirs with NO file modified in the last 24h (a running job has recent
# files, so it is preserved; dir mtime alone is unreliable, hence the recursive check)
if [ -d workspace ]; then
  for d in workspace/*/; do
    [ -d "$d" ] || continue
    if [ -z "$(find "$d" -type f -newermt '24 hours ago' -print -quit 2>/dev/null)" ]; then
      rm -rf "$d"
    fi
  done
fi

# finished output mp4s older than 2 days (the dub archive lives in R2)
[ -d outputs ] && find outputs -maxdepth 1 -type f -mtime +2 -delete 2>/dev/null
echo "$(date -u +%FT%TZ) cleanup done; workspace=$(du -sh workspace 2>/dev/null | cut -f1) outputs=$(du -sh outputs 2>/dev/null | cut -f1) disk=$(df -h / | awk 'NR==2{print $5}')"
