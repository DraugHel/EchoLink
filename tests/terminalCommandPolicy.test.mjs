import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  classifyDestructiveTerminalCommand,
  classifyTerminalCommand,
  isDestructiveTerminalCommand,
  isReadOnlyTerminalCommand
} from '../server/lib/terminalCommandPolicy.js'

test('komplexer Bash-Speicheraudit läuft ohne Zeichen-Sonderfälle read-only', () => {
  const command = `bash -lc 'set -Eeuo pipefail
printf "%s\\n" "===== FILESYSTEM ====="
df -h /root /var/lib/echolink-e3 /var/tmp /tmp 2>&1
df -i /root /var/lib/echolink-e3 /var/tmp /tmp 2>&1
for p in /root/.cache /root/.local /root/.npm; do
  if [[ -d "$p" ]]; then
    du -xhd1 "$p" 2>/dev/null | sort -h | tail -20
  fi
done'`

  assert.equal(isReadOnlyTerminalCommand(command), true)
  assert.equal(isDestructiveTerminalCommand(command), false)
})

test('Audit mit Variablen, Substitution, Git, awk und Credentials-Metadaten ist read-only', () => {
  const command = `bash -lc 'set -u
cd /root/echolink
BASE="7f23c744ff88d66439837a7a2fc20cf4465d2774"
printf "HEAD=%s\\n" "$(git rev-parse HEAD)"
printf "TREE=%s\\n" "$(git rev-parse "HEAD^{tree}")"
printf "REMOTE_MAIN=%s\\n" "$(git ls-remote --exit-code origin refs/heads/main | awk "NR == 1 { print \\$1 }")"
git status --short
for variable in GH_TOKEN GITHUB_TOKEN; do
  if [[ -n "\${!variable:-}" ]]; then
    printf "%s=PRESENT\\n" "$variable"
  else
    printf "%s=ABSENT\\n" "$variable"
  fi
done
stat -c "CREDENTIAL_FILE=%n OWNER=%U:%G MODE=%a" /root/.git-credentials'`

  assert.equal(isReadOnlyTerminalCommand(command), true)
})

test('Archive-, Prozess-, Lock-, Docker- und Datenbankinventar ist read-only', () => {
  const commands = [
    `find /root /var/lib/echolink-e3 /var/tmp /tmp -xdev -type f \\( -iname '*.tar' -o -iname '*.tar.gz' -o -iname '*.zip' \\) -printf '%s %p\\n' 2>/dev/null | sort -n | tail -100`,
    `ps -eo user,pid,etimes,cmd --sort=-etimes | head -80`,
    `if command -v lsof >/dev/null; then lsof /var/lib/echolink-e3/apply/global.lock; fi`,
    `docker system df`,
    `docker image ls`,
    `git -C /root/echolink --no-pager status --short`,
    `sqlite3 /root/echolink/data/echolink.db 'PRAGMA integrity_check;'`,
    `sqlite3 /root/echolink/data/echolink.db 'SELECT COUNT(*) FROM memories;'`,
    `sqlite3 /root/echolink/data/echolink.db '.schema memories'`,
    `node --check server/routes/chat.js`,
    `sha256sum /var/lib/echolink-e3/validation-images.json`
  ]

  for (const command of commands) {
    assert.equal(
      isReadOnlyTerminalCommand(command),
      true,
      command
    )
  }
})

test('Bash-Heredoc mit ausschließlich lesenden Befehlen ist read-only', () => {
  const command = `bash <<'BASH'
set -Eeuo pipefail
printf '%s\\n' '===== RUNTIME ====='
pm2 status
systemctl --no-pager status echolink
journalctl -u echolink --no-pager -n 50
BASH`

  assert.equal(isReadOnlyTerminalCommand(command), true)
})

test('realer Luna-Audit mit Python-Manifestleser und lokalen Curl-Healthchecks ist read-only', () => {
  const command = `bash <<'AUDIT'
set -Eeuo pipefail
REPO="/root/echolink"
MANIFEST="/var/lib/echolink-e3/validation-images.json"
cd "$REPO"
printf 'UTC=%s\\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
printf 'HEAD=%s\\n' "$(git rev-parse HEAD)"
python3 - "$MANIFEST" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
data = json.loads(p.read_text(encoding='utf-8'))
print('MANIFEST_JSON=VALID')
for key in ('format', 'version', 'nodeImage', 'playwrightImage'):
    if key in data:
        value = data[key]
        print(f'{key}={value}')
PY
for port in 3000 3011; do
  if command -v curl >/dev/null 2>&1; then
    result="$(curl --silent --show-error --output /dev/null --write-out '%{http_code} %{time_total}s' --connect-timeout 2 --max-time 5 "http://127.0.0.1:\${port}/" 2>&1 || true)"
    printf 'PORT=%s RESULT=%s\\n' "$port" "$result"
  fi
done
AUDIT`

  assert.equal(isReadOnlyTerminalCommand(command), true)
})

