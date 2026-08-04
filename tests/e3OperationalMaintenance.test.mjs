import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  cleanupTerminalWorkspaceStorage,
  E3WorkspaceStorageCleanupError
} from '../server/e3/chat/workspaceStorageCleanup.js'

function removedDatabase() {
  return {
    prepare(sql) {
      assert.match(sql, /FROM editor_workspaces/)
      return {
        get() {
          return { state: 'REMOVED' }
        }
      }
    }
  }
}

function createWorkspaceStorage(t) {
  const outer = fs.mkdtempSync(
    path.join(os.tmpdir(), 'e3-chat-storage-cleanup-')
  )
  const sessionId =
    '123e4567-e89b-42d3-a456-426614174000'
  const sessionRoot = path.join(outer, sessionId)
  const storageRoot = path.join(
    sessionRoot,
    'workspace-storage'
  )

  fs.mkdirSync(sessionRoot, { mode: 0o700 })
  fs.mkdirSync(storageRoot, { mode: 0o750 })

  for (const name of [
    'artifacts',
    'locks',
    'quarantine',
    'runtime',
    'workspaces'
  ]) {
    fs.mkdirSync(path.join(storageRoot, name), {
      mode: 0o750
    })
  }

  const mirror = path.join(storageRoot, 'repo.git')
  fs.mkdirSync(mirror, { mode: 0o750 })
  fs.mkdirSync(path.join(mirror, 'objects'), {
    mode: 0o750
  })
  fs.mkdirSync(path.join(mirror, 'refs'), {
    mode: 0o750
  })
  fs.writeFileSync(
    path.join(mirror, 'HEAD'),
    'ref: refs/heads/main\n'
  )
  fs.writeFileSync(
    path.join(mirror, 'config'),
    '[core]\n\tbare = true\n'
  )

  t.after(() => {
    fs.rmSync(outer, {
      recursive: true,
      force: true
    })
  })

  return {
    sessionId,
    sessionRoot,
    storageRoot
  }
}

test('terminal chat cleanup removes only the verified session-local workspace store', t => {
  const fixture = createWorkspaceStorage(t)

  const preview = cleanupTerminalWorkspaceStorage({
    database: removedDatabase(),
    ...fixture,
    workspaceStorageRoot: fixture.storageRoot,
    dryRun: true
  })

  assert.equal(preview.wouldRemove, true)
  assert.equal(preview.removed, false)
  assert.equal(fs.existsSync(fixture.storageRoot), true)

  const removed = cleanupTerminalWorkspaceStorage({
    database: removedDatabase(),
    sessionId: fixture.sessionId,
    sessionRoot: fixture.sessionRoot,
    workspaceStorageRoot: fixture.storageRoot
  })

  assert.equal(removed.removed, true)
  assert.equal(removed.alreadyAbsent, false)
  assert.equal(removed.logicalBytes > 0, true)
  assert.equal(fs.existsSync(fixture.storageRoot), false)

  const replayed = cleanupTerminalWorkspaceStorage({
    database: removedDatabase(),
    sessionId: fixture.sessionId,
    sessionRoot: fixture.sessionRoot,
    workspaceStorageRoot: fixture.storageRoot
  })

  assert.equal(replayed.alreadyAbsent, true)
})

test('terminal chat cleanup rejects unknown layout entries without deleting evidence', t => {
  const fixture = createWorkspaceStorage(t)
  fs.writeFileSync(
    path.join(fixture.storageRoot, 'unexpected.txt'),
    'retain\n'
  )

  assert.throws(
    () => cleanupTerminalWorkspaceStorage({
      database: removedDatabase(),
      sessionId: fixture.sessionId,
      sessionRoot: fixture.sessionRoot,
      workspaceStorageRoot: fixture.storageRoot
    }),
    error => (
      error instanceof E3WorkspaceStorageCleanupError &&
      /unknown entries/.test(error.message)
    )
  )

  assert.equal(fs.existsSync(fixture.storageRoot), true)
})

test('E3 maintenance scripts are repository-owned, dynamic and syntax-valid', () => {
  const root = path.resolve(
    new URL('..', import.meta.url).pathname
  )
  const packageJson = JSON.parse(
    fs.readFileSync(
      path.join(root, 'package.json'),
      'utf8'
    )
  )

  assert.equal(
    packageJson.scripts['e3:validation:rebind'],
    'bash scripts/e3-rebind-validation-images.sh'
  )
  assert.equal(
    packageJson.scripts['e3:cleanup:residue'],
    'bash scripts/e3-clean-runtime-residue.sh'
  )
  assert.equal(
    packageJson.scripts['e3:cleanup:chat-storage'],
    'node scripts/e3-clean-chat-workspace-storage.mjs'
  )

  const rebindPath = path.join(
    root,
    'scripts/e3-rebind-validation-images.sh'
  )
  const residuePath = path.join(
    root,
    'scripts/e3-clean-runtime-residue.sh'
  )
  const chatCleanupPath = path.join(
    root,
    'scripts/e3-clean-chat-workspace-storage.mjs'
  )

  execFileSync('/bin/bash', ['-n', rebindPath])
  execFileSync('/bin/bash', ['-n', residuePath])
  execFileSync(process.execPath, ['--check', chatCleanupPath])

  const rebind = fs.readFileSync(rebindPath, 'utf8')
  assert.equal(
    /readonly CURRENT_HEAD=[0-9a-f]{40}/.test(rebind),
    false
  )
  assert.match(
    rebind,
    /CURRENT_HEAD=\$head/
  )
  assert.match(
    rebind,
    /E3_VALIDATION_BINDING_CURRENT=1/
  )
  assert.match(
    rebind,
    /Same-tree HEAD-Wechsel; Image wird mit neuer HEAD-Bindung gebaut/
  )
  assert.match(
    rebind,
    /restore_replaced_image_tags/
  )
  assert.match(
    rebind,
    /restore_manifest_image_tags "\$backup"/
  )
  assert.match(
    rebind,
    /image inspect --format '\{\{\.Id\}\}' "\$OLD_NODE_DIGEST"/
  )
  assert.match(
    rebind,
    /image inspect --format '\{\{\.Id\}\}' "\$OLD_PLAYWRIGHT_DIGEST"/
  )

  const residue = fs.readFileSync(residuePath, 'utf8')
  for (const protectedPath of [
    '/var/lib/echolink-e3/chat',
    '/var/lib/echolink-e3/staging',
    '/var/lib/echolink-e3/backups',
    '/var/lib/echolink-e3/acceptance'
  ]) {
    assert.equal(
      residue.includes(protectedPath),
      false
    )
  }
})

test('deploy keeps enabled E3 validation bound before restarting production', () => {
  const root = path.resolve(
    new URL('..', import.meta.url).pathname
  )
  const deploy = fs.readFileSync(
    path.join(root, 'scripts/deploy.sh'),
    'utf8'
  )
  const rebindIndex = deploy.indexOf(
    'npm run e3:validation:rebind'
  )
  const restartIndex = deploy.indexOf(
    'echo "===== NEUSTART ====="'
  )

  assert.equal(rebindIndex >= 0, true)
  assert.equal(restartIndex >= 0, true)
  assert.equal(rebindIndex < restartIndex, true)
  assert.match(
    deploy,
    /E3_CHAT_TOOLS_ENABLED/
  )
})
