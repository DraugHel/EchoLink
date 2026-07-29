import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  E3DomainError,
  E3_FAILURE_CODE,
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_COMMAND
} from '../server/e3/core/contracts.js'
import {
  openEditorDatabase
} from '../server/e3/persistence/database.js'
import {
  EditorRepository
} from '../server/e3/persistence/editorRepository.js'
import {
  E3_WORKSPACE_STATES,
  E3_WORKSPACE_STATE,
  workspaceFeatureEnabled
} from '../server/e3/workspaces/contracts.js'
import {
  WORKSPACE_SCHEMA_CONTRACTS
} from '../server/e3/persistence/migrations/002-workspaces.js'
import {
  E3_WORKSPACE_ERROR,
  E3WorkspaceError
} from '../server/e3/workspaces/errors.js'
import {
  workspacePaths
} from '../server/e3/workspaces/paths.js'
import {
  WorkspaceManager
} from '../server/e3/workspaces/workspaceManager.js'

const GIT = '/usr/bin/git'
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER_SESSION_ID =
  '123e4567-e89b-42d3-a456-426614174001'
const MANAGER_OWNER = 'workspace-manager-1'
const SESSION_LEASE_OWNER = 'control-plane-1'

function expectWorkspaceCode(code) {
  return error => (
    error instanceof E3WorkspaceError &&
    error.code === code
  )
}

function git(repositoryPath, args, {
  allowedExitCodes = [0]
} = {}) {
  try {
    return execFileSync(GIT, args, {
      cwd: repositoryPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: repositoryPath,
        LC_ALL: 'C',
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1'
      }
    }).trim()
  } catch (error) {
    if (allowedExitCodes.includes(error.status)) {
      return String(error.stdout ?? '').trim()
    }
    throw error
  }
}

function createSourceRepository(rootPath) {
  const repositoryPath = join(rootPath, 'production-source')
  mkdirSync(repositoryPath)
  git(repositoryPath, ['init', '--initial-branch=main'])
  git(repositoryPath, ['config', 'user.name', 'E3 Test'])
  git(repositoryPath, [
    'config',
    'user.email',
    'e3-test@example.invalid'
  ])
  mkdirSync(join(repositoryPath, 'server'))
  writeFileSync(
    join(repositoryPath, 'server', 'example.js'),
    'export const answer = 42\n'
  )
  writeFileSync(
    join(repositoryPath, 'README.md'),
    '# Synthetic production source\n'
  )
  symlinkSync(
    '/definitely-not-read-by-e3',
    join(repositoryPath, 'source-symlink')
  )
  git(repositoryPath, ['add', '--all'])
  git(repositoryPath, ['commit', '-m', 'synthetic baseline'])
  return {
    repositoryPath,
    baseCommit: git(repositoryPath, ['rev-parse', 'HEAD'])
  }
}

function fileTreeFingerprint(repositoryPath) {
  const hash = createHash('sha256')
  const tracked = git(repositoryPath, [
    'ls-files',
    '-z'
  ]).split('\0').filter(Boolean)

  for (const relativePath of tracked.sort()) {
    const path = join(repositoryPath, relativePath)
    const metadata = lstatSync(path)
    hash.update(relativePath)
    hash.update('\0')
    if (metadata.isSymbolicLink()) {
      hash.update('symlink\0')
      hash.update(readlinkSync(path))
    } else {
      hash.update('file\0')
      hash.update(readFileSync(path))
    }
    hash.update('\0')
  }

  hash.update(git(repositoryPath, ['rev-parse', 'HEAD']))
  hash.update(git(repositoryPath, [
    'status',
    '--porcelain',
    '--untracked-files=all'
  ]))
  hash.update(readFileSync(
    join(repositoryPath, '.git', 'config')
  ))
  return hash.digest('hex')
}

