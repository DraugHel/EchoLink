#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"
DOCKER="/usr/bin/docker"
MANIFEST_PATH="/var/lib/echolink-e3/validation-images.json"
LOCK_PATH="/var/lock/echolink-e3-validation-images.lock"
NODE_BASE="node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
PLAYWRIGHT_BASE="mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48"

cd "$ROOT_DIR"

if [[ "$#" -ne 0 ]]; then
  printf '%s\n' "FEHLER: Dieses Skript akzeptiert keine Argumente" >&2
  exit 1
fi


if [[ "${EUID}" -ne 0 ]]; then
  printf '%s\n' "FEHLER: Validator-Images erfordern einen expliziten Root-Operatorlauf" >&2
  exit 1
fi

if [[ "$(git branch --show-current)" != "main" ]]; then
  printf '%s\n' "FEHLER: Validator-Images werden nur von main gebaut" >&2
  exit 1
fi

if ! git diff --cached --quiet; then
  printf '%s\n' "FEHLER: Staged Änderungen sind nicht erlaubt" >&2
  exit 1
fi

STATUS="$(
  git status --porcelain=v1 --untracked-files=all
)"
if [[ -n "$STATUS" && "${E3_VALIDATION_ALLOW_DIRTY_TREE:-0}" != "1" ]]; then
  printf '%s\n' "FEHLER: Working Tree ist nicht sauber" >&2
  exit 1
fi

if [[ ! -x "$DOCKER" ]]; then
  printf '%s\n' "FEHLER: Gepinnter Docker-Pfad fehlt" >&2
  exit 1
fi


if ! "$DOCKER" version >/dev/null 2>&1; then
  printf '%s\n' "FEHLER: Docker-Daemon ist nicht erreichbar" >&2
  exit 1
fi

if [[ "$(uname -m)" != "x86_64" ]]; then
  printf '%s\n' "FEHLER: 14A.1 ist auf linux/amd64 festgelegt" >&2
  exit 1
fi

if [[ -e "$(dirname "$MANIFEST_PATH")" ]]; then
  printf 'FEHLER: E3-Image-Speicher existiert bereits: %s\n' \
    "$(dirname "$MANIFEST_PATH")" >&2
  exit 1
fi

if "$DOCKER" ps -a \
  --filter 'label=echolink.e3.run' \
  --format '{{.ID}}' | grep -q .; then
  printf '%s\n' "FEHLER: Bestehende E3-Container erfordern manuelle Prüfung" >&2
  exit 1
fi

if "$DOCKER" network ls \
  --filter 'label=echolink.e3.run' \
  --format '{{.ID}}' | grep -q .; then
  printf '%s\n' "FEHLER: Bestehende E3-Netzwerke erfordern manuelle Prüfung" >&2
  exit 1
fi

if "$DOCKER" image ls \
  --filter 'label=echolink.e3.image-role' \
  --format '{{.ID}}' | grep -q .; then
  printf '%s\n' "FEHLER: Bestehende E3-Validator-Images erfordern manuelle Prüfung" >&2
  exit 1
fi

exec 9>"$LOCK_PATH"
if ! flock -n 9; then
  printf '%s\n' "FEHLER: Ein Validator-Image-Build läuft bereits" >&2
  exit 1
fi

WORK_ROOT="$(mktemp -d /tmp/e3-validation-images.XXXXXX)"
INDEX_FILE="$WORK_ROOT/index"
CONTEXT_ROOT="$WORK_ROOT/context"
TEMP_MANIFEST="$WORK_ROOT/validation-images.json"
SOURCE_MANIFEST="$WORK_ROOT/source-manifest.bin"
mkdir -m 0700 -- "$CONTEXT_ROOT"

cleanup_success() {
  chmod -R u+w "$WORK_ROOT" 2>/dev/null || true
  rm -rf -- "$WORK_ROOT"
}

GIT_INDEX_FILE="$INDEX_FILE" git read-tree --empty
GIT_INDEX_FILE="$INDEX_FILE" git add -A -- .
SOURCE_TREE_GIT_SHA="$(
  GIT_INDEX_FILE="$INDEX_FILE" git write-tree
)"
GIT_INDEX_FILE="$INDEX_FILE" git checkout-index \
  --all \
  --prefix="$CONTEXT_ROOT/"

CONTEXT_ROOT="$CONTEXT_ROOT" \
SOURCE_MANIFEST="$SOURCE_MANIFEST" \
python3 <<'PY'
import hashlib
import os
from pathlib import Path