test('vollständiger produktiver Luna-Systemaudit ist bytegetreu read-only', () => {
  const command = `bash -s <<'AUDIT'
set -Eeuo pipefail
REPO=/root/echolink
MANIFEST=/var/lib/echolink-e3/validation-images.json
DB=/root/echolink/data/echolink.db
cd "$REPO"
printf '%s\\n' '===== ECHOLINK READ-ONLY SYSTEM AUDIT ====='
printf 'UTC=%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\\n' '===== GIT ====='
printf 'BRANCH=%s\\n' "$(git branch --show-current)"
printf 'HEAD=%s\\n' "$(git rev-parse HEAD)"
printf 'TREE=%s\\n' "$(git rev-parse HEAD^{tree})"
printf 'LOCAL_MAIN=%s\\n' "$(git rev-parse refs/heads/main)"
printf 'ORIGIN_MAIN=%s\\n' "$(git rev-parse refs/remotes/origin/main)"
printf 'REMOTE_MAIN=%s\\n' "$(git ls-remote --heads origin refs/heads/main | awk '{print $1}')"
printf 'STATUS='
git status --short --untracked-files=all
printf '%s\\n' '===== DISK ====='
df -h /
df -i /
printf '%s\\n' '===== PM2 ====='
pm2 status
printf '%s\\n' '===== DOCKER STORAGE ====='
docker system df
printf '%s\\n' '===== DOCKER IMAGES ====='
docker image ls --no-trunc --format 'REPOSITORY={{.Repository}} TAG={{.Tag}} ID={{.ID}} CREATED={{.CreatedAt}} SIZE={{.Size}}'
printf '%s\\n' '===== VALIDATOR MANIFEST ====='
if [[ -f "$MANIFEST" ]]; then
  stat --format='MODE=%a OWNER=%U:%G SIZE=%s MTIME=%y PATH=%n' -- "$MANIFEST"
  sha256sum -- "$MANIFEST"
else
  printf '%s\\n' 'MANIFEST=MISSING'
fi
printf '%s\\n' '===== SQLITE ====='
if command -v sqlite3 >/dev/null 2>&1 && [[ -f "$DB" ]]; then
  printf 'DB='
  stat --format='SIZE=%s PATH=%n' -- "$DB"
  sqlite3 -readonly "$DB" 'PRAGMA quick_check;'
else
  printf 'SQLITE_OR_DB=UNAVAILABLE\\n'
fi
printf '%s\\n' '===== HEALTH 3000 ====='
if command -v curl >/dev/null 2>&1; then
  curl -fsS --max-time 10 -o /dev/null -w 'HTTP=%{http_code} TIME=%{time_total}s URL=%{url_effective}\\n' http://127.0.0.1:3000/ || printf '%s\\n' 'HEALTH_3000=FAILED'
else
  printf '%s\\n' 'CURL=MISSING'
fi
printf '%s\\n' '===== HEALTH 3011 ====='
if command -v curl >/dev/null 2>&1; then
  curl -fsS --max-time 10 -o /dev/null -w 'HTTP=%{http_code} TIME=%{time_total}s URL=%{url_effective}\\n' http://127.0.0.1:3011/ || printf '%s\\n' 'HEALTH_3011=FAILED'
else
  printf '%s\\n' 'CURL=MISSING'
fi
printf '%s\\n' '===== AUDIT COMPLETE ====='
AUDIT`

  assert.equal(isReadOnlyTerminalCommand(command), true)
})

test('versteckte Schreiboperationen gelten nicht fälschlich als read-only', () => {
  const commands = [
    `printf ok; rm -f /tmp/hidden-write`,
    `bash -lc 'df -h; rm -f /tmp/hidden-write'`,
    `printf '%s' "$(rm -f /tmp/hidden-write)"`,
    `cat /etc/hosts > /tmp/copied-hosts`,
    `find /tmp -type f -delete`,
    `find /tmp -type f -exec rm {} +`,
    `find /tmp -type f -fprint /tmp/files`,
    `awk 'BEGIN { system("rm -f /tmp/hidden-write") }' /dev/null`,
    `awk 'BEGIN { print "x" > "/tmp/hidden-write" }' /dev/null`,
    `sed -i 's/a/b/' /tmp/file`,
    `sed -n '1,20p' /tmp/file`,
    `case x in x) rm -f /tmp/hidden-write ;; esac`,
    `sort -o /tmp/sorted /tmp/input`,
    `git -C /root/echolink fetch origin`,
    `git remote set-url origin https://example.invalid/repo`,
    `journalctl --vacuum-time=1d`,
    `docker system prune`,
    `sqlite3 /root/echolink/data/echolink.db 'DELETE FROM memories;'`,
    `sqlite3 /root/echolink/data/echolink.db '.shell rm -f /tmp/hidden-write'`,
    `sqlite3 /root/echolink/data/echolink.db 'PRAGMA optimize;'`,
    `sqlite3 /root/echolink/data/echolink.db 'PRAGMA journal_mode=WAL;'`,
    `sqlite3 -readonly /root/echolink/data/echolink.db 'DELETE FROM memories;'`,
    `sqlite3 -readonly /root/echolink/data/echolink.db '.shell rm -f /tmp/hidden-write'`,
    `sqlite3 -init /tmp/startup.sql /root/echolink/data/echolink.db 'SELECT 1;'`,
    `sqlite3 -cmd 'DELETE FROM memories;' /root/echolink/data/echolink.db 'SELECT 1;'`,
    `date --set tomorrow`,
    `hostname changed-host`,
    `curl --data 'x=1' http://127.0.0.1:3000/`,
    `curl -sSd 'x=1' http://127.0.0.1:3000/`,
    `curl --data-raw 'x=1' http://127.0.0.1:3000/`,
    `curl --output /tmp/response http://127.0.0.1:3000/`,
    `curl --write-out '%output{/tmp/response}%{http_code}' http://127.0.0.1:3000/`,
    `curl https://example.com/`,
    `python3 - /tmp/file <<'PY'
from pathlib import Path
Path('/tmp/file').unlink()
PY`,
    `python3 - /tmp/file <<'PY'
import subprocess
subprocess.run(['touch', '/tmp/file'])
PY`,
    `python3 - /tmp/file <<'PY'
import pathlib
p = pathlib.Path('/tmp/file')
operation = p.unlink
operation()
PY`,
    `python3 - /tmp/file <<'PY'
import sys
sys.modules['os'].remove('/tmp/file')
PY`
  ]

  for (const command of commands) {
    assert.equal(
      isReadOnlyTerminalCommand(command),
      false,
      command
    )
  }
})

