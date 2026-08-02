#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Repository-owned operator tool for keeping the E3 validator manifest and
# immutable images bound to the exact current clean main commit.

readonly REPO="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"
readonly DOCKER=/usr/bin/docker
readonly STATE=/var/lib/echolink-e3
readonly MANIFEST="$STATE/validation-images.json"
readonly LOCK=/var/lock/echolink-e3-validation-images.lock
CURRENT_HEAD=''
CURRENT_TREE=''
TREE_TAG=''
NODE_TAG=''
PLAYWRIGHT_TAG=''
readonly NODE_BASE='node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d'
readonly PLAYWRIGHT_BASE='mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48'

WORK_ROOT=''
CONTEXT_ROOT=''
SMOKE_ROOT=''
ACTIVE_TMP=''
ROLLBACK_TMP=''
LOCK_FD=9
BACKUP_MANIFEST=''
ACTIVE_SWITCHED=0
ROLLBACK_SWITCHED=0

fail() { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Benötigtes Programm fehlt: $1"; }

create_checked_dir() {
  local template=$1 expected_regex=$2 output_var=$3
  local created
  created=$(mktemp -d -- "$template")
  printf -v "$output_var" '%s' "$created"
  chmod 0700 -- "$created"
  [[ "$created" == "$(readlink -m -- "$created")" ]] || fail "Temporärer Root ist nicht kanonisch: $created"
  [[ "$created" =~ $expected_regex ]] || fail "Temporärer Root hat ein unerwartetes Format: $created"
  [[ "$(stat -c '%u:%g:%a' -- "$created")" == '0:0:700' ]] || fail "Temporärer Root hat nicht root:root 0700: $created"
}

create_checked_smoke_dir() {
  local output_var=$1
  local base=/root/echolink-patch-backups nonce candidate attempt
  for attempt in {1..32}; do
    nonce=$(od -An -N6 -tx1 /dev/urandom | tr -d '[:space:]')
    [[ "$nonce" =~ ^[0-9a-f]{12}$ ]] || fail "Ungültiger Smoke-Nonce: $nonce"
    candidate="$base/e3-validation-smoke-$nonce"
    [[ ! -e "$candidate" ]] || continue
    if ! mkdir -- "$candidate" 2>/dev/null; then
      continue
    fi
    printf -v "$output_var" '%s' "$candidate"
    chmod 0700 -- "$candidate"
    [[ "$candidate" == "$(readlink -m -- "$candidate")" ]] || fail "Smoke-Root ist nicht kanonisch: $candidate"
    [[ "$candidate" =~ ^/root/echolink-patch-backups/e3-validation-smoke-[0-9a-f]{12}$ ]] || fail "Smoke-Root hat ein unerwartetes Format: $candidate"
    [[ "$(stat -c '%u:%g:%a' -- "$candidate")" == '0:0:700' ]] || fail "Smoke-Root hat nicht root:root 0700: $candidate"
    return 0
  done
  fail 'Konnte keinen kollisionsfreien Smoke-Root mit 12-stelligem Hex-Nonce erzeugen'
}

safe_unlink_current_temp() {
  local target=$1 expected=$2
  [[ -n "$target" && "$target" == "$expected" ]] || fail "Unsicherer temporärer Dateipfad: $target"
  [[ "$target" == "$STATE/.validation-images.json.rebind-"*.tmp || "$target" == "$STATE/.validation-images.json.rollback-"*.tmp ]] || fail "Temporäre Manifestdatei liegt außerhalb des erlaubten Musters: $target"
  [[ "$(dirname -- "$target")" == "$STATE" ]] || fail "Temporäre Manifestdatei liegt nicht im E3-State-Root: $target"
  [[ ! -e "$target" ]] || rm -f -- "$target"
}

safe_remove_dir() {
  local target=$1 pattern=$2
  [[ -n "$target" && -d "$target" ]] || return 0
  canonical_path "$target"
  case "$pattern" in
    work) [[ "$target" == /var/tmp/echolink-e3-validator-rebind.* ]] || fail "Unsicherer Arbeitsroot: $target" ;;
    context) [[ "$target" == /tmp/e3-validation-images.* ]] || fail "Unsicherer Builder-Root: $target" ;;
    smoke) [[ "$target" =~ ^/root/echolink-patch-backups/e3-validation-smoke-[0-9a-f]{12}$ ]] || fail "Unsicherer Smoke-Root: $target" ;;
    *) fail "Unbekannter Cleanup-Scope: $pattern" ;;
  esac
  find -P -- "$target" -depth -mindepth 1 -delete
  rmdir -- "$target"
}

