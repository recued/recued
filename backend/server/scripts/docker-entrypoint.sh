#!/usr/bin/env sh
# Docker entrypoint that intercepts exit 4 (lock held).
#
# Under docker, the container restart policy (`restart: unless-stopped`
# / `on-failure`) respawns on any non-zero exit — it doesn't read the
# supervisor abstraction's exit-code semantics. Exit 4 would otherwise
# loop forever. This wrapper halts the container with a clear log
# line instead.
#
# Resolution order for the server binary (first match wins):
#   1. `/usr/local/bin/recued`                 — npm i -g install (e.g. cloud-init)
#   2. `/opt/recued/dist/bin.js`               — production Dockerfile layout (Phase E)
#   3. `/opt/recued/backend/server/dist/bin.js` — in-repo clone build
#   4. `/opt/recued/backend/server/src/bin.ts` — tsx fallback (dev / Phase C reference)

set +e

: "${RECUED_SUPERVISOR_MODE:=docker}"
export RECUED_SUPERVISOR_MODE

run_server() {
  if [ -x /usr/local/bin/recued ]; then
    /usr/local/bin/recued "$@"
  elif [ -f /opt/recued/dist/bin.js ]; then
    node /opt/recued/dist/bin.js "$@"
  elif [ -f /opt/recued/backend/server/dist/bin.js ]; then
    node /opt/recued/backend/server/dist/bin.js "$@"
  elif [ -f /opt/recued/backend/server/src/bin.ts ]; then
    exec npx tsx /opt/recued/backend/server/src/bin.ts "$@"
  else
    echo "[entrypoint] recued binary not found" >&2
    exit 1
  fi
}

run_server "$@"
status=$?

if [ "$status" -eq 4 ]; then
  echo "[entrypoint] recued reported lock_held (exit 4)." >&2
  echo "[entrypoint] Stopping container so docker restart policy doesn't loop." >&2
  # Sleep briefly so the log line lands in docker logs before exit.
  sleep 1
  exit 0   # report as clean exit so restart: on-failure doesn't fire
fi
exit "$status"