function createHarness(t, {
  sessionId = SESSION_ID,
  baseCommitOverride,
  enabled = true
} = {}) {
  const rootPath = mkdtempSync(
    join(tmpdir(), 'echolink-e3-workspace-')
  )
  const source = createSourceRepository(rootPath)
  const database = openEditorDatabase({
    databasePath: join(rootPath, 'editor.db')
  })
  const sessions = new EditorRepository(database)
  let session = sessions.createSession({
    id: sessionId,
    baseCommit: baseCommitOverride ?? source.baseCommit,
    createdBy: 'user-1',
    requestSummary: 'Read-only workspace test',
    createdAt: 1_000,
    leaseOwner: SESSION_LEASE_OWNER,
    leaseExpiresAt: 100_000
  }).session
  session = sessions.transitionSession({
    type: E3_SESSION_COMMAND.START_PROVISIONING,
    sessionId,
    expectedVersion: session.version,
    actorId: 'user-1',
    requestId: `start-provisioning-${sessionId}`,
    occurredAt: 1_100,
    leaseOwner: SESSION_LEASE_OWNER,
    fencingToken: 1
  }).session
  const workspaceLease = sessions.claimLease({
    resourceType: E3_LEASE_RESOURCE_TYPE.WORKSPACE,
    resourceKey: sessionId,
    owner: MANAGER_OWNER,
    occurredAt: 1_200,
    expiresAt: 100_000
  })
  const storageRoot = join(rootPath, 'editor-storage')
  const manager = new WorkspaceManager({
    database,
    storageRoot,
    sourceRepositoryPath: source.repositoryPath,
    managerOwner: MANAGER_OWNER,
    enabled,
    forbiddenRoots: [
      join(rootPath, 'forbidden-production')
    ]
  })

  t.after(() => {
    if (database.open) database.close()
    rmSync(rootPath, { recursive: true, force: true })
  })

  return {
    rootPath,
    source,
    database,
    sessions,
    session,
    workspaceLease,
    storageRoot,
    manager
  }
}

function sessionCommand(session, type, overrides = {}) {
  return {
    type,
    sessionId: session.id,
    expectedVersion: session.version,
    actorId: 'user-1',
    requestId: `${type}-${session.version}-${session.id}`,
    occurredAt: 10_000 + session.version,
    leaseOwner: SESSION_LEASE_OWNER,
    fencingToken: 1,
    ...overrides
  }
}

test('Workspace-Feature-Flag ist standardmäßig aus', t => {
  assert.deepEqual(
    WORKSPACE_SCHEMA_CONTRACTS.workspaceStates,
    E3_WORKSPACE_STATES
  )
  assert.equal(workspaceFeatureEnabled({}), false)
  assert.equal(workspaceFeatureEnabled({
    E3_WORKSPACE_ENABLED: 'false'
  }), false)
  assert.equal(workspaceFeatureEnabled({
    E3_WORKSPACE_ENABLED: 'true'
  }), true)

  const harness = createHarness(t, { enabled: false })
  assert.throws(
    () => harness.manager.prepareStorage(),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.FEATURE_DISABLED)
  )
  assert.equal(existsSync(harness.storageRoot), false)
})

test('Manager erzeugt credentialfreien Mirror und detached Worktree', t => {
  const harness = createHarness(t)
  const sourceBefore = fileTreeFingerprint(
    harness.source.repositoryPath
  )
  const provisioned = harness.manager.provisionWorkspace({
    sessionId: SESSION_ID,
    leaseOwner: MANAGER_OWNER,
    fencingToken: 1,
    createdAt: 2_000
  })
  const treePath = provisioned.record.canonicalPath

  assert.equal(provisioned.record.state, E3_WORKSPACE_STATE.READY)
  assert.equal(provisioned.record.baseCommit, harness.source.baseCommit)
  assert.equal(provisioned.record.treeSha.length, 40)
  assert.equal(provisioned.manifest.workerOwner, null)
  assert.equal(provisioned.manifest.associatedProcesses.length, 0)
  assert.equal(provisioned.manifest.portLeases.length, 0)
  assert.equal(provisioned.record.symlinkCount, 1)
  assert.equal(
    readlinkSync(join(treePath, 'source-symlink')),
    '/definitely-not-read-by-e3'
  )
  assert.equal(git(treePath, ['rev-parse', 'HEAD']),
    harness.source.baseCommit)
  assert.equal(
    git(treePath, ['symbolic-ref', '-q', 'HEAD'], {
      allowedExitCodes: [1]
    }),
    ''
  )
  assert.equal(
    git(harness.manager.prepareStorage().mirrorPath, [
      'remote'
    ]),
    ''
  )
  assert.equal(
    lstatSync(join(treePath, '.git')).mode & 0o777,
    0o440
  )
  assert.equal(
    fileTreeFingerprint(harness.source.repositoryPath),
    sourceBefore
  )

  const inspected = harness.manager.inspectWorkspace({
    sessionId: SESSION_ID,
    inspectedAt: 5_000
  })
  assert.equal(inspected.ageMs, 3_000)
  assert.equal(
    inspected.logicalSizeBytes,
    provisioned.record.logicalSizeBytes
  )
  assert.equal(
    inspected.entryCount,
    provisioned.record.entryCount
  )
})

