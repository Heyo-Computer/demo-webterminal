#!/bin/sh
# Start the webterminal and return. There is no service manager in the guest,
# so the server is detached from the calling shell and left writing to a log.
set -eu

PORT="${PORT:-3000}"
LOG=/var/log/webterminal.log

cd /opt/webterminal
mkdir -p /var/log

setsid nohup bun index.ts </dev/null >>"$LOG" 2>&1 &

# Wait for the listener before returning, so a failed boot reports here with
# its log instead of surfacing later as an unexplained health-check timeout.
i=0
while [ "$i" -lt 30 ]; do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/"; then
    echo "webterminal listening on :${PORT}"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "webterminal did not answer on :${PORT} within 30s" >&2
tail -n 50 "$LOG" >&2 || true
exit 1
