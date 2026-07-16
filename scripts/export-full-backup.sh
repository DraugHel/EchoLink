#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"

DB_PATH="${ECHOLINK_DB_PATH:-$ROOT_DIR/data/echolink.db}"
UPLOADS_DIR="${ECHOLINK_UPLOADS_DIR:-$ROOT_DIR/data/uploads}"
EXPORT_DIR="${ECHOLINK_EXPORT_DIR:-/root/echolink-backups/export}"
PBKDF2_ITERATIONS="${ECHOLINK_BACKUP_ITERATIONS:-250000}"

for command in sqlite3 tar openssl sha256sum mktemp; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Fehler: $command ist nicht installiert." >&2
    exit 1
  fi
done

if [[ ! -f "$DB_PATH" ]]; then
  echo "Fehler: Datenbank nicht gefunden: $DB_PATH" >&2
  exit 1
fi

if [[ ! -d "$UPLOADS_DIR" ]]; then
  echo "Fehler: Upload-Ordner nicht gefunden: $UPLOADS_DIR" >&2
  exit 1
fi

mkdir -p "$EXPORT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASENAME="echolink-full-$STAMP"
FINAL_PATH="$EXPORT_DIR/$BASENAME.tar.gz.enc"
FINAL_CHECKSUM="$FINAL_PATH.sha256"

WORK_DIR="$(mktemp -d)"
PLAIN_ARCHIVE="$WORK_DIR/$BASENAME.tar.gz"
PAYLOAD_DIR="$WORK_DIR/$BASENAME"
TEMP_ENCRYPTED="$WORK_DIR/$BASENAME.tar.gz.enc"

cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p \
  "$PAYLOAD_DIR/database" \
  "$PAYLOAD_DIR/uploads"

DB_COPY="$PAYLOAD_DIR/database/echolink.db"

sqlite3 "$DB_PATH" \
  ".timeout 10000" \
  ".backup '$DB_COPY'"

CHECK_RESULT="$(
  sqlite3 "$DB_COPY" 'PRAGMA integrity_check;'
)"

if [[ "$CHECK_RESULT" != "ok" ]]; then
  echo "Fehler: Datenbankprüfung fehlgeschlagen: $CHECK_RESULT" >&2
  exit 1
fi

cp -a "$UPLOADS_DIR/." "$PAYLOAD_DIR/uploads/"

cat > "$PAYLOAD_DIR/backup-info.txt" <<INFO
EchoLink Komplett-Backup
Erstellt UTC: $STAMP
Datenbank: data/echolink.db
Uploads: data/uploads
Verschlüsselung: AES-256-CBC
Schlüsselableitung: PBKDF2
PBKDF2-Iterationen: $PBKDF2_ITERATIONS
INFO

(
  cd "$PAYLOAD_DIR"
  find . -type f \
    ! -name SHA256SUMS \
    -print0 |
    sort -z |
    xargs -0 sha256sum > SHA256SUMS
)

tar \
  --create \
  --gzip \
  --file "$PLAIN_ARCHIVE" \
  --directory "$WORK_DIR" \
  "$BASENAME"

echo
echo "Vergib jetzt ein starkes Backup-Passwort."
echo "Das Passwort wird nicht gespeichert."
echo

read -r -s -p "Passwort: " BACKUP_PASSWORD
echo
read -r -s -p "Passwort wiederholen: " BACKUP_PASSWORD_CONFIRM
echo

if [[ "$BACKUP_PASSWORD" != "$BACKUP_PASSWORD_CONFIRM" ]]; then
  unset BACKUP_PASSWORD BACKUP_PASSWORD_CONFIRM
  echo "Fehler: Die Passwörter stimmen nicht überein." >&2
  exit 1
fi

if (( ${#BACKUP_PASSWORD} < 12 )); then
  unset BACKUP_PASSWORD BACKUP_PASSWORD_CONFIRM
  echo "Fehler: Das Passwort muss mindestens 12 Zeichen lang sein." >&2
  exit 1
fi

unset BACKUP_PASSWORD_CONFIRM

openssl enc \
  -aes-256-cbc \
  -salt \
  -pbkdf2 \
  -iter "$PBKDF2_ITERATIONS" \
  -pass fd:3 \
  -in "$PLAIN_ARCHIVE" \
  -out "$TEMP_ENCRYPTED" \
  3<<<"$BACKUP_PASSWORD"

openssl enc \
  -d \
  -aes-256-cbc \
  -pbkdf2 \
  -iter "$PBKDF2_ITERATIONS" \
  -pass fd:3 \
  -in "$TEMP_ENCRYPTED" \
  -out "$WORK_DIR/verify.tar.gz" \
  3<<<"$BACKUP_PASSWORD"

unset BACKUP_PASSWORD

tar -tzf "$WORK_DIR/verify.tar.gz" >/dev/null

mv "$TEMP_ENCRYPTED" "$FINAL_PATH"
(cd "$EXPORT_DIR" && sha256sum "$(basename "$FINAL_PATH")" > "$(basename "$FINAL_CHECKSUM")")

chmod 600 "$FINAL_PATH" "$FINAL_CHECKSUM"

echo
echo "Komplett-Backup erstellt:"
echo "$FINAL_PATH"
echo
echo "Prüfsumme:"
echo "$FINAL_CHECKSUM"
echo
echo "Beide Dateien auf einen anderen Rechner kopieren."
echo "Ohne das Passwort ist das Backup nicht wiederherstellbar."