root = Path(os.environ['CONTEXT_ROOT']).resolve()
manifest = Path(os.environ['SOURCE_MANIFEST'])
forbidden = {
    '.env',
    'data',
    'dist',
    'node_modules',
    'uploads',
    'backups',
}
records = bytearray()
for path in sorted(root.rglob('*')):
    relative = path.relative_to(root).as_posix()
    if relative.split('/', 1)[0] in forbidden:
        raise SystemExit(f'FEHLER: Verbotener Build-Kontextpfad: {relative}')
    stat = path.lstat()
    mode = stat.st_mode & 0o7777
    if path.is_symlink():
        raise SystemExit(f'FEHLER: Symlink im Build-Kontext: {relative}')
    elif path.is_file():
        payload = path.read_bytes()
        kind = b'F'
    elif path.is_dir():
        payload = b''
        kind = b'D'
    else:
        raise SystemExit(f'FEHLER: Unsicherer Build-Kontexteintrag: {relative}')
    records.extend(kind)
    records.extend(f'{mode:o}'.encode('ascii'))
    records.extend(b'\0')
    records.extend(relative.encode('utf-8'))
    records.extend(b'\0')
    records.extend(str(len(payload)).encode('ascii'))
    records.extend(b'\0')
    records.extend(payload)
    records.extend(b'\0')
manifest.write_bytes(records)
print(hashlib.sha256(records).hexdigest())
PY
SOURCE_TREE_SHA256="$(sha256sum "$SOURCE_MANIFEST" | awk '{print $1}')"
SOURCE_HEAD="$(git rev-parse HEAD)"
TREE_SHORT="${SOURCE_TREE_GIT_SHA:0:12}"
NODE_TAG="echolink-e3-node-validator:$TREE_SHORT"
PLAYWRIGHT_TAG="echolink-e3-playwright-validator:$TREE_SHORT"

for tag in "$NODE_TAG" "$PLAYWRIGHT_TAG"; do
  if "$DOCKER" image inspect "$tag" >/dev/null 2>&1; then
    printf 'FEHLER: Validator-Image-Tag existiert bereits: %s
'       "$tag" >&2
    exit 1
  fi
done

printf 'SOURCE_HEAD=%s\n' "$SOURCE_HEAD"
printf 'SOURCE_TREE_GIT_SHA=%s\n' "$SOURCE_TREE_GIT_SHA"
printf 'SOURCE_TREE_SHA256=%s\n' "$SOURCE_TREE_SHA256"
printf 'NODE_BASE=%s\n' "$NODE_BASE"
printf 'PLAYWRIGHT_BASE=%s\n' "$PLAYWRIGHT_BASE"

COMMON_BUILD_ARGS=(
  --pull
  --no-cache
  --build-arg "E3_SOURCE_HEAD=$SOURCE_HEAD"
  --build-arg "E3_SOURCE_TREE_GIT_SHA=$SOURCE_TREE_GIT_SHA"
  --build-arg "E3_SOURCE_TREE_SHA256=$SOURCE_TREE_SHA256"
)

"$DOCKER" build \
  "${COMMON_BUILD_ARGS[@]}" \
  --file docker/e3-validation/node.Dockerfile \
  --tag "$NODE_TAG" \
  "$CONTEXT_ROOT"

"$DOCKER" build \
  "${COMMON_BUILD_ARGS[@]}" \
  --file docker/e3-validation/playwright.Dockerfile \
  --tag "$PLAYWRIGHT_TAG" \
  "$CONTEXT_ROOT"

NODE_IMAGE_DIGEST="$(
  "$DOCKER" image inspect \
    --format '{{.Id}}' \
    "$NODE_TAG"
)"
PLAYWRIGHT_IMAGE_DIGEST="$(
  "$DOCKER" image inspect \
    --format '{{.Id}}' \
    "$PLAYWRIGHT_TAG"
)"

for digest in "$NODE_IMAGE_DIGEST" "$PLAYWRIGHT_IMAGE_DIGEST"; do
  if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf 'FEHLER: Gebautes Image besitzt keine feste ID: %s\n' \
      "$digest" >&2
    exit 1
  fi
done