safe_work_cleanup() {
  local status=${1:-0} cleanup_status=0
  if [[ -n "${ACTIVE_TMP:-}" && -e "$ACTIVE_TMP" ]]; then
    if ! safe_unlink_current_temp "$ACTIVE_TMP" "$STATE/.validation-images.json.rebind-$$.tmp"; then
      cleanup_status=1
    fi
  fi
  if [[ -n "${ROLLBACK_TMP:-}" && -e "$ROLLBACK_TMP" ]]; then
    if ! safe_unlink_current_temp "$ROLLBACK_TMP" "$STATE/.validation-images.json.rollback-$$.tmp"; then
      cleanup_status=1
    fi
  fi
  if ! safe_remove_dir "${SMOKE_ROOT:-}" smoke; then
    cleanup_status=1
  fi
  if ! safe_remove_dir "${CONTEXT_ROOT:-}" context; then
    cleanup_status=1
  fi
  if ! safe_remove_dir "${WORK_ROOT:-}" work; then
    cleanup_status=1
  fi
  return "$cleanup_status"
}

rollback_active_manifest() {
  local backup=$1
  local tmp="$STATE/.validation-images.json.rollback-$$.tmp"
  ROLLBACK_TMP="$tmp"
  (canonical_path "$backup") || {
    printf 'Rollback-Backup ist nicht kanonisch: %s\n' "$backup" >&2
    return 1
  }
  [[ "$backup" == "$STATE/validation-images.rollback-"*.json ]] || { printf 'Rollback-Backup liegt nicht im kanonischen E3-State-Root: %s\n' "$backup" >&2; return 1; }
  (check_manifest_file "$backup") || {
    printf 'Rollback-Backup ist nicht sicher geprüft: %s\n' "$backup" >&2
    return 1
  }
  [[ ! -e "$tmp" ]] || { printf 'Rollback-Temporärdatei existiert bereits: %s\n' "$tmp" >&2; return 1; }
  install -o 0 -g 0 -m 0640 -- "$backup" "$tmp" || return 1
  (check_manifest_file "$tmp") || {
    printf 'Rollback-Temporärdatei ist nicht sicher geprüft: %s\n' "$tmp" >&2
    return 1
  }
  python3 - "$tmp" "$MANIFEST" <<'PY'
import os, sys
src, dst = sys.argv[1:]
fd = os.open(src, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
dirfd = os.open(os.path.dirname(dst), os.O_RDONLY)
try:
    os.fsync(dirfd)
finally:
    os.close(dirfd)
os.replace(src, dst)
PY
  ROLLBACK_SWITCHED=1
  python3 - "$MANIFEST" <<'PY'
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
dirfd = os.open(os.path.dirname(sys.argv[1]), os.O_RDONLY)
try:
    os.fsync(dirfd)
finally:
    os.close(dirfd)
PY
  (check_manifest_file "$MANIFEST") || {
    printf 'Rollback-Zielmanifest ist nicht sicher geprüft: %s\n' "$MANIFEST" >&2
    return 1
  }
  cmp -s -- "$backup" "$MANIFEST" || { printf 'Rollback-Manifest stimmt nicht exakt mit Backup überein: %s -> %s\n' "$backup" "$MANIFEST" >&2; return 1; }
  ROLLBACK_TMP=''
  ROLLBACK_SWITCHED=0
  ACTIVE_SWITCHED=0
  return 0
}

on_exit() {
  local status=$?
  trap - EXIT
  if (( status != 0 && ACTIVE_SWITCHED == 1 )); then
    printf 'FEHLER: Aktivierung war erfolgreich; automatischer Rollback von %s nach %s wird versucht.\n' "$MANIFEST" "$BACKUP_MANIFEST" >&2
    if rollback_active_manifest "$BACKUP_MANIFEST"; then
      printf 'ROLLBACK_SUCCESS=%s\n' "$MANIFEST" >&2
    else
      printf 'KRITISCHER FEHLER: Rollback fehlgeschlagen; aktives Manifest und Backup: %s ; %s\n' "$MANIFEST" "$BACKUP_MANIFEST" >&2
      status=2
    fi
  fi
  if ! safe_work_cleanup "$status"; then
    printf 'KRITISCHER FEHLER: Cleanup fehlgeschlagen; Arbeitsroots: %s ; %s ; %s\n' "${WORK_ROOT:-unbekannt}" "${CONTEXT_ROOT:-unbekannt}" "${SMOKE_ROOT:-unbekannt}" >&2
    status=2
  fi
  if (( status != 0 )); then
    if (( ACTIVE_SWITCHED == 1 || ROLLBACK_SWITCHED == 1 )); then
      printf 'ABBRUCH: aktives Manifest konnte nicht zurückgesetzt werden; Pfade: %s ; %s\n' "$MANIFEST" "$BACKUP_MANIFEST" >&2
    else
      printf 'ABBRUCH: aktives Manifest blieb unverändert: %s\n' "$MANIFEST" >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

canonical_path() {
  local path=$1
  [[ "$path" == /* ]] || fail "Pfad ist nicht absolut: $path"
  [[ "$path" == "$(readlink -m -- "$path")" ]] || fail "Pfad ist nicht kanonisch: $path"
}

check_repo() {
  local head tree remote
  [[ "$(id -u)" == 0 ]] || fail 'Root-Operatorlauf erforderlich'
  [[ -d "$REPO/.git" ]] || fail 'EchoLink-Git-Repository fehlt'
  [[ "$(git -C "$REPO" branch --show-current)" == main ]] || fail 'Branch ist nicht main'
  [[ -z "$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)" ]] || fail 'Working Tree ist nicht sauber'
  [[ -z "$(git -C "$REPO" diff --cached --name-only)" ]] || fail 'Staged Änderungen sind nicht erlaubt'

  git -C "$REPO" fetch --quiet origin main
  head=$(git -C "$REPO" rev-parse HEAD)
  tree=$(git -C "$REPO" rev-parse 'HEAD^{tree}')
  remote=$(git -C "$REPO" rev-parse origin/main)

  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || fail 'HEAD ist ungültig'
  [[ "$tree" =~ ^[0-9a-f]{40}$ ]] || fail 'HEAD-Tree ist ungültig'
  [[ "$remote" == "$head" ]] || fail 'origin/main weicht von HEAD ab'

  CURRENT_HEAD=$head
  CURRENT_TREE=$tree
  TREE_TAG=${CURRENT_TREE:0:12}
  NODE_TAG="echolink-e3-node-validator:$TREE_TAG"
  PLAYWRIGHT_TAG="echolink-e3-playwright-validator:$TREE_TAG"

  printf 'CURRENT_HEAD=%s\n' "$CURRENT_HEAD"
  printf 'CURRENT_TREE=%s\n' "$CURRENT_TREE"
  printf 'NODE_TAG=%s\n' "$NODE_TAG"
  printf 'PLAYWRIGHT_TAG=%s\n' "$PLAYWRIGHT_TAG"
}

check_runtime_safety() {
  [[ -d "$STATE" && "$(readlink -m -- "$STATE")" == "$STATE" ]] || fail 'E3-State-Root fehlt oder ist nicht kanonisch'
  [[ -f "$MANIFEST" ]] || fail 'Aktives Manifest fehlt'
  [[ -x "$DOCKER" ]] || fail 'Gepinnter Docker-Pfad fehlt'
  "$DOCKER" version >/dev/null 2>&1 || fail 'Docker-Daemon ist nicht erreichbar'
  [[ "$(uname -m)" == x86_64 ]] || fail 'Host ist nicht x86_64'
  exec {LOCK_FD}>"$LOCK"
  flock -n "$LOCK_FD" || fail 'Konkurrierender Validator-Lauf erkannt'
  [[ -z "$($DOCKER ps -a --filter 'label=echolink.e3.run' --format '{{.ID}}')" ]] || fail 'E3-Container vorhanden'
  [[ -z "$($DOCKER network ls --filter 'label=echolink.e3.run' --format '{{.ID}}')" ]] || fail 'E3-Netzwerk vorhanden'
  [[ -z "$($DOCKER ps -a --filter 'label=echolink.e3.validator' --format '{{.ID}}')" ]] || fail 'Validator-Container vorhanden'
}

check_manifest_file() {
  local path=$1
  canonical_path "$path"
  local real mode owner links
  real=$(readlink -f -- "$path")
  mode=$(stat -c '%a' -- "$path")
  owner=$(stat -c '%u:%g' -- "$path")
  links=$(stat -c '%h' -- "$path")
  [[ "$real" == "$path" && "$mode" == 640 && "$owner" == 0:0 && "$links" == 1 ]] || fail "Unsicheres Manifest: $path"
  sha256sum -- "$path" >/dev/null
}

manifest_is_current() {
  local values source_head source_tree source_tree_sha
  local manifest_node_tag manifest_node_digest
  local manifest_playwright_tag manifest_playwright_digest

  if ! values=$(
    node --input-type=module - "$MANIFEST" "$CURRENT_TREE" <<'NODE'
import {
  loadValidationImageManifest
} from '/root/echolink/server/e3/validation/imageManifest.js'

const [manifestPath, expectedTree] = process.argv.slice(2)
const manifest = loadValidationImageManifest({
  manifestPath,
  expectedSourceTreeGitSha: expectedTree
})

for (const value of [
  manifest.sourceHead,
  manifest.sourceTreeGitSha,
  manifest.sourceTreeSha256,
  manifest.nodeImageTag,
  manifest.nodeImageDigest,
  manifest.playwrightImageTag,
  manifest.playwrightImageDigest
]) {
  console.log(value)
}
NODE
  2>/dev/null); then
    return 1
  fi

  mapfile -t fields <<<"$values"
  [[ "${#fields[@]}" -eq 7 ]] || return 1

  source_head=${fields[0]}
  source_tree=${fields[1]}
  source_tree_sha=${fields[2]}
  manifest_node_tag=${fields[3]}
  manifest_node_digest=${fields[4]}
  manifest_playwright_tag=${fields[5]}
  manifest_playwright_digest=${fields[6]}

  [[ "$source_head" == "$CURRENT_HEAD" ]] || return 1
  [[ "$source_tree" == "$CURRENT_TREE" ]] || return 1
  [[ "$source_tree_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ "$manifest_node_tag" == "$NODE_TAG" ]] || return 1
  [[ "$manifest_playwright_tag" == "$PLAYWRIGHT_TAG" ]] || return 1

  SOURCE_TREE_SHA256=$source_tree_sha
  export SOURCE_TREE_SHA256

  "$DOCKER" image inspect "$NODE_TAG" >/dev/null 2>&1 ||
    return 1
  "$DOCKER" image inspect "$PLAYWRIGHT_TAG" >/dev/null 2>&1 ||
    return 1

  verify_image "$NODE_TAG" node-validator || return 1
  verify_image "$PLAYWRIGHT_TAG" playwright-validator || return 1

  [[ "$(
    "$DOCKER" image inspect --format '{{.Id}}' "$NODE_TAG"
  )" == "$manifest_node_digest" ]] || return 1

  [[ "$(
    "$DOCKER" image inspect --format '{{.Id}}' "$PLAYWRIGHT_TAG"
  )" == "$manifest_playwright_digest" ]] || return 1

  return 0
}

prepare_state() {
  local stamp
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  BACKUP_MANIFEST="$STATE/validation-images.rollback-$stamp.json"
  [[ ! -e "$BACKUP_MANIFEST" ]] || fail 'Backup-Ziel existiert bereits'
  check_manifest_file "$MANIFEST"
  install -o 0 -g 0 -m 0640 -- "$MANIFEST" "$BACKUP_MANIFEST"
  check_manifest_file "$BACKUP_MANIFEST"
  [[ "$(sha256sum "$MANIFEST" | awk '{print $1}')" == "$(sha256sum "$BACKUP_MANIFEST" | awk '{print $1}')" ]] || fail 'Manifest-Backup-Hash stimmt nicht'
}

build_context() {
  local context="$CONTEXT_ROOT" source_manifest="$WORK_ROOT/source-manifest.bin"
  canonical_path "$context"
  [[ -d "$context" ]] || fail "Builder-Root fehlt: $context"
  [[ "$(stat -c '%u:%g:%a' -- "$context")" == '0:0:700' ]] || fail "Builder-Root hat nicht root:root 0700: $context"
  [[ -z "$(find -P -- "$context" -mindepth 1 -print -quit)" ]] || fail "Builder-Root ist vor Materialisierung nicht leer: $context"
  git -C "$REPO" archive --format=tar "$CURRENT_HEAD" | tar -x -C "$context"
  CONTEXT_ROOT="$context" SOURCE_MANIFEST="$source_manifest" python3 - <<'PY'
import hashlib, os, stat
from pathlib import Path
root=Path(os.environ['CONTEXT_ROOT']).resolve(); output=Path(os.environ['SOURCE_MANIFEST'])
forbidden={'.env','data','dist','node_modules','uploads','backups'}
records=bytearray()
for path in sorted(root.rglob('*')):
    rel=path.relative_to(root).as_posix()
    if rel.split('/',1)[0] in forbidden: raise SystemExit(f'Verbotener Build-Kontextpfad: {rel}')
    st=path.lstat(); mode=st.st_mode & 0o7777
    if path.is_symlink(): raise SystemExit(f'Symlink im Build-Kontext: {rel}')
    if path.is_file(): kind=b'F'; payload=path.read_bytes()
    elif path.is_dir(): kind=b'D'; payload=b''
    else: raise SystemExit(f'Unsicherer Build-Kontexteintrag: {rel}')
    records.extend(kind); records.extend(f'{mode:o}'.encode()); records.extend(b'\0'); records.extend(rel.encode()); records.extend(b'\0'); records.extend(str(len(payload)).encode()); records.extend(b'\0'); records.extend(payload); records.extend(b'\0')
output.write_bytes(records)
print(hashlib.sha256(records).hexdigest())
PY
  [[ "$(git -C "$REPO" rev-parse 'HEAD^{tree}')" == "$CURRENT_TREE" ]] || fail 'Repository änderte sich beim Kontextbau'
  SOURCE_TREE_SHA256=$(sha256sum "$source_manifest" | awk '{print $1}')
  export CONTEXT_ROOT SOURCE_MANIFEST SOURCE_TREE_SHA256
}

build_images_and_manifest() {
  local common=(--pull --no-cache --build-arg "E3_SOURCE_HEAD=$CURRENT_HEAD" --build-arg "E3_SOURCE_TREE_GIT_SHA=$CURRENT_TREE" --build-arg "E3_SOURCE_TREE_SHA256=$SOURCE_TREE_SHA256")
  if "$DOCKER" image inspect "$NODE_TAG" >/dev/null 2>&1; then
    printf 'Vorhandenes Node-Image gefunden; vollständige Identitäts- und Runtime-Prüfung: %s\n' "$NODE_TAG"
    verify_image "$NODE_TAG" node-validator
  else
    "$DOCKER" build "${common[@]}" --file "$CONTEXT_ROOT/docker/e3-validation/node.Dockerfile" --tag "$NODE_TAG" "$CONTEXT_ROOT"
  fi
  if "$DOCKER" image inspect "$PLAYWRIGHT_TAG" >/dev/null 2>&1; then
    printf 'Vorhandenes Playwright-Image gefunden; vollständige Identitäts- und Runtime-Prüfung: %s\n' "$PLAYWRIGHT_TAG"
    verify_image "$PLAYWRIGHT_TAG" playwright-validator
  else
    "$DOCKER" build "${common[@]}" --file "$CONTEXT_ROOT/docker/e3-validation/playwright.Dockerfile" --tag "$PLAYWRIGHT_TAG" "$CONTEXT_ROOT"
  fi
  NODE_DIGEST=$("$DOCKER" image inspect --format '{{.Id}}' "$NODE_TAG")
  PLAYWRIGHT_DIGEST=$("$DOCKER" image inspect --format '{{.Id}}' "$PLAYWRIGHT_TAG")
  [[ "$NODE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ && "$PLAYWRIGHT_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Neue Image-Digests sind ungültig'
  export NODE_DIGEST PLAYWRIGHT_DIGEST
  NEW_MANIFEST="$WORK_ROOT/validation-images.json"
  node "$REPO/scripts/e3-write-validation-image-manifest.mjs" "$NEW_MANIFEST" "$CURRENT_HEAD" "$CURRENT_TREE" "$SOURCE_TREE_SHA256" "$NODE_DIGEST" "$PLAYWRIGHT_DIGEST" "$NODE_TAG" "$PLAYWRIGHT_TAG" "$CONTEXT_ROOT"
  check_manifest_file "$NEW_MANIFEST"
}

verify_image() {
  local tag=$1 role=$2
  [[ "$($DOCKER image inspect --format '{{index .Config.Labels "echolink.e3.image-role"}}' "$tag")" == "$role" ]] || fail "Falsche Image-Rolle: $tag"
  [[ "$($DOCKER image inspect --format '{{index .Config.Labels "echolink.e3.source-head"}}' "$tag")" == "$CURRENT_HEAD" ]] || fail "Falscher source-head: $tag"
  [[ "$($DOCKER image inspect --format '{{index .Config.Labels "echolink.e3.source-tree-git-sha"}}' "$tag")" == "$CURRENT_TREE" ]] || fail "Falscher source-tree-git-sha: $tag"
  [[ "$($DOCKER image inspect --format '{{index .Config.Labels "echolink.e3.source-tree-sha256"}}' "$tag")" == "$SOURCE_TREE_SHA256" ]] || fail "Falscher source-tree-sha256: $tag"
  [[ "$($DOCKER image inspect --format '{{.Config.User}}' "$tag")" == 65532:65532 ]] || fail "Falscher Container-User: $tag"
  [[ "$($DOCKER image inspect --format '{{.Os}}/{{.Architecture}}' "$tag")" == linux/amd64 ]] || fail "Falsche Plattform: $tag"
  [[ "$($DOCKER run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --security-opt apparmor=docker-default --user 65532:65532 --entrypoint /usr/bin/node "$tag" --version)" == v24.18.0 ]] || fail "Runtime-Prüfung fehlgeschlagen: $tag"
}

validate_and_smoke() {
  node --input-type=module - \
    "$WORK_ROOT/validation-images.json" \
    "$CURRENT_HEAD" \
    "$CURRENT_TREE" \
    "$SOURCE_TREE_SHA256" \
    "$NODE_TAG" \
    "$PLAYWRIGHT_TAG" <<'NODE'
import fs from 'node:fs'
import {
  loadValidationImageManifest
} from '/root/echolink/server/e3/validation/imageManifest.js'

const [
  manifestPath,
  head,
  tree,
  treeSha,
  nodeTag,
  playwrightTag
] = process.argv.slice(2)

const m = loadValidationImageManifest({
  manifestPath,
  expectedSourceTreeGitSha: tree,
  expectedSourceTreeSha256: treeSha
})

if (m.sourceHead !== head) throw new Error('sourceHead mismatch')
if (m.nodeImageTag !== nodeTag) throw new Error('node tag mismatch')
if (m.playwrightImageTag !== playwrightTag) {
  throw new Error('playwright tag mismatch')
}
if (fs.realpathSync.native(manifestPath) !== manifestPath) {
  throw new Error('manifest path is not canonical')
}
NODE
  verify_image "$NODE_TAG" node-validator
  verify_image "$PLAYWRIGHT_TAG" playwright-validator
  create_checked_smoke_dir SMOKE_ROOT
  local smoke_root="$SMOKE_ROOT" snapshot_root="$SMOKE_ROOT/snapshots" snapshot="$SMOKE_ROOT/snapshots/source/snapshot" outputs="$SMOKE_ROOT/outputs"
  mkdir -m 0700 -p -- "$snapshot" "$outputs"
  cp -a -- "$CONTEXT_ROOT/." "$snapshot/"
  find -P -- "$snapshot" -type d -exec chmod 0555 -- {} +
  find -P -- "$snapshot" -type f -exec chmod 0444 -- {} +
  node "$REPO/scripts/e3-validation-image-smoke.mjs" "$WORK_ROOT/validation-images.json" "$snapshot_root" "$snapshot" "$outputs"
  [[ -z "$($DOCKER ps -a --filter 'label=echolink.e3.run' --format '{{.ID}}')" ]] || fail 'E3-Container blieb nach Smoke zurück'
  [[ -z "$($DOCKER network ls --filter 'label=echolink.e3.run' --format '{{.ID}}')" ]] || fail 'E3-Netzwerk blieb nach Smoke zurück'
}

activate() {
  ACTIVE_TMP="$STATE/.validation-images.json.rebind-$$.tmp"
  [[ ! -e "$ACTIVE_TMP" ]] || fail "Aktive temporäre Manifestdatei existiert bereits: $ACTIVE_TMP"
  install -o 0 -g 0 -m 0640 -- "$WORK_ROOT/validation-images.json" "$ACTIVE_TMP"
  check_manifest_file "$ACTIVE_TMP"
  python3 - "$ACTIVE_TMP" "$MANIFEST" <<'PY'
import os, sys
src, dst = sys.argv[1:]
fd = os.open(src, os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
dirfd = os.open(os.path.dirname(dst), os.O_RDONLY)
try:
    os.fsync(dirfd)
finally:
    os.close(dirfd)
os.replace(src, dst)
PY
  ACTIVE_SWITCHED=1
  python3 - "$MANIFEST" <<'PY'
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
dirfd = os.open(os.path.dirname(sys.argv[1]), os.O_RDONLY)
try:
    os.fsync(dirfd)
finally:
    os.close(dirfd)
PY
  check_manifest_file "$MANIFEST"
  ACTIVE_TMP=''
}

verify_after() {
  [[ "$(sha256sum "$BACKUP_MANIFEST" | awk '{print $1}')" == "$OLD_MANIFEST_SHA" ]] || fail 'Altes Manifest-Backup wurde verändert'
  [[ "$($DOCKER image inspect --format '{{.Id}}' "$OLD_NODE_TAG")" == "$OLD_NODE_DIGEST" ]] || fail 'Altes Node-Image wurde verändert'
  [[ "$($DOCKER image inspect --format '{{.Id}}' "$OLD_PLAYWRIGHT_TAG")" == "$OLD_PLAYWRIGHT_DIGEST" ]] || fail 'Altes Playwright-Image wurde verändert'
  node --input-type=module - "$CURRENT_HEAD" "$CURRENT_TREE" <<'NODE'
import {
  loadValidationImageManifest
} from '/root/echolink/server/e3/validation/imageManifest.js'

const [head, tree] = process.argv.slice(2)
const m = loadValidationImageManifest()

if (m.sourceHead !== head) {
  throw new Error('active sourceHead mismatch')
}
if (m.sourceTreeGitSha !== tree) {
  throw new Error('active tree mismatch')
}
NODE
  check_repo
}

rollback() {
  local backup=${1:-}
  [[ -n "$backup" ]] || fail 'Rollback benötigt den Pfad zum gesicherten Manifest'
  rollback_active_manifest "$backup" || fail "Rollback fehlgeschlagen; Manifest: $MANIFEST; Backup: $backup"
  printf 'ROLLBACK_SUCCESS=%s\n' "$MANIFEST"
}

main() {
  local mode=${1:-rebind}
  require_cmd git
  require_cmd tar
  require_cmd python3
  require_cmd node
  require_cmd sha256sum
  require_cmd stat
  require_cmd readlink
  require_cmd flock
  require_cmd diff

  if [[ "$mode" == --rollback ]]; then
    [[ $# == 2 ]] ||
      fail 'Rollback-Aufruf erwartet genau einen Backup-Pfad'
    check_runtime_safety
    rollback "$2"
    return
  fi

  [[ $# -le 1 ]] ||
    fail 'Verwendung: SCRIPT [--check | --rollback BACKUP]'
  [[ "$mode" == rebind || "$mode" == --check ]] ||
    fail 'Verwendung: SCRIPT [--check | --rollback BACKUP]'

  check_repo
  check_runtime_safety

  if manifest_is_current; then
    printf 'E3_VALIDATION_BINDING_CURRENT=1\n'
    printf 'CURRENT_HEAD=%s\n' "$CURRENT_HEAD"
    printf 'CURRENT_TREE=%s\n' "$CURRENT_TREE"
    printf 'NODE_TAG=%s\n' "$NODE_TAG"
    printf 'PLAYWRIGHT_TAG=%s\n' "$PLAYWRIGHT_TAG"
    return
  fi

  if [[ "$mode" == --check ]]; then
    fail 'E3-Validatorbindung ist nicht aktuell'
  fi

  create_checked_dir /var/tmp/echolink-e3-validator-rebind.XXXXXX \
    '^/var/tmp/echolink-e3-validator-rebind\..+$' WORK_ROOT
  create_checked_dir /tmp/e3-validation-images.XXXXXX \
    '^/tmp/e3-validation-images\..+$' CONTEXT_ROOT

  OLD_MANIFEST_SHA=$(sha256sum "$MANIFEST" | awk '{print $1}')
  OLD_NODE_TAG=$(node --input-type=module - "$MANIFEST" <<'NODE'
import {
  loadValidationImageManifest
} from '/root/echolink/server/e3/validation/imageManifest.js'
console.log(loadValidationImageManifest().nodeImageTag)
NODE
)
  OLD_PLAYWRIGHT_TAG=$(node --input-type=module - "$MANIFEST" <<'NODE'
import {
  loadValidationImageManifest
} from '/root/echolink/server/e3/validation/imageManifest.js'
console.log(loadValidationImageManifest().playwrightImageTag)
NODE
)
  OLD_NODE_DIGEST=$(
    "$DOCKER" image inspect --format '{{.Id}}' "$OLD_NODE_TAG"
  )
  OLD_PLAYWRIGHT_DIGEST=$(
    "$DOCKER" image inspect --format '{{.Id}}' "$OLD_PLAYWRIGHT_TAG"
  )

  build_context
  build_images_and_manifest
  validate_and_smoke
  prepare_state
  activate
  verify_after

  printf 'REBINDSUCCESS=1\n'
  printf 'MANIFEST=%s\n' "$MANIFEST"
  printf 'BACKUP=%s\n' "$BACKUP_MANIFEST"
  printf 'NODE_TAG=%s\n' "$NODE_TAG"
  printf 'PLAYWRIGHT_TAG=%s\n' "$PLAYWRIGHT_TAG"
}

case "${1:-}" in
  --check)
    main --check
    ;;
  --rollback)
    [[ $# -eq 2 ]] ||
      fail '--rollback benötigt genau einen Backup-Pfad'
    main "$@"
    ;;
  "")
    main
    ;;
  *)
    fail 'Verwendung: SCRIPT [--check | --rollback BACKUP]'
    ;;
esac
