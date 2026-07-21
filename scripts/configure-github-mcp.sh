#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
OFFICIAL_URL="https://api.githubcopilot.com/mcp/"
DEFAULT_REPOSITORY="DraugHel/EchoLink"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FEHLER: $ENV_FILE fehlt." >&2
  exit 1
fi

if [[ "${1:-}" == "--disable" ]]; then
  python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
lines = path.read_text(encoding='utf-8').splitlines()
key = 'GITHUB_MCP_MODE'
found = False
out = []

for line in lines:
    if line.startswith(f'{key}='):
        out.append(f'{key}=disabled')
        found = True
    else:
        out.append(line)

if not found:
    out.append(f'{key}=disabled')

path.write_text('\n'.join(out) + '\n', encoding='utf-8')
PY
  chmod 600 "$ENV_FILE"
  echo "GitHub MCP wurde deaktiviert. Der gespeicherte Token wurde nicht ausgegeben oder verändert."
  exit 0
fi

printf 'GitHub Fine-grained PAT (Eingabe bleibt unsichtbar): '
IFS= read -r -s TOKEN
printf '\n'

if [[ ${#TOKEN} -lt 20 ]]; then
  echo "FEHLER: Der Token ist zu kurz." >&2
  exit 1
fi

BACKUP="$REPO_ROOT/backups/github-mcp-env-$(date -u +%Y%m%dT%H%M%SZ).env"
mkdir -p "$(dirname "$BACKUP")"
cp -a "$ENV_FILE" "$BACKUP"

GITHUB_MCP_TOKEN_VALUE="$TOKEN" \
GITHUB_MCP_URL_VALUE="$OFFICIAL_URL" \
GITHUB_MCP_REPOSITORY_VALUE="$DEFAULT_REPOSITORY" \
python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import os
import sys

path = Path(sys.argv[1])
updates = {
    'GITHUB_MCP_MODE': 'active',
    'GITHUB_MCP_URL': os.environ['GITHUB_MCP_URL_VALUE'],
    'GITHUB_MCP_TOKEN': os.environ['GITHUB_MCP_TOKEN_VALUE'],
    'GITHUB_MCP_ALLOWED_REPOS': os.environ['GITHUB_MCP_REPOSITORY_VALUE'],
    'GITHUB_MCP_REQUEST_TIMEOUT_MS': '30000',
    'GITHUB_MCP_TOOL_TIMEOUT_MS': '30000',
    'GITHUB_MCP_FALLBACK_COOLDOWN_MS': '30000',
}

lines = path.read_text(encoding='utf-8').splitlines()
seen = set()
out = []

for line in lines:
    key = line.split('=', 1)[0] if '=' in line else None
    if key in updates:
        if key not in seen:
            out.append(f'{key}={updates[key]}')
            seen.add(key)
        continue
    out.append(line)

if out and out[-1] != '':
    out.append('')

for key, value in updates.items():
    if key not in seen:
        out.append(f'{key}={value}')

path.write_text('\n'.join(out) + '\n', encoding='utf-8')
PY

unset TOKEN
chmod 600 "$ENV_FILE"

echo "GitHub MCP wurde in .env aktiviert."
echo "Repository-Allowlist: $DEFAULT_REPOSITORY"
echo "Backup: $BACKUP"
echo "Der Token wurde nicht ausgegeben."
