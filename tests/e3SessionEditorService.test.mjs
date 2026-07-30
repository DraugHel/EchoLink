import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  E3_LEASE_RESOURCE_TYPE,
  E3_SESSION_COMMAND
} from '../server/e3/core/contracts.js'
import { openEditorDatabase } from '../server/e3/persistence/database.js'
import { EditorRepository } from '../server/e3/persistence/editorRepository.js'
import { E3_PERSISTENCE_ERROR } from '../server/e3/persistence/errors.js'
import { E3_EDITOR_OPERATION } from '../server/e3/editor/contracts.js'
import { SessionEditorService } from '../server/e3/editor/sessionEditorService.js'
import { sha256 } from '../server/e3/editor/safeTextFilesystem.js'

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
const INTENT_ID = '223e4567-e89b-42d3-a456-426614174000'
const OPERATION_ID = '323e4567-e89b-42d3-a456-426614174000'
const SESSION_OWNER = 'control-plane-1'
const WORKSPACE_OWNER = 'workspace-manager-1'

function setup(t, serviceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-service-'))
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'src', 'a.txt'), 'alpha\n')
  const database = openEditorDatabase({
    databasePath: path.join(root, 'editor.db')
  })
  const repository = new EditorRepository(database)
  let session = repository.createSession({
    id: SESSION_ID,
    baseCommit: 'a'.repeat(40),
    createdBy: 'user-1',
    requestSummary: 'Mutation service',
    createdAt: 1_000,
    leaseOwner: SESSION_OWNER,
    leaseExpiresAt: 100_000
  }).session
  session = repository.transitionSession({
    type: E3_SESSION_COMMAND.START_PROVISIONING,
    sessionId: SESSION_ID,
    expectedVersion: session.version,
    actorId: 'user-1',
    requestId: 'start-provisioning',
    occurredAt: 1_100,
    leaseOwner: SESSION_OWNER,
    fencingToken: 1
  }).session
  repository.claimLease({
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
    ) VALUES (?, ?, 'READY', ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 0)
  `).run(
    SESSION_ID,
    'edit-123e4567',
    'a'.repeat(40),
    'b'.repeat(40),
    workspace,
    'c'.repeat(64),
    WORKSPACE_OWNER,
    1_200,
    1_200,
    6
  )
  session = repository.transitionSession({
    type: E3_SESSION_COMMAND.FINISH_PROVISIONING,
    sessionId: SESSION_ID,
    expectedVersion: session.version,
    actorId: 'user-1',
    requestId: 'finish-provisioning',
    occurredAt: 1_300,
    leaseOwner: SESSION_OWNER,
    fencingToken: 1
  }).session
  const service = new SessionEditorService(database, {
    artifactRoot: path.join(root, 'artifacts'),
    forbiddenRoots: ['/root/echolink'],
    ...serviceOptions
  })
  t.after(() => {
    if (database.open) database.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, workspace, database, repository, session, service }
}

function input(harness, overrides = {}) {
  const content = fs.readFileSync(
    path.join(harness.workspace, 'src', 'a.txt')
  )
  return {
    sessionId: SESSION_ID,
    requestId: 'editor-request-0001',
    actorId: 'user-1',
    expectedVersion: harness.session.version,
    occurredAt: 2_000,
    sessionOwner: SESSION_OWNER,
    sessionFencingToken: 1,
    workspaceOwner: WORKSPACE_OWNER,
    workspaceFencingToken: 1,
    intentId: INTENT_ID,
    operationId: OPERATION_ID,
    request: {
      version: 1,
      type: E3_EDITOR_OPERATION.REPLACE_EXACT,
      path: 'src/a.txt',
      expectedSha256: sha256(content),
      search: 'alpha',
      replacement: 'omega'
    },
    ...overrides
  }
}

test('session mutation prepares, publishes and records atomically', t => {
  const h = setup(t)
  const mutation = input(h)
  const result = h.service.mutate(mutation)
  assert.equal(result.session.version, h.session.version + 1)
  assert.equal(
    fs.readFileSync(path.join(h.workspace, 'src', 'a.txt'), 'utf8'),
    'omega\n'
  )
  const intent = h.service.intents.get(INTENT_ID)
  assert.equal(intent.state, 'RECORDED')
  assert.equal(h.database.prepare(
    'SELECT COUNT(*) AS count FROM editor_operations'
  ).get().count, 1)
  assert.equal(h.service.mutate(mutation).replayed, true)
})

test('request ID collision never publishes a second filesystem write', t => {
  const h = setup(t)
  h.service.mutate(input(h))
  assert.throws(() => h.service.mutate(input(h, {
    request: {
      ...input(h).request,
      replacement: 'different'
    }
  })), error => error?.code === E3_PERSISTENCE_ERROR.INVALID_RECORD)
  assert.equal(
    fs.readFileSync(path.join(h.workspace, 'src', 'a.txt'), 'utf8'),
    'omega\n'
  )
})

test('crash after filesystem publication requires explicit recovery', t => {
  const h = setup(t, {
    faultInjector(point) {
      if (point === 'after_filesystem_publish') throw new Error('crash')
    }
  })
  const mutation = input(h)
  assert.throws(() => h.service.mutate(mutation), /crash/)
  assert.equal(h.service.intents.get(INTENT_ID).state, 'PREPARED')
  assert.throws(
    () => h.service.mutate(mutation),
    /explicit recovery/
  )
  const recovery = new SessionEditorService(h.database, {
    artifactRoot: path.join(h.root, 'artifacts'),
    forbiddenRoots: ['/root/echolink']
  })
  const result = recovery.recoverMutation({
    intentId: INTENT_ID,
    request: mutation.request,
    occurredAt: 2_100
  })
  assert.equal(result.session.version, h.session.version + 1)
  assert.equal(recovery.intents.get(INTENT_ID).state, 'RECORDED')
  assert.equal(
    fs.readFileSync(path.join(h.workspace, 'src', 'a.txt'), 'utf8'),
    'omega\n'
  )
})

test('stale workspace fencing token blocks before publication', t => {
  const h = setup(t)
  h.repository.claimLease({
    resourceType: E3_LEASE_RESOURCE_TYPE.WORKSPACE,
    resourceKey: SESSION_ID,
    owner: WORKSPACE_OWNER,
    occurredAt: 1_500,
    expiresAt: 100_000,
    expectedFencingToken: 1
  })
  assert.throws(
    () => h.service.mutate(input(h)),
    error => error?.code === E3_PERSISTENCE_ERROR.LEASE_CONFLICT
  )
  assert.equal(
    fs.readFileSync(path.join(h.workspace, 'src', 'a.txt'), 'utf8'),
    'alpha\n'
  )
})

test('replacement retains a verified content-addressed preimage', t => {
  const h = setup(t)
  h.service.mutate(input(h))
  const preimage = h.database.prepare(`
    SELECT sha256, storage_key, size_bytes
    FROM editor_operation_preimages
  `).get()
  assert.equal(preimage.sha256, sha256(Buffer.from('alpha\n')))
  assert.equal(preimage.size_bytes, 6)
  assert.deepEqual(
    h.service.preimages.read(preimage.sha256),
    Buffer.from('alpha\n')
  )
  assert.equal(
    preimage.storage_key,
    `preimages/sha256/${preimage.sha256.slice(0, 2)}/${preimage.sha256}`
  )
})
