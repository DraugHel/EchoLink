#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly REPO="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"
readonly LOCK=/var/lock/echolink-e3-validation-images.lock
readonly DOCKER=/usr/bin/docker
readonly MODE=${1:---dry-run}

LOCK_FD=9
RECLAIMED_BYTES=0
REMOVED_COUNT=0
WOULD_REMOVE_COUNT=0

fail() {
  printf 'FEHLER: %s\n' "$*" >&2
  exit 1
}

canonical() {
  readlink -m -- "$1"
}

directory_bytes() {
  du -sb -- "$1" 2>/dev/null |
    awk '{print $1}'
}

assert_inactive() {
  [[ $EUID -eq 0 ]] || fail 'Root-Operatorlauf erforderlich'
  [[ -d "$REPO/.git" ]] || fail 'EchoLink-Repository fehlt'
  [[ -x "$DOCKER" ]] || fail 'Docker fehlt'
  "$DOCKER" version >/dev/null 2>&1 ||
    fail 'Docker-Daemon ist nicht erreichbar'

  exec {LOCK_FD}>"$LOCK"
  flock -n "$LOCK_FD" ||
    fail 'Konkurrierender E3-Validatorlauf erkannt'

  [[ -z "$(
    "$DOCKER" ps -a \
      --filter 'label=echolink.e3.run' \
      --format '{{.ID}}'
  )" ]] || fail 'E3-Container vorhanden'

  [[ -z "$(
    "$DOCKER" network ls \
      --filter 'label=echolink.e3.run' \
      --format '{{.ID}}'
  )" ]] || fail 'E3-Netzwerk vorhanden'

  [[ -z "$(
    "$DOCKER" ps -a \
      --filter 'label=echolink.e3.validator' \
      --format '{{.ID}}'
  )" ]] || fail 'E3-Validatorcontainer vorhanden'

  if systemctl list-units \
      --type=service \
      --state=activating,running \
      'echolink-e3-validator-rebind-*' \
      --no-legend \
      --no-pager |
      grep -q .; then
    fail 'Aktiver E3-Rebind-Systemdienst erkannt'
  fi
}

assert_safe_directory() {
  local target=$1 kind=$2
  [[ -d "$target" ]] || fail "Verzeichnis fehlt: $target"
  [[ ! -L "$target" ]] || fail "Symlink wird nicht entfernt: $target"
  [[ "$(canonical "$target")" == "$target" ]] ||
    fail "Nichtkanonischer Pfad: $target"
  [[ "$(stat -c '%u:%g' -- "$target")" == 0:0 ]] ||
    fail "Falscher Eigentümer: $target"

  case "$kind" in
    context)
      [[ "$target" == /tmp/e3-validation-images.* ]] ||
        fail "Ungültiger Kontextpfad: $target"
      ;;
    work)
      [[ "$target" == /var/tmp/echolink-e3-validator-rebind.* ]] ||
        fail "Ungültiger Arbeitsroot: $target"
      ;;
    smoke)
      [[ "$target" =~ ^/root/echolink-patch-backups/e3-validation-smoke-[A-Za-z0-9]{6,32}$ ]] ||
        fail "Ungültiger Smoke-Root: $target"
      ;;
    *)
      fail "Unbekannter Cleanup-Typ: $kind"
      ;;
  esac
}

remove_directory() {
  local target=$1 kind=$2 bytes
  assert_safe_directory "$target" "$kind"
  bytes=$(directory_bytes "$target")
  [[ "$bytes" =~ ^[0-9]+$ ]] || bytes=0

  if [[ "$MODE" == --dry-run ]]; then
    printf 'WOULD_REMOVE=%s BYTES=%s\n' "$target" "$bytes"
    WOULD_REMOVE_COUNT=$((WOULD_REMOVE_COUNT + 1))
    return
  fi

  find -P -- "$target" -depth -mindepth 1 -delete
  rmdir -- "$target"
  printf 'REMOVED=%s BYTES=%s\n' "$target" "$bytes"
  RECLAIMED_BYTES=$((RECLAIMED_BYTES + bytes))
  REMOVED_COUNT=$((REMOVED_COUNT + 1))
}

remove_regular_file() {
  local target=$1
  [[ -e "$target" ]] || return 0
  [[ -f "$target" && ! -L "$target" ]] ||
    fail "Unsichere temporäre Datei: $target"
  [[ "$(canonical "$target")" == "$target" ]] ||
    fail "Nichtkanonische temporäre Datei: $target"
  [[ "$(stat -c '%u:%g:%h' -- "$target")" == 0:0:1 ]] ||
    fail "Unsichere Identität der temporären Datei: $target"

  local bytes
  bytes=$(stat -c '%s' -- "$target")

  if [[ "$MODE" == --dry-run ]]; then
    printf 'WOULD_REMOVE=%s BYTES=%s\n' "$target" "$bytes"
    WOULD_REMOVE_COUNT=$((WOULD_REMOVE_COUNT + 1))
    return
  fi

  rm -f -- "$target"
  printf 'REMOVED=%s BYTES=%s\n' "$target" "$bytes"
  RECLAIMED_BYTES=$((RECLAIMED_BYTES + bytes))
  REMOVED_COUNT=$((REMOVED_COUNT + 1))
}

main() {
  [[ "$MODE" == --dry-run || "$MODE" == --apply ]] ||
    fail 'Verwendung: SCRIPT [--dry-run | --apply]'

  assert_inactive

  shopt -s nullglob

  local target
  for target in /tmp/e3-validation-images.*; do
    remove_directory "$target" context
  done

  for target in /var/tmp/echolink-e3-validator-rebind.*; do
    remove_directory "$target" work
  done

  for target in \
    /root/echolink-patch-backups/e3-validation-smoke-*; do
    remove_directory "$target" smoke
  done

  remove_regular_file /tmp/echolink-e3-validator-rebind.sh
  remove_regular_file /tmp/echolink-e3-validator-rebind.latest.log
  remove_regular_file /root/echolink-e3-validator-rebind.last-unit

  if [[ "$MODE" == --dry-run ]]; then
    printf 'E3_RESIDUE_CLEANUP_DRY_RUN=1\n'
    printf 'WOULD_REMOVE_COUNT=%s\n' "$WOULD_REMOVE_COUNT"
  else
    printf 'E3_RESIDUE_CLEANUP_SUCCESS=1\n'
    printf 'REMOVED_COUNT=%s\n' "$REMOVED_COUNT"
    printf 'RECLAIMED_BYTES=%s\n' "$RECLAIMED_BYTES"
  fi
}

main