test('Falscher Commit wird ohne Workspace abgewiesen', t => {
  const harness = createHarness(t, {
    baseCommitOverride: 'f'.repeat(40)
  })

  assert.throws(
    () => harness.manager.provisionWorkspace({
      sessionId: SESSION_ID,
      leaseOwner: MANAGER_OWNER,
      fencingToken: 1,
      createdAt: 2_000
    }),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.COMMIT_NOT_FOUND)
  )
  const layout = harness.manager.prepareStorage()
  const paths = workspacePaths(layout, SESSION_ID)
  assert.equal(existsSync(paths.workspaceRoot), false)
  assert.equal(
    harness.database.prepare(`
      SELECT COUNT(*) AS count
      FROM editor_workspaces
    `).get().count,
    0
  )
})

test('Manipulierte Session-ID und Traversal erreichen keinen Hostpfad', t => {
  const harness = createHarness(t)
  assert.throws(
    () => harness.manager.provisionWorkspace({
      sessionId: '../outside',
      leaseOwner: MANAGER_OWNER,
      fencingToken: 1,
      createdAt: 2_000
    }),
    error => (
      error instanceof E3DomainError &&
      error.code === E3_FAILURE_CODE.INVALID_SESSION_ID
    )
  )
  assert.equal(existsSync(harness.storageRoot), false)
})

test('Bestehender Workspace-Lock blockiert parallele Erzeugung', t => {
  const harness = createHarness(t)
  const layout = harness.manager.prepareStorage()
  const paths = workspacePaths(layout, SESSION_ID)
  const descriptor = openSync(
    paths.workspaceLockPath,
    'wx',
    0o600
  )
  writeFileSync(descriptor, '{"owner":"other-manager"}\n')
  closeSync(descriptor)

  assert.throws(
    () => harness.manager.provisionWorkspace({
      sessionId: SESSION_ID,
      leaseOwner: MANAGER_OWNER,
      fencingToken: 1,
      createdAt: 2_000
    }),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.LOCKED)
  )
  assert.equal(existsSync(paths.workspaceRoot), false)
  unlinkSync(paths.workspaceLockPath)
})

test('Manipulierter Mirror wird vor dem Worktree abgewiesen', t => {
  const harness = createHarness(t)
  const layout = harness.manager.prepareStorage()
  git(layout.runtimePath, [
    'init',
    '--bare',
    '--initial-branch=main',
    layout.mirrorPath
  ])
  const maliciousHook = join(
    layout.mirrorPath,
    'hooks',
    'post-checkout'
  )
  writeFileSync(
    maliciousHook,
    '#!/bin/sh\nexit 99\n'
  )
  chmodSync(maliciousHook, 0o700)

  assert.throws(
    () => harness.manager.provisionWorkspace({
      sessionId: SESSION_ID,
      leaseOwner: MANAGER_OWNER,
      fencingToken: 1,
      createdAt: 2_000
    }),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.MIRROR_UNSAFE)
  )
  const paths = workspacePaths(layout, SESSION_ID)
  assert.equal(existsSync(paths.workspaceRoot), false)
  assert.equal(
    harness.database.prepare(`
      SELECT COUNT(*) AS count
      FROM editor_workspaces
    `).get().count,
    0
  )
})

