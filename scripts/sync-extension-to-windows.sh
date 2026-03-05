#!/usr/bin/env bash
# FlyCode Note: Syncs extension dist into Windows path (default F:\\edge). Supports one-shot and watch mode.
set -euo pipefail

WATCH_MODE=0
POLL_SECONDS="${POLL_SECONDS:-1}"
DEST_DIR="${FLYCODE_WINDOWS_EXTENSION_DIR:-/mnt/f/edge}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/extension/dist" && pwd)"

while (($# > 0)); do
  case "$1" in
    --watch)
      WATCH_MODE=1
      shift
      ;;
    --dest)
      if (($# < 2)); then
        echo "Missing value for --dest" >&2
        exit 1
      fi
      DEST_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--watch] [--dest /mnt/f/edge]" >&2
      exit 1
      ;;
  esac
done

sync_once() {
  mkdir -p "$DEST_DIR"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$SRC_DIR"/ "$DEST_DIR"/
  else
    find "$DEST_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -a "$SRC_DIR"/. "$DEST_DIR"/
  fi
  echo "[$(date '+%F %T')] FlyCode extension synced to: $DEST_DIR"
}

if ((WATCH_MODE == 0)); then
  sync_once
  exit 0
fi

echo "Watching extension dist for changes..."
echo "- source: $SRC_DIR"
echo "- destination: $DEST_DIR"
echo "- mode: realtime"

sync_once

if command -v inotifywait >/dev/null 2>&1; then
  while inotifywait -qq -r -e create,modify,delete,move "$SRC_DIR"; do
    sync_once
  done
else
  echo "inotifywait not found, fallback to polling every ${POLL_SECONDS}s"
  last_sig=""
  while true; do
    if [[ -d "$SRC_DIR" ]]; then
      current_sig="$(find "$SRC_DIR" -type f -printf '%P %s %T@\n' | sort | sha256sum | awk '{print $1}')"
    else
      current_sig="(missing)"
    fi

    if [[ "$current_sig" != "$last_sig" ]]; then
      sync_once
      last_sig="$current_sig"
    fi
    sleep "$POLL_SECONDS"
  done
fi
