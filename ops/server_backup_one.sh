#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${DB_PATH:-/opt/honglvdeng/data/experiment.db}"
BACKUP_DIR="${BACKUP_DIR:-/opt/honglvdeng/backups}"
KEEP_COUNT="${KEEP_COUNT:-1}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "[backup] database not found: $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

ts="$(date +%F_%H%M%S)"
raw="$BACKUP_DIR/experiment_${ts}.db"
gz="${raw}.gz"
base="$(basename "$gz")"
sha="${BACKUP_DIR}/${base}.sha256"

sqlite3 "$DB_PATH" ".timeout 5000" ".backup '$raw'"
gzip -f "$raw"

if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$BACKUP_DIR"
    sha256sum "$base" > "${base}.sha256"
  )
else
  (
    cd "$BACKUP_DIR"
    shasum -a 256 "$base" > "${base}.sha256"
  )
fi

# Keep only the latest KEEP_COUNT backups on server.
mapfile -t backups < <(ls -1t "$BACKUP_DIR"/experiment_*.db.gz 2>/dev/null || true)
if (( ${#backups[@]} > KEEP_COUNT )); then
  for old in "${backups[@]:KEEP_COUNT}"; do
    rm -f "$old" "${old}.sha256"
  done
fi

echo "[backup] ok: $gz"
echo "[backup] keep: $KEEP_COUNT"
