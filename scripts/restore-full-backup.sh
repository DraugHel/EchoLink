#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Verwendung: $0 BACKUP.tar.gz.enc [ZIELORDNER]" >&2
  exit 2
fi

BACKUP_PATH="$(readlink -f "$1")"
TARGET_DIR="${2:-/root/echolink-restore}"
PBKDF2_ITERATIONS="${ECHOLINK_BACKUP_ITERATIONS:-250000}"

for command in openssl tar sha256sum readlink mktemp; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Fehler: $command ist nicht installiert." >&2
    exit 1
  fi
done

if [[ ! -f "$BACKUP_PATH" ]]; then
  echo "Fehler: Backup nicht gefunden: $BACKUP_PATH" >&2
  exit 1
fi

if [[ -e "$TARGET_DIR" ]] && [[ -n "$(find "$TARGET_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  echo "Fehler: Zielordner ist nicht leer: $TARGET_DIR" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
PLAIN_ARCHIVE="$WORK_DIR/restore.tar.gz"

cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

echo
echo "Gib das Passwort des Backups ein."
echo

read -r -s -p "Passwort: " BACKUP_PASSWORD
echo

openssl enc \
  -d \
  -aes-256-cbc \
  -pbkdf2 \
  -iter "$PBKDF2_ITERATIONS" \
  -pass fd:3 \
  -in "$BACKUP_PATH" \
  -out "$PLAIN_ARCHIVE" \
  3<<<"$BACKUP_PASSWORD"

unset BACKUP_PASSWORD

tar -tzf "$PLAIN_ARCHIVE" >/dev/null

mkdir -p "$TARGET_DIR"
tar -xzf "$PLAIN_ARCHIVE" -C "$TARGET_DIR"

PAYLOAD_DIR="$(
  find "$TARGET_DIR" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    -print \
    -quit
)"

if [[ -z "$PAYLOAD_DIR" ]]; then
  echo "Fehler: Kein Backup-Inhalt gefunden." >&2
  exit 1
fi

if [[ ! -f "$PAYLOAD_DIR/SHA256SUMS" ]]; then
  echo "Fehler: SHA256SUMS fehlt." >&2
  exit 1
fi

(
  cd "$PAYLOAD_DIR"
  sha256sum -c SHA256SUMS
)

if command -v sqlite3 >/dev/null 2>&1; then
  DB_PATH="$PAYLOAD_DIR/database/echolink.db"

  if [[ -f "$DB_PATH" ]]; then
    DB_CHECK="$(
      sqlite3 "$DB_PATH" 'PRAGMA integrity_check;'
    )"

    if [[ "$DB_CHECK" != "ok" ]]; then
      echo "Fehler: Wiederhergestellte DB ist beschädigt: $DB_CHECK" >&2
      exit 1
    fi
  fi
fi

echo
echo "Backup erfolgreich geprüft und entpackt:"
echo "$PAYLOAD_DIR"
echo
echo "Die laufende EchoLink-Installation wurde nicht verändert."