test('unklare Shell-Konstrukte gelten nicht fälschlich als read-only', () => {
  const commands = [
    `bash -lc "df -h"`,
    `printf '%s' \`rm -f /tmp/hidden-write\``,
    `cat <(rm -f /tmp/hidden-write)`,
    `unknown-inspector --read-only`,
    `df -h &`
  ]

  for (const command of commands) {
    const result = classifyTerminalCommand(command)
    assert.equal(result.readOnly, false, command)
    assert.ok(result.reason)
  }
})

test('explizite Präfix-Allowlist bleibt möglich, destruktive Präfixe aber nicht', () => {
  assert.equal(
    isReadOnlyTerminalCommand('custom-audit --inventory', {
      allowedPrefixes: ['custom-audit']
    }),
    true
  )
  assert.equal(
    isReadOnlyTerminalCommand('rm -f /tmp/file', {
      allowedPrefixes: ['rm']
    }),
    false
  )
})

test('klare Lösch- und Destruktivbefehle werden unabhängig vom Read-only-Parser blockiert', () => {
  const commands = [
    'rm -rf /root/echolink',
    `bash -lc 'printf ok; rm -f /tmp/file'`,
    'command sudo rm -rf /root/echolink',
    'sudo -u root rm -rf /root/echolink',
    'find /root/echolink -type f -delete',
    'find /tmp -type f -exec rm -f {} +',
    `printf '%s\n' /tmp/example | xargs rm -f`,
    'git clean -fdx',
    'git reset --hard HEAD~1',
    'git push --force origin main',
    'git push --force-with-lease origin main',
    'git push origin :main',
    'git branch -D work',
    'git update-ref -d refs/heads/work',
    'docker system prune -af',
    'docker image rm image-id',
    'docker compose down -v',
    `sqlite3 data/echolink.db 'DELETE FROM messages;'`,
    `sqlite3 data/echolink.db 'DROP TABLE messages;'`,
    'npm uninstall better-sqlite3',
    'apt-get purge sqlite3',
    `python3 -c "from pathlib import Path; Path('/tmp/x').unlink()"`,
    `node -e "require('fs').rmSync('/tmp/x')"`
  ]

  for (const command of commands) {
    const result = classifyDestructiveTerminalCommand(command)
    assert.equal(result.destructive, true, command)
    assert.ok(result.reason, command)
  }
})

test('Agentenarbeit ohne Löschen bleibt automatisch ausführbar', () => {
  const commands = [
    `bash -lc "df -h"`,
    'unknown-inspector --read-only',
    `sed -i 's/old/new/' server/example.js`,
    'git add server/example.js',
    'git commit -m "fix: example"',
    'git push origin main',
    'npm test',
    'npm run build',
    'npm run deploy',
    'pm2 restart echolink --update-env',
    'docker build -t echolink:test .',
    `sqlite3 data/echolink.db 'UPDATE settings SET value = 1;'`
  ]

  for (const command of commands) {
    assert.equal(
      isDestructiveTerminalCommand(command),
      false,
      command
    )
  }
})

test('Chat führt normale Terminalarbeit automatisch aus und fragt nur bei Destruktion', () => {
  const source = readFileSync(
    new URL('../server/routes/chat.js', import.meta.url),
    'utf8'
  )

  assert.match(
    source,
    /requiresApproval:\s*commandPolicy\.destructive/
  )
  assert.match(
    source,
    /operation\.status === 'awaiting_approval'/
  )
  assert.match(
    source,
    /Destruktiver Befehl angehalten:/
  )
  assert.doesNotMatch(
    source,
    /Blocked destructive terminal command/
  )
  assert.doesNotMatch(
    source,
    /requiresApproval:\s*!commandPolicy\.readOnly/
  )
})
