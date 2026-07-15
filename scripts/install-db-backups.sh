#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"

cd "$ROOT_DIR"

chmod 750 scripts/backup-db.sh

if ! grep -q 'scripts/backup-db.sh" deploy' scripts/deploy.sh; then
  git apply patches/deploy-db-backup.patch
fi

install -m 0644 \
  systemd/echolink-db-backup.service \
  /etc/systemd/system/echolink-db-backup.service

install -m 0644 \
  systemd/echolink-db-backup.timer \
  /etc/systemd/system/echolink-db-backup.timer

systemctl daemon-reload
systemctl enable --now echolink-db-backup.timer

scripts/backup-db.sh daily

echo
echo "EchoLink-Datenbank-Backups sind eingerichtet."
echo "Backup-Verzeichnis: /root/echolink-backups/database"
