#!/bin/bash
# Daily entry point for a scheduler (launchd or cron). Keeps the Mac awake while emails are spaced
# out, and appends to one log file per day in data/logs.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
mkdir -p data/logs
LOG="data/logs/run-$(date +%Y-%m-%d).log"
PY="$HERE/.venv/bin/python"
[ -x "$PY" ] || PY="python3"
{
  echo "=== $(date) ==="
  if command -v caffeinate >/dev/null 2>&1; then
    caffeinate -i "$PY" -m outreach run "$@"
  else
    "$PY" -m outreach run "$@"
  fi
} >>"$LOG" 2>&1
