import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_COMMAND
} from '../server/e3/core/contracts.js'
import { ArtifactStore } from '../server/e3/artifacts/artifactStore.js'
import {
  CandidateArtifactService
} from '../server/e3/artifacts/candidateArtifactService.js'
import { openEditorDatabase } from '../server/e3/persistence/database.js'
import { EditorRepository } from '../server/e3/persistence/editorRepository.js'
import { SessionEditorService } from '../server/e3/editor/sessionEditorService.js'
import { E3_EDITOR_OPERATION } from '../server/e3/editor/contracts.js'
import { sha256 } from '../server/e3/editor/safeTextFilesystem.js'

const GIT = '/usr/bin/git'
const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const SESSION_OWNER = 'control-plane-1'
const WORKSPACE_OWNER = 'workspace-manager-1'

function git(cwd, args, options = {}) {
  return execFileSync(GIT, args, {
    cwd,
    encoding: options.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      LC_ALL: 'C',
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null'
    }
  })
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-artifacts-'))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  git(workspace, ['init', '--initial-branch=main'])
  git(workspace, ['config', 'user.name', 'E3 Test'])
  git(workspace, ['config', 'user.email', 'e3@example.invalid'])
  fs.mkdirSync(path.join(workspace, 'src'))
  fs.writeFileSync(path.join(workspace, 'src', 'a.txt'), 'alpha\n')
  fs.writeFileSync(path.join(workspace, 'README.md'), '# fixture\n')
  git(workspace, ['add', '--all'])
  git(workspace, ['commit', '-m', 'baseline'])
  const baseCommit = git(workspace, ['rev-parse', 'HEAD']).trim()
  const database = openEditorDatabase({
    databasePath: path.join(root, 'editor.db')
  })
  const sessions = new EditorRepository(database)
  let session = sessions.createSession({
    id: SESSION_ID,
    baseCommit,
    createdBy: 'user-1',
    requestSummary: 'Candidate artifacts',
    createdAt: 1_000,
    leaseOwner: SESSION_OWNER,
    leaseExpiresAt: 100_000
  }).session
  session = sessions.transitionSession({
    type: E3_SESSION_COMMAND.START_PROVISIONING,
    sessionId: SESSION_ID,
    expectedVersion: session.version,
    actorId: 'user-1',
    requestId: 'start-provisioning',
    occurredAt: 1_100,
    leaseOwner: SESSION_OWNER,
    fencingToken: 1
  }).session
  sessions.claimLease({
    resourceType: E3_LEASE_RESOURCE_TYPE.WORKSPACE,
    resourceKey: SESSION_ID,
    owner: WORKSPACE_OWNER,
    occurredAt: 1_200,
    expiresAt: 100_000
  })
  database.prepare(`
    INSERT INTO editor_workspaces (
      session_id, workspace_key, state, base_commit, tree_sha,
      canonical_path, manifest_sha256, manager_owner, created_at,
      heartbeat_at, fencing_token, logical_size_bytes, entry_count,
      symlink_count
    ) VALUES (?, ?, 'READY', ?, ?, ?, ?, ?, 1200, 1200, 1, 16, 2, 0)
  `).run(
    SESSION_ID,
    'edit-candidate',
    baseCommit,
    git(workspace, ['rev-parse', 'HEAD^{tree}']).trim(),
    workspace,
    'c'.repeat(64),
    WORKSPACE_OWNER
  )
  session = sessions.transitionSession({
    type: E3_SESSION_COMMAND.FINISH_PROVISIONING,
    sessionId: SESSION_ID,
    expectedVersion: session.version,
    actorId: 'user-1',
    requestId: 'finish-provisioning',
    occurredAt: 1_300,
    leaseOwner: SESSION_OWNER,
    fencingToken: 1
  }).session
  const editor = new SessionEditorService(database, {
    artifactRoot: path.join(root, 'preimages'),
    forbiddenRoots: ['/root/echolink']
  })
  session = editor.mutate({
    sessionId: SESSION_ID,
    requestId: 'mutation-request-1',
    actorId: 'user-1',
    expectedVersion: session.version,
    occurredAt: 2_000,
    sessionOwner: SESSION_OWNER,
    sessionFencingToken: 1,
    workspaceOwner: WORKSPACE_OWNER,
    workspaceFencingToken: 1,
    request: {
      version: 1,
      type: E3_EDITOR_OPERATION.REPLACE_EXACT,
      path: 'src/a.txt',
      expectedSha256: sha256(Buffer.from('alpha\n')),
      search: 'alpha',
      replacement: 'omega'
    }
  }).session
  t.after(() => {
    if (database.open) database.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    workspace,
    database,
    sessions,
    session,
    baseCommit,
    artifactRoot: path.join(root, 'candidate-artifacts')
  }
}

