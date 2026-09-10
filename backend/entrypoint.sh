#!/bin/sh
set -e

alembic upgrade head

# exec-form so uvicorn runs as PID 1 and receives signals directly.
# Access log OFF: it logs raw /t/{token} paths and ?q= search text.
exec python -m uvicorn main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --no-access-log \
  --proxy-headers \
  --forwarded-allow-ips="${FORWARDED_ALLOW_IPS:-127.0.0.1}"
