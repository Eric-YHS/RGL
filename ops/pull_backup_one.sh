#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-ubuntu@119.29.158.79}"
REMOTE_DIR="${REMOTE_DIR:-/opt/honglvdeng/backups}"
LOCAL_DIR="${LOCAL_DIR:-$HOME/Backups/honglvdeng}"
KEEP_LOCAL="${KEEP_LOCAL:-1}"

mkdir -p "$LOCAL_DIR"

scp "$REMOTE_HOST:$REMOTE_DIR/experiment_*.db.gz*" "$LOCAL_DIR/"

local_backups=()
while IFS= read -r line; do
  local_backups+=("$line")
done < <(ls -1t "$LOCAL_DIR"/experiment_*.db.gz 2>/dev/null || true)
if (( ${#local_backups[@]} == 0 )); then
  echo "[pull] no backups pulled to $LOCAL_DIR" >&2
  exit 1
fi

latest_name="$(basename "${local_backups[0]}")"
latest_sha_name="${latest_name}.sha256"

if [[ ! -f "$LOCAL_DIR/$latest_sha_name" ]]; then
  echo "[pull] missing checksum file: $LOCAL_DIR/$latest_sha_name" >&2
  exit 1
fi

pushd "$LOCAL_DIR" >/dev/null
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c "$latest_sha_name"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c "$latest_sha_name"
else
  echo "[pull] no checksum tool found (need shasum or sha256sum)" >&2
  exit 1
fi
popd >/dev/null

if (( ${#local_backups[@]} > KEEP_LOCAL )); then
  for old in "${local_backups[@]:KEEP_LOCAL}"; do
    rm -f "$old" "${old}.sha256"
  done
fi

echo "[pull] latest: $latest_name"
echo "[pull] keep local: $KEEP_LOCAL"