verify_image() {
  local tag="$1"
  local role="$2"
  local expected_user="65532:65532"
  local actual_role actual_head actual_tree actual_tree_sha256
  local actual_runtime actual_user actual_os actual_architecture
  actual_role="$(
    "$DOCKER" image inspect \
      --format '{{index .Config.Labels "echolink.e3.image-role"}}' \
      "$tag"
  )"
  actual_head="$(
    "$DOCKER" image inspect \
      --format '{{index .Config.Labels "echolink.e3.source-head"}}' \
      "$tag"
  )"
  actual_tree="$(
    "$DOCKER" image inspect \
      --format '{{index .Config.Labels "echolink.e3.source-tree-git-sha"}}' \
      "$tag"
  )"
  actual_tree_sha256="$(
    "$DOCKER" image inspect \
      --format '{{index .Config.Labels "echolink.e3.source-tree-sha256"}}' \
      "$tag"
  )"
  actual_runtime="$(
    "$DOCKER" run --rm --pull never --network none \
      --read-only --cap-drop ALL \
      --security-opt no-new-privileges:true \
      --security-opt apparmor=docker-default \
      --user 65532:65532 \
      --entrypoint /usr/bin/node \
      "$tag" \
      --version
  )"
  actual_user="$(
    "$DOCKER" image inspect \
      --format '{{.Config.User}}' \
      "$tag"
  )"
  actual_os="$("$DOCKER" image inspect --format '{{.Os}}' "$tag")"
  actual_architecture="$(
    "$DOCKER" image inspect --format '{{.Architecture}}' "$tag"
  )"
  [[ "$actual_role" == "$role" ]]
  [[ "$actual_head" == "$SOURCE_HEAD" ]]
  [[ "$actual_tree" == "$SOURCE_TREE_GIT_SHA" ]]
  [[ "$actual_tree_sha256" == "$SOURCE_TREE_SHA256" ]]
  [[ "$actual_runtime" == "v24.18.0" ]]
  [[ "$actual_user" == "$expected_user" ]]
  [[ "$actual_os" == "linux" ]]
  [[ "$actual_architecture" == "amd64" ]]
}

verify_image "$NODE_TAG" "node-validator"
verify_image "$PLAYWRIGHT_TAG" "playwright-validator"

node scripts/e3-write-validation-image-manifest.mjs \
  "$TEMP_MANIFEST" \
  "$SOURCE_HEAD" \
  "$SOURCE_TREE_GIT_SHA" \
  "$SOURCE_TREE_SHA256" \
  "$NODE_IMAGE_DIGEST" \
  "$PLAYWRIGHT_IMAGE_DIGEST" \
  "$NODE_TAG" \
  "$PLAYWRIGHT_TAG" \
  "$CONTEXT_ROOT"

SMOKE_ROOT="/root/echolink-patch-backups/e3-validation-smoke-$TREE_SHORT"
if [[ -e "$SMOKE_ROOT" ]]; then
  printf 'FEHLER: Smoke-Verzeichnis existiert bereits: %s\n' \
    "$SMOKE_ROOT" >&2
  exit 1
fi
SNAPSHOT_ROOT="$SMOKE_ROOT/snapshots"
SNAPSHOT_PATH="$SNAPSHOT_ROOT/source/snapshot"
OUTPUT_ROOT="$SMOKE_ROOT/outputs"
mkdir -m 0700 -p -- "$SNAPSHOT_PATH" "$OUTPUT_ROOT"
cp -a "$CONTEXT_ROOT/." "$SNAPSHOT_PATH/"
find "$SNAPSHOT_PATH" -type d -exec chmod 0555 {} +
find "$SNAPSHOT_PATH" -type f -exec chmod 0444 {} +

node scripts/e3-validation-image-smoke.mjs \
  "$TEMP_MANIFEST" \
  "$SNAPSHOT_ROOT" \
  "$SNAPSHOT_PATH" \
  "$OUTPUT_ROOT"

if "$DOCKER" ps -a \
  --filter 'label=echolink.e3.run' \
  --format '{{.ID}}' | grep -q .; then
  printf '%s\n' "FEHLER: E3-Container blieb nach Smoke zurück" >&2
  exit 1
fi
if "$DOCKER" network ls \
  --filter 'label=echolink.e3.run' \
  --format '{{.ID}}' | grep -q .; then
  printf '%s\n' "FEHLER: E3-Netzwerk blieb nach Smoke zurück" >&2
  exit 1
fi

chmod -R u+w "$SMOKE_ROOT"
rm -rf -- "$SMOKE_ROOT"
install -d -m 0750 -- "$(dirname "$MANIFEST_PATH")"
install -m 0640 -- "$TEMP_MANIFEST" "$MANIFEST_PATH"

node --input-type=module - <<'NODE'
import { loadValidationImageManifest } from './server/e3/validation/imageManifest.js'
const manifest = loadValidationImageManifest()
process.stdout.write(`IMAGE_MANIFEST_SHA256=${manifest.manifestSha256}\n`)
NODE

printf 'NODE_IMAGE_DIGEST=%s\n' "$NODE_IMAGE_DIGEST"
printf 'PLAYWRIGHT_IMAGE_DIGEST=%s\n' "$PLAYWRIGHT_IMAGE_DIGEST"
printf 'VALIDATION_IMAGE_MANIFEST=%s\n' "$MANIFEST_PATH"
printf '%s\n' "E3_VALIDATION_IMAGES_BUILD_AND_SMOKE_SUCCESS"
cleanup_success
