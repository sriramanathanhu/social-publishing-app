#!/usr/bin/env bash
# Backstop cleanup for the dubber sidecar. Per-job cleanup already runs on
# completion; this catches anything that slipped through AND keeps the disk from
# filling (finished outputs are already archived to R2, so local copies are
# disposable). Run HOURLY via cron.
set -u
cd "$(dirname "$0")/.." || exit 0

# 1) workspace scratch dirs with NO file touched in the last 6h (a running job
#    has recent files, so it's preserved).
if [ -d workspace ]; then
  for d in workspace/*/; do
    [ -d "$d" ] || continue
    if [ -z "$(find "$d" -type f -newermt '6 hours ago' -print -quit 2>/dev/null)" ]; then
      rm -rf "$d"
    fi
  done
fi

# 2) finished output mp4s older than 12h (the dub/short already lives in R2).
[ -d outputs ] && find outputs -maxdepth 1 -type f -mmin +720 -delete 2>/dev/null

# 3) EMERGENCY disk-pressure valve: if the filesystem is still over 80% used,
#    delete the OLDEST outputs first until back under 80% (or none left). This is
#    what stops a big batch from ever filling the disk and crashing Postgres.
disk_pct() { df --output=pcent / | tail -1 | tr -dc '0-9'; }
if [ -d outputs ]; then
  while [ "$(disk_pct)" -ge 80 ]; do
    f="$(find outputs -maxdepth 1 -type f -printf '%T@ %p\n' 2>/dev/null | sort -n | head -1 | cut -d' ' -f2-)"
    [ -n "$f" ] || break
    rm -f "$f"
  done
fi

echo "$(date -u +%FT%TZ) cleanup done; workspace=$(du -sh workspace 2>/dev/null | cut -f1) outputs=$(du -sh outputs 2>/dev/null | cut -f1) disk=$(df -h / | awk 'NR==2{print $5}')"
