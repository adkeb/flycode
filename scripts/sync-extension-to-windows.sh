#!/usr/bin/env bash
# FlyCode Note: Syncs the built extension dist directory into the configured Windows path for easy Edge loading.
set -euo pipefail

DEST_DIR="/mnt/c/Users/a1881/Documents/flycode-extension"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/extension/dist" && pwd)"

mkdir -p "$DEST_DIR"

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$SRC_DIR"/ "$DEST_DIR"/
else
  find "$DEST_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  cp -a "$SRC_DIR"/. "$DEST_DIR"/
fi

echo "FlyCode extension synced to: $DEST_DIR"
