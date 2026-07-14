#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"

cd "$ROOT_DIR"

if [[ "${ALLOW_DIRTY:-0}" != "1" ]] &&
   [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Abbruch: Git enthält noch nicht gespeicherte Änderungen."
  echo "Erst committen oder ALLOW_DIRTY=1 verwenden."
  exit 1
fi

if [[ "${SKIP_PULL:-0}" != "1" ]]; then
  echo "===== GIT PULL ====="
  git pull --ff-only
fi

BACKUP_DIR="$(mktemp -d)"
HAD_DIST=0

if [[ -d dist ]]; then
  cp -a dist "$BACKUP_DIR/dist"
  HAD_DIST=1
fi

cleanup() {
  status=$?

  if [[ $status -ne 0 ]]; then
    echo
    echo "Deploy fehlgeschlagen – vorheriges Frontend wird wiederhergestellt."

    rm -rf dist

    if [[ $HAD_DIST -eq 1 ]]; then
      cp -a "$BACKUP_DIR/dist" dist
    fi
  fi

  rm -rf "$BACKUP_DIR"
}

trap cleanup EXIT

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  echo "===== ABHÄNGIGKEITEN ====="

  if [[ -f package-lock.json ]]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi

  if [[ -f client/package-lock.json ]]; then
    npm --prefix client ci --no-audit --no-fund
  else
    npm --prefix client install --no-audit --no-fund
  fi
fi

echo "===== TESTS ====="
npm run test:smoke

echo "===== FRONTEND BUILD ====="
npm run build

if [[ ! -s dist/index.html ]]; then
  echo "Fehler: dist/index.html wurde nicht erzeugt."
  exit 1
fi

ASSET="$(
  grep -oE 'assets/index-[^"]+\.js' dist/index.html |
  head -1 || true
)"

if [[ -z "$ASSET" ]]; then
  echo "Fehler: Kein JavaScript-Bundle in dist/index.html gefunden."
  exit 1
fi

if [[ ! -s "dist/$ASSET" ]]; then
  echo "Fehler: Referenziertes Bundle fehlt: dist/$ASSET"
  exit 1
fi

echo "Bundle geprüft: dist/$ASSET"

echo "===== SERVER-SYNTAX ====="
node --check server/index.js
node --check server/worker.js

echo "===== NEUSTART ====="
pm2 restart echolink --update-env
pm2 restart echolink-worker --update-env

sleep 4

echo "===== HEALTH CHECK ====="
curl -fsS --max-time 10 \
  http://127.0.0.1:3000/ \
  >/dev/null

pm2 save

echo
echo "Deploy erfolgreich."
echo "Frontend: $ASSET"
