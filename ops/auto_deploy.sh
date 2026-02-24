#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/honglvdeng}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-前后端}"
LOCK_FILE="${LOCK_FILE:-/tmp/honglvdeng-auto-deploy.lock}"

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export GIT_PAGER=cat

exec 9>"$LOCK_FILE"
if ! command -v flock >/dev/null 2>&1; then
  echo "[auto-deploy] flock not found; skip"
  exit 0
fi
if ! flock -n 9; then
  # Another deployment is still running.
  exit 0
fi

cd "$APP_DIR"

git fetch "$REMOTE" "$BRANCH" --quiet
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "$REMOTE/$BRANCH")"

if [[ "$local_sha" == "$remote_sha" ]]; then
  exit 0
fi

echo "[auto-deploy] $(date '+%F %T') update ${local_sha:0:7} -> ${remote_sha:0:7}"

git pull --ff-only "$REMOTE" "$BRANCH"
npm install
npm --prefix server install
npm run build
pm2 restart honglvdeng-api --update-env

echo "[auto-deploy] $(date '+%F %T') done $(git rev-parse --short HEAD)"