function createInput(h) {
  return {
    sessionId: SESSION_ID,
    expectedVersion: h.session.version,
    occurredAt: 3_000,
    sessionOwner: SESSION_OWNER,
    sessionFencingToken: 1,
    workspaceOwner: WORKSPACE_OWNER,
    workspaceFencingToken: 1
  }
}

test('artifact store deduplicates immutable bytes and detects tampering', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-object-store-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new ArtifactStore(root)
  const first = store.publish('same bytes\n')
  const second = store.publish(Buffer.from('same bytes\n'))
  assert.deepEqual(second, first)
  assert.equal(store.read(first.sha256).toString(), 'same bytes\n')
  const objectPath = path.join(root, first.storageKey)
  fs.writeFileSync(objectPath, 'tampered')
  assert.throws(() => store.read(first.sha256), /verification/)
})

test('candidate artifacts are deterministic, persisted and patch-reversible', t => {
  const h = setup(t)
  const service = new CandidateArtifactService(h.database, {
    artifactRoot: h.artifactRoot
  })
  const result = service.create(createInput(h))
  assert.equal(result.session_id, SESSION_ID)
  assert.equal(result.session_version, h.session.version)
  assert.equal(h.database.prepare(
    'SELECT COUNT(*) AS count FROM editor_artifacts'
  ).get().count, 5)
  const replay = service.create(createInput(h))
  assert.equal(replay.id, result.id)
  assert.equal(h.database.prepare(
    'SELECT COUNT(*) AS count FROM editor_artifacts'
  ).get().count, 5)

  const forward = service.store.read(result.forward_patch_sha256)
  const reverse = service.store.read(result.reverse_patch_sha256)
  const clean = path.join(h.root, 'clean')
  git(h.root, ['clone', '--quiet', h.workspace, clean])
  git(clean, ['reset', '--hard', h.baseCommit])
  const forwardFile = path.join(h.root, 'forward.patch')
  const reverseFile = path.join(h.root, 'reverse.patch')
  fs.writeFileSync(forwardFile, forward)
  fs.writeFileSync(reverseFile, reverse)
  git(clean, ['apply', '--check', forwardFile])
  git(clean, ['apply', forwardFile])
  assert.equal(
    fs.readFileSync(path.join(clean, 'src', 'a.txt'), 'utf8'),
    'omega\n'
  )
  git(clean, ['apply', '--check', reverseFile])
  git(clean, ['apply', reverseFile])
  assert.equal(
    fs.readFileSync(path.join(clean, 'src', 'a.txt'), 'utf8'),
    'alpha\n'
  )
})

test('artifact publication failure records no partial metadata', t => {
  const h = setup(t)
  const service = new CandidateArtifactService(h.database, {
    artifactRoot: h.artifactRoot,
    faultInjector(point) {
      if (point === 'after_artifact_publish') throw new Error('crash')
    }
  })
  assert.throws(() => service.create(createInput(h)), /crash/)
  assert.equal(h.database.prepare(
    'SELECT COUNT(*) AS count FROM editor_artifacts'
  ).get().count, 0)
  assert.equal(h.database.prepare(
    'SELECT COUNT(*) AS count FROM editor_candidate_artifact_sets'
  ).get().count, 0)
})

test('workspace change during freeze is detected before publication', t => {
  const h = setup(t)
  const service = new CandidateArtifactService(h.database, {
    artifactRoot: h.artifactRoot,
    faultInjector(point) {
      if (point === 'after_first_build') {
        fs.writeFileSync(
          path.join(h.workspace, 'src', 'a.txt'),
          'changed-during-freeze\n'
        )
      }
    }
  })
  assert.throws(
    () => service.create(createInput(h)),
    /changed while candidate was frozen/
  )
  assert.equal(h.database.prepare(
    'SELECT COUNT(*) AS count FROM editor_artifacts'
  ).get().count, 0)
})

test('active or stale ownership blocks candidate freeze', t => {
  const h = setup(t)
  h.database.prepare(`
    UPDATE editor_operation_intents
    SET state = 'RECOVERY_REQUIRED'
    WHERE session_id = ?
  `).run(SESSION_ID)
  const service = new CandidateArtifactService(h.database, {
    artifactRoot: h.artifactRoot
  })
  assert.throws(() => service.create(createInput(h)), /active operation intent/)
})