test('Symlink am kanonischen Workspace-Pfad wird nie verfolgt', t => {
  const harness = createHarness(t)
  const layout = harness.manager.prepareStorage()
  const paths = workspacePaths(layout, SESSION_ID)
  const outside = join(harness.rootPath, 'outside-canary')
  mkdirSync(outside)
  writeFileSync(join(outside, 'canary'), 'untouched\n')
  symlinkSync(outside, paths.workspaceRoot)

  assert.throws(
    () => harness.manager.provisionWorkspace({
      sessionId: SESSION_ID,
      leaseOwner: MANAGER_OWNER,
      fencingToken: 1,
      createdAt: 2_000
    }),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.WORKSPACE_EXISTS)
  )
  assert.equal(
    readFileSync(join(outside, 'canary'), 'utf8'),
    'untouched\n'
  )
  unlinkSync(paths.workspaceRoot)
})

test('Ausgetauschte Manager-Wurzel wird vor Nutzung abgewiesen', t => {
  const harness = createHarness(t)
  harness.manager.prepareStorage()
  const originalStorage = join(
    harness.rootPath,
    'editor-storage-original'
  )
  const outside = join(harness.rootPath, 'outside-manager-root')
  renameSync(harness.storageRoot, originalStorage)
  mkdirSync(outside)
  writeFileSync(join(outside, 'canary'), 'untouched\n')
  symlinkSync(outside, harness.storageRoot)

  assert.throws(
    () => harness.manager.provisionWorkspace({
      sessionId: SESSION_ID,
      leaseOwner: MANAGER_OWNER,
      fencingToken: 1,
      createdAt: 2_000
    }),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.PATH_TAMPERED)
  )
  assert.equal(
    readFileSync(join(outside, 'canary'), 'utf8'),
    'untouched\n'
  )
})

test('Manifest- oder Inhaltsänderung wird read-only erkannt', t => {
  const harness = createHarness(t)
  const provisioned = harness.manager.provisionWorkspace({
    sessionId: SESSION_ID,
    leaseOwner: MANAGER_OWNER,
    fencingToken: 1,
    createdAt: 2_000
  })
  const layout = harness.manager.prepareStorage()
  const paths = workspacePaths(layout, SESSION_ID)
  const originalManifest = readFileSync(paths.manifestPath)

  writeFileSync(paths.manifestPath, '{"tampered":true}\n')
  assert.throws(
    () => harness.manager.inspectWorkspace({
      sessionId: SESSION_ID,
      inspectedAt: 3_000
    }),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.MANIFEST_MISMATCH)
  )
  writeFileSync(paths.manifestPath, originalManifest)
  chmodSync(paths.manifestPath, 0o600)

  writeFileSync(
    join(provisioned.record.canonicalPath, 'unexpected.txt'),
    'mutation\n'
  )
  assert.throws(
    () => harness.manager.inspectWorkspace({
      sessionId: SESSION_ID,
      inspectedAt: 3_100
    }),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.MANIFEST_MISMATCH)
  )
  unlinkSync(
    join(provisioned.record.canonicalPath, 'unexpected.txt')
  )
})

