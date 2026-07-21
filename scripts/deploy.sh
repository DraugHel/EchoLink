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

echo "===== DATENBANK-BACKUP ====="
"$ROOT_DIR/scripts/backup-db.sh" deploy

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

# EchoLink Phase 4.2: previous asset generation
#
# Vite leert dist bei jedem Build. Bereits geoeffnete Browser-Tabs
# koennen aber noch die unmittelbar vorherigen gehashten Chunks
# anfordern. Deshalb behalten wir exakt eine vorherige Generation.
#
# Die Manifestdatei enthaelt nur die vom aktuellen Build erzeugten
# Asset-Dateinamen. Retained Assets werden dort bewusst nicht erneut
# eingetragen, damit sich alte Generationen nicht ansammeln.
CURRENT_ASSET_MANIFEST="dist/.echolink-current-assets"

if [[ ! -d dist/assets ]]; then
  echo "Fehler: dist/assets wurde nicht erzeugt."
  exit 1
fi

find dist/assets   -maxdepth 1   -type f   -printf '%f\n' |
  sort   >"$CURRENT_ASSET_MANIFEST"

CURRENT_ASSET_COUNT="$(
  wc -l <"$CURRENT_ASSET_MANIFEST" |
  tr -d '[:space:]'
)"

PREVIOUS_ASSET_LIST=""
FALLBACK_ASSET_LIST=""
RETAINED_ASSET_COUNT=0

if [[ $HAD_DIST -eq 1 ]] &&
   [[ -d "$BACKUP_DIR/dist/assets" ]]; then
  if [[ -s "$BACKUP_DIR/dist/.echolink-current-assets" ]]; then
    PREVIOUS_ASSET_LIST="$BACKUP_DIR/dist/.echolink-current-assets"
  else
    # Erster Deploy nach Einfuehrung der Retention:
    # Das bestehende dist enthaelt zu diesem Zeitpunkt nur eine
    # Generation, daher darf die komplette alte Asset-Liste dienen.
    FALLBACK_ASSET_LIST="$BACKUP_DIR/previous-assets.txt"

    find "$BACKUP_DIR/dist/assets"       -maxdepth 1       -type f       -printf '%f\n' |
      sort       >"$FALLBACK_ASSET_LIST"

    PREVIOUS_ASSET_LIST="$FALLBACK_ASSET_LIST"
  fi
fi

if [[ -n "$PREVIOUS_ASSET_LIST" ]] &&
   [[ -s "$PREVIOUS_ASSET_LIST" ]]; then
  while IFS= read -r asset_name; do
    [[ -n "$asset_name" ]] || continue

    if [[ ! "$asset_name" =~ ^[A-Za-z0-9._-]+$ ]]; then
      echo "Fehler: Ungueltiger Asset-Dateiname: $asset_name"
      exit 1
    fi

    source_asset="$BACKUP_DIR/dist/assets/$asset_name"
    target_asset="dist/assets/$asset_name"

    if [[ ! -f "$source_asset" ]]; then
      echo "Warnung: Vorheriges Asset fehlt: $asset_name"
      continue
    fi

    if [[ ! -e "$target_asset" ]]; then
      cp -a "$source_asset" "$target_asset"
      RETAINED_ASSET_COUNT=$((RETAINED_ASSET_COUNT + 1))
    fi
  done <"$PREVIOUS_ASSET_LIST"
fi

echo "Aktuelle Asset-Generation: $CURRENT_ASSET_COUNT Dateien"
echo "Vorherige Generation zusaetzlich behalten: $RETAINED_ASSET_COUNT Dateien"

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
node --check server/mcp/webServer.js
node --check scripts/mcp-web-smoke.js

echo "===== NEUSTART ====="
pm2 restart echolink --update-env
pm2 restart echolink-worker --update-env

if pm2 describe echolink-mcp-web >/dev/null 2>&1; then
  pm2 restart echolink-mcp-web --update-env
else
  pm2 start ecosystem.config.cjs \
    --only echolink-mcp-web \
    --update-env
fi

sleep 4

echo "===== HEALTH CHECK ====="
curl -fsS --max-time 10 \
  http://127.0.0.1:3000/ \
  >/dev/null

curl -fsS --max-time 10 \
  http://127.0.0.1:3011/health \
  >/dev/null

timeout 20s node scripts/mcp-web-smoke.js --list-only

pm2 save

echo
echo "Deploy erfolgreich."
echo "Frontend: $ASSET"
