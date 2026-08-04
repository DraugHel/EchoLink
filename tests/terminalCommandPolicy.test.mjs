import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyTerminalCommand,
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

test('versteckte Schreiboperationen bleiben freigabepflichtig', () => {
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
    `date --set tomorrow`,
    `hostname changed-host`
  ]

  for (const command of commands) {
    assert.equal(
      isReadOnlyTerminalCommand(command),
      false,
      command
    )
  }
})

test('unklare Shell-Konstrukte fallen sicher auf Approval zurück', () => {
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
