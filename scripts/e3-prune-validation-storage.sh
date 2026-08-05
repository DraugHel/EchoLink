#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly REPO="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"
readonly DOCKER=/usr/bin/docker
readonly STATE=/var/lib/echolink-e3
readonly MANIFEST="$STATE/validation-images.json"
readonly LOCK=/var/lock/echolink-e3-validation-images.lock
readonly MODE=${1:---dry-run}

LOCK_FD=9
IMAGE_REMOVED_COUNT=0
IMAGE_WOULD_REMOVE_COUNT=0
IMAGE_REMOVE_FAILURE_COUNT=0
MANIFEST_REMOVED_COUNT=0
MANIFEST_WOULD_REMOVE_COUNT=0
BUILD_CACHE_PRUNED=0

declare -a PROTECTED_DIGESTS=()
declare -a CANDIDATE_DIGESTS=()
declare -a ROLLBACK_MANIFESTS=()
PREVIOUS_MANIFEST=''

fail() {
  printf 'FEHLER: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 ||
    fail "Benötigtes Programm fehlt: $1"
}

canonical_path() {
  local target=$1
  [[ "$target" == /* ]] || fail "Pfad ist nicht absolut: $target"
  [[ "$(readlink -m -- "$target")" == "$target" ]] ||
    fail "Pfad ist nicht kanonisch: $target"
}

check_manifest_file() {
  local target=$1 real
  canonical_path "$target"
  [[ "$target" == "$MANIFEST" ||
     "$target" == "$STATE/validation-images.rollback-"*.json ]] ||
    fail "Manifest liegt außerhalb der Allowlist: $target"
  [[ -f "$target" && ! -L "$target" ]] ||
    fail "Manifest ist keine reguläre Datei: $target"
  real=$(readlink -f -- "$target")
  [[ "$real" == "$target" ]] ||
    fail "Manifest ist nicht kanonisch: $target"
  [[ "$(stat -c '%u:%g:%a:%h' -- "$target")" == '0:0:640:1' ]] ||
    fail "Manifestidentität weicht ab: $target"
}

manifest_image_values() {
  node --input-type=module - "$1" <<'NODE'
import fs from 'node:fs'

const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
for (const field of [
  value.sourceHead,
  value.sourceTreeGitSha,
  value.nodeImageTag,
  value.nodeImageDigest,
  value.playwrightImageTag,
  value.playwrightImageDigest
]) {
  console.log(field)
}
NODE
}

array_contains() {
  local needle=$1 item
  shift
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

protect_manifest_images() {
  local manifest=$1 require_active_tags=$2 values
  local source_head source_tree
  local node_tag node_digest playwright_tag playwright_digest
  local -a fields

  check_manifest_file "$manifest"
  values=$(manifest_image_values "$manifest") ||
    fail "Manifest kann nicht gelesen werden: $manifest"
  mapfile -t fields <<<"$values"
  [[ "${#fields[@]}" == 6 ]] ||
    fail "Manifest enthält nicht sechs Retention-Bindungen: $manifest"

  source_head=${fields[0]}
  source_tree=${fields[1]}
  node_tag=${fields[2]}
  node_digest=${fields[3]}
  playwright_tag=${fields[4]}
  playwright_digest=${fields[5]}

  [[ "$source_head" =~ ^[0-9a-f]{40}$ ]] ||
    fail "Ungültiger Source-HEAD in $manifest"
  [[ "$source_tree" =~ ^[0-9a-f]{40}$ ]] ||
    fail "Ungültiger Source-Tree in $manifest"
  [[ "$node_tag" =~ ^echolink-e3-node-validator:[0-9a-f]{12}$ ]] ||
    fail "Ungültiger Node-Tag in $manifest"
  [[ "$playwright_tag" =~ ^echolink-e3-playwright-validator:[0-9a-f]{12}$ ]] ||
    fail "Ungültiger Playwright-Tag in $manifest"
  [[ "$node_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    fail "Ungültiger Node-Digest in $manifest"
  [[ "$playwright_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    fail "Ungültiger Playwright-Digest in $manifest"

  "$DOCKER" image inspect "$node_digest" >/dev/null 2>&1 ||
    fail "Geschütztes Node-Image fehlt: $node_digest"
  "$DOCKER" image inspect "$playwright_digest" >/dev/null 2>&1 ||
    fail "Geschütztes Playwright-Image fehlt: $playwright_digest"

  if [[ "$require_active_tags" == 1 ]]; then
    [[ "$source_head" == "$(git -C "$REPO" rev-parse HEAD)" ]] ||
      fail 'Aktives Manifest ist nicht an den aktuellen HEAD gebunden'
    [[ "$source_tree" == "$(git -C "$REPO" rev-parse 'HEAD^{tree}')" ]] ||
      fail 'Aktives Manifest ist nicht an den aktuellen Tree gebunden'
    [[ "$("$DOCKER" image inspect --format '{{.Id}}' "$node_tag")" == "$node_digest" ]] ||
      fail 'Aktiver Node-Tag stimmt nicht mit dem Manifest überein'
    [[ "$("$DOCKER" image inspect --format '{{.Id}}' "$playwright_tag")" == "$playwright_digest" ]] ||
      fail 'Aktiver Playwright-Tag stimmt nicht mit dem Manifest überein'
  fi

  array_contains "$node_digest" "${PROTECTED_DIGESTS[@]}" ||
    PROTECTED_DIGESTS+=("$node_digest")
  array_contains "$playwright_digest" "${PROTECTED_DIGESTS[@]}" ||
    PROTECTED_DIGESTS+=("$playwright_digest")
}

check_runtime_safety() {
  [[ "$MODE" == --dry-run || "$MODE" == --apply ]] ||
    fail 'Verwendung: SCRIPT [--dry-run | --apply]'
  [[ "$EUID" == 0 ]] || fail 'Root-Operatorlauf erforderlich'
  [[ -d "$REPO/.git" ]] || fail 'EchoLink-Repository fehlt'
  [[ "$(git -C "$REPO" branch --show-current)" == main ]] ||
    fail 'EchoLink steht nicht auf main'
  if [[ "$MODE" == --apply ]]; then
    [[ -z "$(git -C "$REPO" status --porcelain=v1 --untracked-files=all)" ]] ||
      fail 'EchoLink-Working-Tree ist nicht sauber'
  fi
  [[ -d "$STATE" && "$(readlink -m -- "$STATE")" == "$STATE" ]] ||
    fail 'E3-State-Root fehlt oder ist nicht kanonisch'
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
    "$DOCKER" ps -a \
      --filter 'label=echolink.e3.validator' \
      --format '{{.ID}}'
  )" ]] || fail 'E3-Validatorcontainer vorhanden'
  [[ -z "$(
    "$DOCKER" network ls \
      --filter 'label=echolink.e3.run' \
      --format '{{.ID}}'
  )" ]] || fail 'E3-Netzwerk vorhanden'
}

load_retention_set() {
  local name
  check_manifest_file "$MANIFEST"
  mapfile -t ROLLBACK_MANIFESTS < <(
    find "$STATE" \
      -maxdepth 1 \
      -type f \
      -name 'validation-images.rollback-*.json' \
      -printf '%f\n' |
      sort
  )

  if (( ${#ROLLBACK_MANIFESTS[@]} > 0 )); then
    name=${ROLLBACK_MANIFESTS[$((${#ROLLBACK_MANIFESTS[@]} - 1))]}
    [[ "$name" =~ ^validation-images\.rollback-[0-9]{8}T[0-9]{6}Z\.json$ ]] ||
      fail "Ungültiger Rollback-Manifestname: $name"
    PREVIOUS_MANIFEST="$STATE/$name"
  fi

  protect_manifest_images "$MANIFEST" 1
  if [[ -n "$PREVIOUS_MANIFEST" ]]; then
    protect_manifest_images "$PREVIOUS_MANIFEST" 0
  fi
}

validate_candidate_image() {
  local digest=$1 role tree tag
  local -a tags

  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    fail "Ungültiger Candidate-Digest: $digest"
  role=$("$DOCKER" image inspect \
    --format '{{index .Config.Labels "echolink.e3.image-role"}}' \
    "$digest")
  tree=$("$DOCKER" image inspect \
    --format '{{index .Config.Labels "echolink.e3.source-tree-git-sha"}}' \
    "$digest")
  [[ "$role" == node-validator || "$role" == playwright-validator ]] ||
    fail "Candidate besitzt eine fremde Rolle: $digest"
  [[ "$tree" =~ ^[0-9a-f]{40}$ ]] ||
    fail "Candidate besitzt keinen gültigen Source-Tree: $digest"

  mapfile -t tags < <(
    "$DOCKER" image inspect \
      --format '{{range .RepoTags}}{{println .}}{{end}}' \
      "$digest"
  )
  for tag in "${tags[@]}"; do
    [[ -n "$tag" ]] || continue
    if [[ "$role" == node-validator ]]; then
      [[ "$tag" =~ ^echolink-e3-node-validator:[0-9a-f]{12}$ ]] ||
        fail "Node-Validator besitzt fremden Tag: $tag"
    else
      [[ "$tag" =~ ^echolink-e3-playwright-validator:[0-9a-f]{12}$ ]] ||
        fail "Playwright-Validator besitzt fremden Tag: $tag"
    fi
  done
}

load_candidate_images() {
  local digest
  local -a all_digests
  mapfile -t all_digests < <(
    {
      "$DOCKER" image ls \
        --all --quiet --no-trunc \
        --filter 'label=echolink.e3.image-role=node-validator'
      "$DOCKER" image ls \
        --all --quiet --no-trunc \
        --filter 'label=echolink.e3.image-role=playwright-validator'
    } | sort -u
  )

  for digest in "${all_digests[@]}"; do
    [[ -n "$digest" ]] || continue
    array_contains "$digest" "${PROTECTED_DIGESTS[@]}" && continue
    validate_candidate_image "$digest"
    CANDIDATE_DIGESTS+=("$digest")
  done
}

prune_images() {
  local digest
  for digest in "${CANDIDATE_DIGESTS[@]}"; do
    if [[ "$MODE" == --dry-run ]]; then
      printf 'WOULD_REMOVE_VALIDATOR_IMAGE=%s\n' "$digest"
      IMAGE_WOULD_REMOVE_COUNT=$((IMAGE_WOULD_REMOVE_COUNT + 1))
      continue
    fi

    if "$DOCKER" image rm "$digest"; then
      printf 'REMOVED_VALIDATOR_IMAGE=%s\n' "$digest"
      IMAGE_REMOVED_COUNT=$((IMAGE_REMOVED_COUNT + 1))
    else
      printf 'WARNUNG: Validator-Image konnte nicht entfernt werden: %s\n' \
        "$digest" >&2
      IMAGE_REMOVE_FAILURE_COUNT=$((IMAGE_REMOVE_FAILURE_COUNT + 1))
    fi
  done
}

prune_old_manifests() {
  local name target last_index
  (( ${#ROLLBACK_MANIFESTS[@]} > 1 )) || return 0
  last_index=$((${#ROLLBACK_MANIFESTS[@]} - 1))

  for name in "${ROLLBACK_MANIFESTS[@]:0:$last_index}"; do
    [[ "$name" =~ ^validation-images\.rollback-[0-9]{8}T[0-9]{6}Z\.json$ ]] ||
      fail "Ungültiger Rollback-Manifestname: $name"
    target="$STATE/$name"
    check_manifest_file "$target"
    if [[ "$MODE" == --dry-run ]]; then
      printf 'WOULD_REMOVE_ROLLBACK_MANIFEST=%s\n' "$target"
      MANIFEST_WOULD_REMOVE_COUNT=$((MANIFEST_WOULD_REMOVE_COUNT + 1))
    else
      unlink "$target"
      printf 'REMOVED_ROLLBACK_MANIFEST=%s\n' "$target"
      MANIFEST_REMOVED_COUNT=$((MANIFEST_REMOVED_COUNT + 1))
    fi
  done
}

prune_build_cache() {
  if [[ "$MODE" == --dry-run ]]; then
    printf 'WOULD_PRUNE_DOCKER_BUILDER_CACHE=1\n'
    return 0
  fi
  if "$DOCKER" builder prune --force; then
    BUILD_CACHE_PRUNED=1
  else
    printf 'WARNUNG: Docker-Build-Cache konnte nicht vollständig bereinigt werden.\n' >&2
    IMAGE_REMOVE_FAILURE_COUNT=$((IMAGE_REMOVE_FAILURE_COUNT + 1))
  fi
}

verify_protected_images() {
  local digest
  for digest in "${PROTECTED_DIGESTS[@]}"; do
    "$DOCKER" image inspect "$digest" >/dev/null 2>&1 ||
      fail "Geschütztes Validator-Image fehlt nach Cleanup: $digest"
  done
  protect_manifest_images "$MANIFEST" 1
}

main() {
  require_cmd node
  require_cmd find
  require_cmd sort
  require_cmd stat
  require_cmd readlink
  require_cmd flock
  require_cmd unlink

  check_runtime_safety
  load_retention_set
  load_candidate_images
  prune_images
  prune_build_cache

  if (( IMAGE_REMOVE_FAILURE_COUNT == 0 )); then
    prune_old_manifests
  else
    printf 'WARNUNG: Alte Rollback-Manifeste bleiben wegen unvollständigem Cleanup erhalten.\n' >&2
  fi

  verify_protected_images

  if [[ "$MODE" == --dry-run ]]; then
    printf 'E3_VALIDATION_STORAGE_RETENTION_DRY_RUN=1\n'
    printf 'PROTECTED_IMAGE_COUNT=%s\n' "${#PROTECTED_DIGESTS[@]}"
    printf 'WOULD_REMOVE_IMAGE_COUNT=%s\n' "$IMAGE_WOULD_REMOVE_COUNT"
    printf 'WOULD_REMOVE_MANIFEST_COUNT=%s\n' "$MANIFEST_WOULD_REMOVE_COUNT"
    return 0
  fi

  if (( IMAGE_REMOVE_FAILURE_COUNT == 0 )); then
    printf 'E3_VALIDATION_STORAGE_RETENTION_SUCCESS=1\n'
  else
    printf 'E3_VALIDATION_STORAGE_RETENTION_PARTIAL=1\n'
  fi
  printf 'PROTECTED_IMAGE_COUNT=%s\n' "${#PROTECTED_DIGESTS[@]}"
  printf 'REMOVED_IMAGE_COUNT=%s\n' "$IMAGE_REMOVED_COUNT"
  printf 'REMOVED_MANIFEST_COUNT=%s\n' "$MANIFEST_REMOVED_COUNT"
  printf 'BUILD_CACHE_PRUNED=%s\n' "$BUILD_CACHE_PRUNED"
}

main
