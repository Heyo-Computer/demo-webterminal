#!/bin/sh
# Start the webterminal and return. Run by the deployment's start_command,
# after /init.sh has brought the guest up and printed HEYVM_READY.
#
# There is no service manager in the guest, so the server is detached from the
# calling shell and left writing to a log.
set -eu

PORT="${PORT:-3000}"
LOG=/var/log/webterminal.log

# start_command may arrive over a shell with a minimal PATH, so resolve bun
# rather than assuming it is on it.
BUN="$(command -v bun 2>/dev/null || echo /usr/local/bin/bun)"

cd /opt/webterminal
mkdir -p /var/log

setsid nohup "$BUN" index.ts </dev/null >>"$LOG" 2>&1 &

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