test('Cleanup ist statusgebunden, symlinksicher und idempotent', t => {
  const harness = createHarness(t)
  const provisioned = harness.manager.provisionWorkspace({
    sessionId: SESSION_ID,
    leaseOwner: MANAGER_OWNER,
    fencingToken: 1,
    createdAt: 2_000
  })
  let session = harness.sessions.transitionSession(
    sessionCommand(
      harness.session,
      E3_SESSION_COMMAND.FINISH_PROVISIONING
    )
  ).session

  assert.throws(
    () => harness.manager.removeWorkspace({
      sessionId: SESSION_ID,
      leaseOwner: MANAGER_OWNER,
      fencingToken: 1,
      removedAt: 3_000
    }),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.CLEANUP_BLOCKED)
  )
  session = harness.sessions.transitionSession(
    sessionCommand(session, E3_SESSION_COMMAND.CANCEL)
  ).session

  const layout = harness.manager.prepareStorage()
  const paths = workspacePaths(layout, SESSION_ID)
  const movedWorkspace = join(
    harness.rootPath,
    'temporarily-moved-workspace'
  )
  const outside = join(harness.rootPath, 'outside-cleanup')
  mkdirSync(outside)
  writeFileSync(join(outside, 'canary'), 'untouched\n')
  renameSync(paths.workspaceRoot, movedWorkspace)
  symlinkSync(outside, paths.workspaceRoot)

  assert.throws(
    () => harness.manager.removeWorkspace({
      sessionId: SESSION_ID,
      leaseOwner: MANAGER_OWNER,
      fencingToken: 1,
      removedAt: 3_100
    }),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.PATH_TAMPERED)
  )
  assert.equal(
    readFileSync(join(outside, 'canary'), 'utf8'),
    'untouched\n'
  )

  unlinkSync(paths.workspaceRoot)
  renameSync(movedWorkspace, paths.workspaceRoot)
  const removed = harness.manager.removeWorkspace({
    sessionId: SESSION_ID,
    leaseOwner: MANAGER_OWNER,
    fencingToken: 1,
    removedAt: 3_200
  })
  assert.equal(removed.removed, true)
  assert.equal(existsSync(paths.workspaceRoot), false)
  assert.equal(
    removed.record.state,
    E3_WORKSPACE_STATE.REMOVED
  )
  assert.equal(removed.record.logicalSizeBytes, 0)

  const repeated = harness.manager.removeWorkspace({
    sessionId: SESSION_ID,
    leaseOwner: MANAGER_OWNER,
    fencingToken: 1,
    removedAt: 3_300
  })
  assert.equal(repeated.removed, false)
  assert.equal(repeated.alreadyAbsent, true)
  assert.equal(existsSync(provisioned.record.canonicalPath), false)
})

test('Veraltetes Workspace-Fencing kann weder lesen noch entfernen', t => {
  const harness = createHarness(t)
  harness.manager.provisionWorkspace({
    sessionId: SESSION_ID,
    leaseOwner: MANAGER_OWNER,
    fencingToken: 1,
    createdAt: 2_000
  })
  harness.sessions.claimLease({
    resourceType: E3_LEASE_RESOURCE_TYPE.WORKSPACE,
    resourceKey: SESSION_ID,
    owner: MANAGER_OWNER,
    occurredAt: 3_000,
    expiresAt: 100_000,
    expectedFencingToken: 1
  })

  assert.throws(
    () => harness.manager.inspectWorkspace({
      sessionId: SESSION_ID,
      inspectedAt: 3_100
    }),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.LEASE_MISMATCH)
  )
  assert.throws(
    () => harness.manager.removeWorkspace({
      sessionId: SESSION_ID,
      leaseOwner: MANAGER_OWNER,
      fencingToken: 1,
      removedAt: 3_200
    }),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.LEASE_MISMATCH)
  )
})

test('Workspace-Schritt exponiert keine Editor- oder Prozess-API', () => {
  const managerSource = readFileSync(
    new URL(
      '../server/e3/workspaces/workspaceManager.js',
      import.meta.url
    ),
    'utf8'
  )
  const gitSource = readFileSync(
    new URL(
      '../server/e3/workspaces/workspaceGit.js',
      import.meta.url
    ),
    'utf8'
  )

  assert.doesNotMatch(
    managerSource,
    /readFile|writeFile|replaceExact|insertBefore|spawn|exec/
  )
  assert.match(gitSource, /const GIT_BINARY = '\/usr\/bin\/git'/)
  assert.match(gitSource, /shell: false/)
  assert.doesNotMatch(gitSource, /shell: true|execSync|exec\(/)
})

test('Andere Session kann keinen bestehenden Pfad wiederverwenden', t => {
  const harness = createHarness(t)
  harness.manager.provisionWorkspace({
    sessionId: SESSION_ID,
    leaseOwner: MANAGER_OWNER,
    fencingToken: 1,
    createdAt: 2_000
  })

  assert.throws(
    () => harness.manager.provisionWorkspace({
      sessionId: OTHER_SESSION_ID,
      leaseOwner: MANAGER_OWNER,
      fencingToken: 1,
      createdAt: 2_100
    }),
    expectWorkspaceCode(E3_WORKSPACE_ERROR.LEASE_MISMATCH)
  )
})
