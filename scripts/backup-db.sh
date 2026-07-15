#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"

DB_PATH="${ECHOLINK_DB_PATH:-$ROOT_DIR/data/echolink.db}"
BACKUP_ROOT="${ECHOLINK_BACKUP_DIR:-/root/echolink-backups/database}"
BACKUP_KIND="${1:-daily}"

case "$BACKUP_KIND" in
  daily|deploy)
    ;;
  *)
    echo "Verwendung: $0 [daily|deploy]" >&2
    exit 2
    ;;
esac

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "Fehler: sqlite3 ist nicht installiert." >&2
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "Fehler: Datenbank nicht gefunden: $DB_PATH" >&2
  exit 1
fi

mkdir -p \
  "$BACKUP_ROOT/daily" \
  "$BACKUP_ROOT/weekly" \
  "$BACKUP_ROOT/deploy"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET_DIR="$BACKUP_ROOT/$BACKUP_KIND"
FINAL_PATH="$TARGET_DIR/echolink-$BACKUP_KIND-$STAMP.db"
TEMP_PATH="$TARGET_DIR/.echolink-$BACKUP_KIND-$STAMP.tmp.db"

cleanup() {
  rm -f -- "$TEMP_PATH"
}
trap cleanup EXIT

sqlite3 "$DB_PATH" ".timeout 10000" ".backup '$TEMP_PATH'"

CHECK_RESULT="$(sqlite3 "$TEMP_PATH" 'PRAGMA quick_check;')"
if [[ "$CHECK_RESULT" != "ok" ]]; then
  echo "Fehler: Backup-Prüfung fehlgeschlagen: $CHECK_RESULT" >&2
  exit 1
fi

chmod 600 "$TEMP_PATH"
mv "$TEMP_PATH" "$FINAL_PATH"

if [[ "$BACKUP_KIND" == "daily" ]] && [[ "$(date +%u)" == "7" ]]; then
  WEEKLY_PATH="$BACKUP_ROOT/weekly/echolink-weekly-$STAMP.db"
  cp --reflink=auto "$FINAL_PATH" "$WEEKLY_PATH"
  chmod 600 "$WEEKLY_PATH"
fi

prune_backups() {
  local directory="$1"
  local keep="$2"
  local -a files=()

  mapfile -d '' -t files < <(
    find "$directory" -maxdepth 1 -type f -name 'echolink-*.db' \
      -printf '%T@ %p\0' |
      sort -z -nr |
      cut -z -d' ' -f2-
  )

  if (( ${#files[@]} > keep )); then
    for ((i = keep; i < ${#files[@]}; i++)); do
      rm -f -- "${files[$i]}"
    done
  fi
}

prune_backups "$BACKUP_ROOT/daily" 7
prune_backups "$BACKUP_ROOT/weekly" 4
prune_backups "$BACKUP_ROOT/deploy" 10

echo "Datenbank-Backup erstellt: $FINAL_PATH"
