#!/usr/bin/env bash
# recued-server native-binary launcher (Phase C).
#
# Wraps the recued-server binary in a minimal retry loop that
# respects the exit-code contract:
#
#   0  — clean shutdown; do NOT respawn.
#   1  — crash; respawn.
#   3  — restart requested; respawn.
#   4  — lock held; STOP RETRYING (another instance owns the port).
#   *  — treat any other non-zero as a crash and respawn.
#
# Set RECUED_LAUNCHER=1 so the daemon's supervisor auto-detect
# classifies itself as `native` mode. Pass any extra args through
# to the binary verbatim.
#
# Usage:
#   recued-server-launcher.sh [--db PATH] [--port N] [--config PATH]

set -eo pipefail

export RECUED_LAUNCHER=1

RECUED_SERVER_BIN="${RECUED_SERVER_BIN:-recued}"
RESTART_BACKOFF_MS="${RECUED_LAUNCHER_BACKOFF_MS:-1000}"

backoff() {
  # sleep expects seconds; convert ms with a bit of precision.
  sleep "$(awk -v ms="$RESTART_BACKOFF_MS" 'BEGIN { printf "%.3f", ms/1000 }')"
}

# ⛔⛔ `|| status=$?` IS WHAT MAKES THE LOOP A LOOP. `set -e` above exits the
# shell on ANY unhandled non-zero command, and the binary here is a bare command
# in a loop body — not a condition — so it counted. Measured 2026-08-31: this
# script ran the server exactly ONCE and died the moment it exited 3, never
# reaching the `case` below. Every branch of that case was unreachable for a
# non-zero status, so the whole retry contract this file exists for did nothing.
#
# ⚠ AND IT WAS BELIEVED. D-188 excluded `native` from the supervised modes for a
# WRONG stated reason ("bare process") but the right practical one — this really
# did not respawn. Reading the loop says it retries; running it says otherwise.
#
# `|| status=$?` makes the failure HANDLED, so `set -e` stands down and the
# `case` decides, which is what the contract above describes.
while true; do
  status=0
  "$RECUED_SERVER_BIN" "$@" || status=$?
  case "$status" in
    0)
      echo "[launcher] recued exited cleanly (0). Stopping."
      exit 0
      ;;
    3)
      echo "[launcher] restart requested (3). Respawning."
      backoff
      ;;
    4)
      echo "[launcher] lock held (4). Another instance owns the data path; stopping."
      exit 4
      ;;
    *)
      echo "[launcher] recued exited $status. Respawning."
      backoff
      ;;
  esac
done
